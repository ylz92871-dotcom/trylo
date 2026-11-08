import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ToolOutcome } from "../../../ports/tools.js";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";
import { RUN_SHELL_TOOL } from "./names.js";
import type { ShellSpawnSpec, ShellSpawner } from "./shell-spawn.js";
import { createNodeSpawner } from "./shell-spawn.js";
import { lookupExecutable } from "../../sandbox/executable.js";

/**
 * D6: composition without a shell.
 *
 * `cd`, `a; b; c` and `a | b` are the three things people actually mean when
 * they reach for an operator, so each gets a structural form. What these tests
 * defend is the shape of that form: every word still arrives here through the
 * same tokenizer, and nothing is handed to an interpreter to re-read.
 */

const SIGNAL = new AbortController().signal;
const isWindows = process.platform === "win32";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "trylo-compose-"));
}

type Recording = {
  readonly spawner: ShellSpawner;
  specs: ShellSpawnSpec[];
};

function recordingSpawner(
  result: (spec: ShellSpawnSpec, index: number) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  },
): Recording {
  const specs: ShellSpawnSpec[] = [];
  return {
    specs,
    spawner: async (spec: ShellSpawnSpec) => {
      const decided = result(spec, specs.length);

      specs.push(spec);

      return {
        stdout: decided.stdout ?? "",
        stderr: decided.stderr ?? "",
        exitCode: decided.exitCode ?? 0,
        timedOut: false,
        aborted: false,
        truncated: false,
      };
    },
  };
}

/** Tool results carry JSON, so the read has to say what it expects. */
function stdoutOf(outcome: ToolOutcome): string {
  if (outcome.outcome !== "result") {
    return "";
  }
  const value = outcome.value.stdout;
  return typeof value === "string" ? value : "";
}

function toolsFor(root: string, spawner: ShellSpawner) {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  return createMutatingTools({ sandbox, spawner });
}

