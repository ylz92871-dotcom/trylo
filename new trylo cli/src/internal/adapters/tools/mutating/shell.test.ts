import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ShellSpawnSpec, ShellSpawner } from "./shell-spawn.js";
import { childEnvironment, createNodeSpawner } from "./shell-spawn.js";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { RUN_SHELL_BINDING } from "./bindings.js";
import { createMutatingTools } from "./index.js";
import { RUN_SHELL_TOOL } from "./names.js";

/**
 * H4: `run_shell` has no shell behind it.
 *
 * The strongest available assertion for "nothing ran" is that no process was
 * created, so the spawner here is a counter that records what it was handed.
 * Everything that must never spawn is asserted against a count of zero.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-shell-"));
}

type Recording = {
  readonly spawner: ShellSpawner;
  specs: ShellSpawnSpec[];
};

function recordingSpawner(result: (spec: ShellSpawnSpec) => {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
}): Recording {
  const specs: ShellSpawnSpec[] = [];
  const recorder = {
    specs,
    spawner: async (spec: ShellSpawnSpec) => {
      specs.push(spec);
      const decided = result(spec);
      return {
        stdout: decided.stdout ?? "",
        stderr: decided.stderr ?? "",
        exitCode: decided.exitCode ?? 0,
        timedOut: decided.timedOut ?? false,
        aborted: decided.aborted ?? false,
        truncated: decided.truncated ?? false,
      };
    },
  };
  return recorder;
}

const SIGNAL = new AbortController().signal;

function toolsFor(root: string, spawner: ShellSpawner) {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  return createMutatingTools({ sandbox, spawner });
}

test("a command that cannot be parsed never reaches a process", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "echo 'unterminated" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_parse_failed");
    }
    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell operators are refused with no process to refuse them twice", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    // D7 P2-③: `|` left this list — a pipeline plans and spawns once (see the
    // pipeline tests); everything else here is still refused before spawning.
    for (const command of ["echo hi > out.txt", "a && b", "cat $(secret)", "echo `id`", "line1\nline2"]) {
      const outcome = await toolsFor(root, recording.spawner).execute(
        { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command } },
        SIGNAL,
      );
      assert.equal(outcome.outcome, "error", command);
      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "shell_operator_forbidden", command);
      }
    }
    assert.equal(recording.specs.length, 0);
    const piped = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "cat a | grep b" } },
      SIGNAL,
    );
    assert.equal(piped.outcome, "result");
    assert.equal(recording.specs.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cd and absolute executables are refused before spawning", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    const cd = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "cd .." } },
      SIGNAL,
    );
    assert.equal(cd.outcome, "error");
    if (cd.outcome === "error") {
      assert.equal(cd.code, "cd_forbidden");
    }
    const absolute = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "C:/Windows/System32/cmd.exe /c dir" } },
      SIGNAL,
    );
    assert.equal(absolute.outcome, "error");
    if (absolute.outcome === "error") {
      assert.equal(absolute.code, "path_outside_workspace");
    }
    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted command is spawned with the workspace as its working directory", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ stdout: "v22.0.0\n" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "result");
    assert.equal(recording.specs.length, 1);
    const spec = recording.specs[0];
    if (spec !== undefined) {
      assert.deepEqual(spec.argv, ["node", "-v"]);
      assert.equal(spec.cwd, realpathSync(root));
      assert.ok(spec.timeoutMs > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7: a timeout is a typed failure naming the budget, not a cancellation", async () => {
  // hard-eval 实锤：40s 命令 + 默认 10s 超时 → 整轮 cancelled exit 130，无一句
  // 说明，还和用户 Ctrl-C 共用出口。超时是时钟杀的，不是人停的，必须是 error。
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ timedOut: true, stdout: "partial" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_timeout");
      assert.match(outcome.message, /60000/);
      assert.match(outcome.message, /timeoutMs/);
      assert.match(outcome.message, /partial/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timeout is a cancellation, not a failure", async () => {
  // D7 ① 改写：超时不再是 cancellation（旧合同已判错，见上两条）。
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ timedOut: true, stdout: "partial" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_timeout");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted signal cancels before and during execution", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ aborted: true }));
    const aborted = new AbortController();
    aborted.abort();
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v" } },
      aborted.signal,
    );
    assert.equal(outcome.outcome, "cancelled");
    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-zero exit is reported with the code the process returned", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ exitCode: 3, stderr: "boom" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node missing.js" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_nonzero_exit");
      assert.match(outcome.message, /3/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output truncation is reported rather than hidden", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ stdout: "x".repeat(10), truncated: true }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "result");
    if (outcome.outcome === "result") {
      assert.equal(outcome.truncated, true);
      assert.match(outcome.output, /\[truncated\]/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a requested timeout outside the allowed range is refused rather than clamped", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    for (const timeoutMs of [0, -5, 1_000_000]) {
      const outcome = await toolsFor(root, recording.spawner).execute(
        { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -v", timeoutMs } },
        SIGNAL,
      );
      assert.equal(outcome.outcome, "error", String(timeoutMs));
      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "invalid_arguments");
      }
    }
    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The child environment is the only thing standing between a command and the
 * credentials the CLI was started with, because there is no OS sandbox here.
 */
