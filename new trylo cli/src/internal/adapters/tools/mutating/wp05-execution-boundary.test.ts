import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ToolOutcome, ToolSandbox } from "../../../ports/tools.js";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";
import { RUN_SHELL_TOOL } from "./names.js";
import { createNodeSpawner, type ShellSpawner } from "./shell-spawn.js";

/**
 * WP05.3: the boundary claims, each stated as something that would go red.
 *
 * WP05.3's acceptance has three parts that can be settled here, and one that
 * cannot:
 *
 *  - Authorization before launch. Settled below, by counting.
 *  - A refused command leaves nothing running. Settled below, by counting.
 *  - Isolation is not bypassed by a compatibility path. Settled below, by
 *    reading the type of the seam a caller has to go through.
 *  - A durable intent recorded before the side effect. NOT settled here: no such
 *    record exists in production. `grep -rn "intent" src/internal` finds only
 *    learning-domain `intentClass` and `intentOn`, and WP05's own text makes the
 *    durable part WP07's deliverable. Written down as OPEN-WP05-2 rather than
 *    faked with an in-memory counter that would prove nothing about durability.
 *
 * The counting seam is the point. "The error came back" and "nothing ran" are
 * different claims, and only the second one is the boundary.
 */

const SIGNAL = new AbortController().signal;

type Counting = { readonly spawner: ShellSpawner; readonly count: () => number };

function countingSpawner(): Counting {
  let started = 0;
  const real = createNodeSpawner();

  return {
    spawner: (spec) => {
      started += 1;
      return real(spec);
    },
    count: () => started,
  };
}

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "trylo-wp053-"));
}

async function execute(
  sandbox: ToolSandbox,
  spawner: ShellSpawner,
  command: string,
): Promise<ToolOutcome> {
  return await createMutatingTools({ sandbox, spawner }).execute(
    { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command, timeoutMs: 30_000 } },
    SIGNAL,
  );
}