test("cwd selects a directory inside the workspace", async () => {
  const root = tempRoot();
  try {
    mkdirSync(path.join(root, "sub"));
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v", cwd: "sub" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");
    assert.equal(recording.specs.length, 1);
    assert.equal(recording.specs[0]?.cwd, realpathSync.native(path.join(root, "sub")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cwd cannot leave the workspace, absolutely or by climbing", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));

    for (const cwd of ["..", "../outside", path.resolve("/")]) {
      const outcome = await toolsFor(root, recording.spawner).execute(
        { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v", cwd } },
        SIGNAL,
      );

      assert.equal(outcome.outcome, "error", cwd);

      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "path_outside_workspace", cwd);
      }
    }

    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cwd that is not a directory is refused", async () => {
  const root = tempRoot();
  try {
    writeFileSync(path.join(root, "file.txt"), "x", "utf8");
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v", cwd: "file.txt" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "cwd_not_directory");
    }

    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("steps run in order and stop at the first failure", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner((_spec, index) =>
      index === 1 ? { exitCode: 4, stderr: "second failed" } : { stdout: "ok" },
    );
    const outcome = await toolsFor(root, recording.spawner).execute(
      {
        toolCallId: "c",
        name: RUN_SHELL_TOOL,
        arguments: { command: "one", steps: ["two", "three"] },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_nonzero_exit");
      assert.match(outcome.message, /4/);
    }

    assert.deepEqual(
      recording.specs.map((spec) => spec.argv),
      [["one"], ["two"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every step is planned by the same refusal rules as the first", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "one", steps: ["two | three"] } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");
    assert.deepEqual(
      recording.specs[1]?.pipeTo?.map((segment) => segment.argv),
      [["three"]],
    );
    // …while a forbidden operator in any step still refuses the whole call.
    const denied = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "one", steps: ["two && three"] } },
      SIGNAL,
    );

    assert.equal(denied.outcome, "error");

    if (denied.outcome === "error") {
      assert.equal(denied.code, "shell_operator_forbidden");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("steps and pipeTo are not combined, so the composition stays unambiguous", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      {
        toolCallId: "c",
        name: RUN_SHELL_TOOL,
        arguments: { command: "one", steps: ["two"], pipeTo: "grep x" },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "invalid_arguments");
      assert.match(outcome.message, /not both/);
    }

    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7: an inline pipeline reaches the spawner as ordered receivers", async () => {
  // `produce | grep x | sort`：三段各过审批，spawner 一次拿到有序 receivers。
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ stdout: "sorted" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "produce | grep x | sort" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");
    assert.deepEqual(
      recording.specs[0]?.pipeTo?.map((segment) => segment.argv),
      [
        ["grep", "x"],
        ["sort"],
      ],
    );

    if (outcome.outcome === "result") {
      assert.match(typeof outcome.value.command === "string" ? outcome.value.command : "", / \| .* \| /);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7: a real three-stage pipeline runs end to end with the last exit winning", async () => {
  // 无 shell 的真管道：node 产出 → node 透传 → node 改写，exit 取最后一段。
  const root = tempRoot();
  try {
    const spawner = createNodeSpawner();
    const outcome = await toolsFor(root, spawner).execute(
      {
        toolCallId: "c",
        name: RUN_SHELL_TOOL,
        arguments: {
          command: `node -e "console.log('hello')" | node -e "process.stdin.pipe(process.stdout)" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('got:'+s))"`,
        },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.exitCode, 0);
      assert.match(typeof outcome.value.stdout === "string" ? outcome.value.stdout : "", /got:hello/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeTo is handed to the spawner as a second argv, not as a shell string", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner((spec) => (spec.pipeTo === undefined ? {} : { stdout: "matched" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "produce", pipeTo: "grep x" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(stdoutOf(outcome), "matched");
      const command = outcome.value.command;
      assert.match(typeof command === "string" ? command : "", / \| /);
    }

    assert.deepEqual(
      recording.specs[0]?.pipeTo?.map((segment) => segment.argv),
      [["grep", "x"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * B1: the reason any of this exists. A `.cmd` is not an executable, so before
 * this change `npm` could not be run from `run_shell` on the platform this
 * project is developed on.
 */
test("a real Windows batch script runs end to end", { skip: !isWindows }, async () => {
  const root = tempRoot();
  const previousPath = process.env["PATH"];

  try {
    writeFileSync(path.join(root, "trylo-probe.cmd"), "@echo off\r\necho probe-ok %*\r\n", "utf8");
    process.env["PATH"] = `${root}${path.delimiter}${previousPath ?? ""}`;
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const tools = createMutatingTools({ sandbox });
    const outcome = await tools.execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "trylo-probe hello", timeoutMs: 20_000 } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));

    if (outcome.outcome === "result") {
      assert.match(stdoutOf(outcome), /probe-ok/);
      assert.match(stdoutOf(outcome), /hello/);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("run_shell can start npm, a .cmd, on Windows", { skip: !isWindows || lookupExecutable("npm").kind !== "script" }, async () => {
  const root = tempRoot();
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const tools = createMutatingTools({ sandbox });
    const outcome = await tools.execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "npm --version", timeoutMs: 30_000 } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));

    if (outcome.outcome === "result") {
      assert.match(stdoutOf(outcome), /\d+\.\d+\.\d+/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * B2: the red line. Each payload is one that a shell would have treated as an
 * instruction; the assertion is that the sentinel file never appears, whatever
 * the refusal mechanism happens to be.
 */
test("no injection payload writes the sentinel file", { skip: !isWindows }, async () => {
  const root = tempRoot();
  const previousPath = process.env["PATH"];
  const previousPayload = process.env["TRYLO_PAYLOAD"];

  try {
    writeFileSync(path.join(root, "trylo-probe.cmd"), "@echo off\r\necho probe %*\r\n", "utf8");
    const sentinel = path.join(root, "PWNED.txt");

    process.env["PATH"] = `${root}${path.delimiter}${previousPath ?? ""}`;
    // What cmd would expand this into if the word ever reached it unquoted.
    process.env["TRYLO_PAYLOAD"] = `x & echo pwned> "${sentinel}"`;
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const tools = createMutatingTools({ sandbox });
    // Two groups, because `|` is not an injection attempt any more: an inline
    // pipeline is a shipped way to compose a command (D7), and its second stage
    // is a command the caller wrote out and is expected to run — every stage is
    // planned by the same refusal rules as the first, which this suite pins
    // separately. So a pipeline is still held to the property that matters here
    // (the sentinel is never written) but not to "the output must not contain
    // pwned", which would be asserting against a feature.
    const metacharacterPayloads = [
      "trylo-probe ; echo pwned",
      "trylo-probe & echo pwned",
      "trylo-probe %TRYLO_PAYLOAD%",
      "trylo-probe ^",
      "trylo-probe \"quoted & still\"",
    ];
    const pipelinePayloads = ["trylo-probe | echo pwned"];

    for (const command of [...metacharacterPayloads, ...pipelinePayloads]) {
      const outcome = await tools.execute(
        { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command, timeoutMs: 20_000 } },
        SIGNAL,
      );

      assert.equal(existsSync(sentinel), false, `sentinel written by: ${command}`);

      // A payload that is refused is fine; one that runs must have stayed one
      // word. A pipeline is exempt because its second stage is meant to run.
      if (outcome.outcome === "result" && !pipelinePayloads.includes(command)) {
        assert.ok(!stdoutOf(outcome).includes("pwned"), command);
      }
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }

    if (previousPayload === undefined) {
      delete process.env["TRYLO_PAYLOAD"];
    } else {
      process.env["TRYLO_PAYLOAD"] = previousPayload;
    }

    rmSync(root, { recursive: true, force: true });
  }
});