test("the child environment carries no secrets and no proxy configuration", () => {
  const previousKey = process.env.TRYLO_API_KEY;
  const previousProxy = process.env.HTTPS_PROXY;
  process.env.TRYLO_API_KEY = "sk-should-not-leak";
  process.env.HTTPS_PROXY = "http://proxy.invalid:8080";
  try {
    const env = childEnvironment();
    assert.equal(env.TRYLO_API_KEY, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(typeof env.PATH, "string");
  } finally {
    if (previousKey === undefined) {
      delete process.env.TRYLO_API_KEY;
    } else {
      process.env.TRYLO_API_KEY = previousKey;
    }
    if (previousProxy === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = previousProxy;
    }
  }
});

test("the real spawner refuses to run a command with no executable", async () => {
  await assert.rejects(
    () => createNodeSpawner()({ argv: [], cwd: process.cwd(), timeoutMs: 10, signal: SIGNAL, maxOutputBytes: 10, maxOutputLines: 10 }),
    /shell needs an executable/,
  );
});

/**
 * N1-P0: every refusal has to say where to go instead.
 *
 * The failing real-model run spent two iterations on `cat` (a POSIX utility
 * Windows does not have) and was told only `spawn cat ENOENT`; it then lost two
 * more to `node -e` commands refused as multi-line or as an unquoted operator.
 * A refusal the model cannot act on costs a whole iteration, so the message is
 * the contract here: the OS error is the diagnosis, the replacement is the fix.
 */

test("a program this machine does not have names the replacement, not just the OS error", async () => {
  const root = tempRoot();
  try {
    const missing = "trylo-program-that-does-not-exist-n1";
    const outcome = await toolsFor(root, createNodeSpawner()).execute(
      {
        toolCallId: "c",
        name: RUN_SHELL_TOOL,
        arguments: { command: `${missing} -A src/invoice.js` },
      },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_spawn_failed");
      assert.match(outcome.message, new RegExp(missing), "the program that could not start is named");
      assert.match(outcome.message, /read_file/, "reading a file with read_file is named as the replacement");
      assert.match(
        outcome.message,
        new RegExp(process.platform),
        "the platform the program was not found on is named",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-line command is refused with the shape that would work", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      {
        toolCallId: "c",
        name: RUN_SHELL_TOOL,
        arguments: { command: 'node -e "const total = 1\nconsole.log(total)"' },
      },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_operator_forbidden");
      assert.match(outcome.message, /write_file/, "moving the script into a file is named");
    }
    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused operator explains how to keep the word as one argument", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({}));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node -e console.log(1+(2))" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_operator_forbidden");
      assert.match(outcome.message, /quot/i, "quoting so the word stays one argument is named");
      assert.match(outcome.message, /steps|pipeTo/, "structural composition is named for real composition");
    }
    assert.equal(recording.specs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing command says it is a failure, not a finished task", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => ({ exitCode: 1, stdout: "tests 4 / pass 0 / fail 4" }));
    const outcome = await toolsFor(root, recording.spawner).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "node --test" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_nonzero_exit");
      assert.match(outcome.message, /tests 4 \/ pass 0 \/ fail 4/, "the output is still the evidence");
      assert.match(
        outcome.message,
        /not .*(finished|done)/i,
        "the result states that a failing command is not the task being finished",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the run_shell description tells the model what this machine cannot be assumed to have", () => {
  // The description is the only place the model is told anything about the
  // environment, so what it must convey is the assertion.
  assert.match(RUN_SHELL_BINDING.description, /read_file/, "the file-reading replacement is named");
  assert.match(
    RUN_SHELL_BINDING.description,
    /does not exist|not available|no POSIX/i,
    "programs this machine may not have are stated as a boundary",
  );
});

/** What `spawn` rejects with when the program cannot be started. */
function spawnFailure(code: string): Error & { code: string } {
  const err = new Error(`spawn cat ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

test("the platform named in that guidance comes from the injectable seam", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => {
      throw spawnFailure("ENOENT");
    });
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const outcome = await createMutatingTools({
      sandbox,
      spawner: recording.spawner,
      platform: "win32",
    }).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "cat -A src/invoice.js" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.match(outcome.message, /\(win32\)/, "the injected platform is the one reported");
      assert.match(outcome.message, /read_file/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spawn failure that is not ENOENT does not claim the program is missing", async () => {
  const root = tempRoot();
  try {
    const recording = recordingSpawner(() => {
      throw spawnFailure("EACCES");
    });
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const outcome = await createMutatingTools({ sandbox, spawner: recording.spawner }).execute(
      { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command: "cat -A src/invoice.js" } },
      SIGNAL,
    );
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_spawn_failed");
      assert.match(outcome.message, /EACCES/, "the real OS error is still the diagnosis");
      assert.equal(
        /read_file/.test(outcome.message),
        false,
        "the not-found explanation is attached only to the case where it is true",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