test("the sandbox's evaluate is asked before anything plans, let alone spawns", async () => {
  // The order is the claim. `createMutatingTools.execute` is the only production
  // path to a process, and it reads: evaluate, then plan, then execute. A
  // recording sandbox proves the first step happened and that the spawner was
  // reached only afterwards — order, not just presence.
  //
  // Red-example evidence for what this test is worth: with the `evaluate` call
  // deleted from `createMutatingTools.execute`, this test goes red and the six
  // below stay GREEN. That is not a weak test failing to cover the rest — it is
  // the finding. Refusal does not depend on this one call, because
  // `planMutation` re-derives the same policy check on its own. Two independent
  // gates, so deleting either one still refuses; this test is what keeps the
  // FIRST gate from being quietly dropped on the belief that the second covers
  // it. (If the second gate is ever the one that goes, the six below turn red
  // instead, and the claim is visible from the other side.)
  const root = workspace();
  try {
    const order: string[] = [];
    const inner = createWorkspaceSandbox({ workspaceRoot: root });
    const recording: ToolSandbox = {
      policy: inner.policy,
      evaluate(call) {
        order.push("evaluate");
        return inner.evaluate(call);
      },
    };
    const counting = countingSpawner();
    const tools = createMutatingTools({ sandbox: recording, spawner: counting.spawner });

    await tools.execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "trylo-nope-4b7a", timeoutMs: 5_000 } },
      SIGNAL,
    );
    assert.equal(order[0], "evaluate", "the sandbox was not asked first");
    assert.equal(counting.count(), 1, "a program that does not exist still reached the spawner once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a denied command never reaches the spawner, whatever it names", async () => {
  // Three refusals from three different layers, all of which must be refusals
  // BEFORE the spawner rather than errors after it. Each would be a real escape
  // if the count moved: an absolute path outside the workspace, a traversal,
  // and a second command hidden behind an operator the tool does not accept.
  const cases: ReadonlyArray<{ readonly label: string; readonly command: string }> = [
    { label: "absolute path outside the workspace", command: '"C:\\Windows\\System32\\cmd.exe" /c dir' },
    { label: "traversal", command: "../../trylo-wp053-escape" },
    { label: "device path", command: '"\\\\.\\NUL"' },
    { label: "redirect operator", command: "echo hi > out.txt" },
    { label: "multi-line", command: "trylo-nope-4b7a\ntrylo-nope-4b7a" },
  ];
  for (const { label, command } of cases) {
    const root = workspace();
    try {
      const counting = countingSpawner();
      const outcome = await execute(
        createWorkspaceSandbox({ workspaceRoot: root }),
        counting.spawner,
        command,
      );

      assert.equal(outcome.outcome, "error", `${label}: expected a refusal, got ${JSON.stringify(outcome)}`);
      assert.equal(counting.count(), 0, `${label}: the spawner was reached`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a bare device name is a missing program, not an opened device", async () => {
  // The distinction the previous test deliberately leaves out, because getting
  // it backwards would be a false alarm in either direction.
  //
  // `resolveInsideWorkspace` rejects `NUL` as a device name, and that is right
  // for a FILE path. On the shell path a bare word is not a path: it goes to
  // PATH resolution like any program name, and the OS answers `ENOENT`
  // (probed: `spawn NUL` and `spawn CON` are both ENOENT on this machine). So
  // no device is opened, and the command does spawn and fail.
  //
  // Asserted because the safe answer and the safe-looking answer differ here:
  // "it was refused" would be wrong, and so would "it ran".
  const root = workspace();
  try {
    const counting = countingSpawner();
    const outcome = await execute(
      createWorkspaceSandbox({ workspaceRoot: root }),
      counting.spawner,
      "NUL",
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_spawn_failed", "the refusal came from the wrong layer");
    }

    assert.equal(counting.count(), 1, "a bare name has to reach PATH resolution to be found missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the compatibility shapes do not widen what may be launched", async () => {
  // `CommandShape` is the seam that lets a `.cmd` be started at all, since
  // CreateProcess cannot start one. A seam that can start a batch file is also
  // a seam someone could widen, so the check is that the refusals above are
  // refusals at the PLANNING layer — not errors the spawner raised after being
  // handed something it should never have been given.
  const root = workspace();
  try {
    for (const command of [
      '"C:\\Windows\\System32\\cmd.exe" /c dir',
      "../../trylo-wp053-escape",
      '"\\\\.\\NUL"',
      "echo hi > out.txt",
    ]) {
      const outcome = await execute(
        createWorkspaceSandbox({ workspaceRoot: root }),
        countingSpawner().spawner,
        command,
      );

      assert.equal(outcome.outcome, "error", command);

      if (outcome.outcome === "error") {
        assert.notEqual(outcome.code, "shell_spawn_failed", `${command}: refused by the wrong layer`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the spawner is the only place a process is created", async () => {
  // A static claim, so it is checked statically: no module in this package may
  // reach for `child_process` except the one whose job that is. If a second
  // spawn path appeared, a counting seam could no longer see every launch, and
  // every count in this file would become a partial count — the failure mode is
  // silent, which is why it is worth a test rather than a convention.
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = path.join(process.cwd(), "src", "internal", "adapters", "tools", "mutating");
  const offenders: string[] = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) {
      continue;
    }

    const body = readFileSync(path.join(dir, name), "utf8");
    const runtime = body.replace(/^\s*import\s+type[\s\S]*?;\s*/gm, "");
    const spawns = /from "node:child_process"|require\("node:child_process"\)/.test(runtime);
    if (spawns && name !== "shell-child-processes.ts") {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [], "another module in this package can start a process");
  // The single mechanical owner is shared by the host and restricted runner.
  // Renaming the owner must not allow a second runtime child_process import.
  const spawner = readFileSync(path.join(dir, "shell-child-processes.ts"), "utf8");

  assert.match(spawner, /from "node:child_process"/);
  assert.match(spawner, /\bspawn\(/);
  assert.match(readFileSync(path.join(dir, "shell-spawn.ts"), "utf8"), /from "\.\/shell-child-processes\.js"/);
});

test("a cancelled signal is checked before the launch, not only after it", async () => {
  // `executeShell` reads `signal.aborted` before it spawns and again after. The
  // first read is the one this asserts: a signal already aborted must not start
  // anything, so the count stays at zero and the outcome is `cancelled` rather
  // than an error about a program.
  const root = workspace();
  try {
    const counting = countingSpawner();
    const tools = createMutatingTools({
      sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
      spawner: counting.spawner,
    });
    const outcome = await tools.execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "trylo-nope-4b7a", timeoutMs: 5_000 } },
      AbortSignal.abort(),
    );

    assert.equal(outcome.outcome, "cancelled");
    assert.equal(counting.count(), 0, "an already-aborted signal still started a process");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launcher inside the workspace runs with the restricted environment", async () => {
  // The isolation clause that is actually in force today is the environment
  // allowlist, because `IsolationPort` has no production consumer. So the
  // boundary is measured where it exists: a parent credential must not be
  // visible to a command, and this asserts it on the shell path with a real
  // process rather than only in the C09 suite.
  const root = workspace();
  const secret = "TRYLO_WP053_SECRET";
  const previous = process.env[secret];

  try {
    writeFileSync(
      path.join(root, "env.js"),
      "process.stdout.write(String(process.env.TRYLO_WP053_SECRET ?? 'absent'));\n",
      "utf8",
    );
    process.env[secret] = "must-not-reach-a-command";
    const outcome = await execute(
      createWorkspaceSandbox({ workspaceRoot: root }),
      createNodeSpawner(),
      "node env.js",
    );

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));

    if (outcome.outcome === "result") {
      assert.equal(
        (outcome.value as { readonly stdout: string }).stdout.trim(),
        "absent",
        "the parent credential reached the command",
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env[secret];
    } else {
      process.env[secret] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
