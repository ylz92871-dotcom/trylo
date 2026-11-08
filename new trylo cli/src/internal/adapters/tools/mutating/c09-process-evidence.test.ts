import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NODE, bareWorkspace, cleanup, run, stdoutOf, workspace } from "./c09-harness.js";

/**
 * WP05.2, the process half: what can be started on this machine at all, and
 * under what environment.
 *
 * The data half (stdout, argv, cwd, non-zero exit, a pipeline) is in
 * `c09-pipes-evidence.test.ts`. This file is about the launch itself — the
 * program's name, the platform's own rules about startable files, and the
 * environment the child is handed — because those are the parts where "the
 * command ran" and "the command was safe to run" are different questions.
 */

/**
 * The batch case, stated separately because it is the one Windows shape that
 * cannot be started by `CreateProcess`: a `.cmd` is not an executable, so this
 * is the path `executable.ts` quotes its way through `cmd /s /c`.
 *
 * The assertion is about token BOUNDARIES, and the expectation comes from a
 * probe rather than from taste. Measured on this machine with the same
 * `cmd /d /s /c "<cmd> "<tok>" ..."` shape this spawner builds:
 *
 *     STAR=[%*]   with two tokens ->  ["hello"] ["world"]
 *     IDX =[%1]    with two tokens ->  ["hello"]["world"]
 *     IDX =[%1]    one token "a b"  ->  ["a b"][""]     (one argument, not two)
 *
 * So `%*` re-quoting each argument is cmd's own semantics, not a mangling of
 * ours — and `%~1` is the form that proves the boundary survived. The test
 * asserts the second, because "it printed something" is not the claim; "the
 * space did not become a separator" is.
 */
test("a batch script runs end to end, and a spaced argument stays one argument", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const root = bareWorkspace();

  try {
    writeFileSync(
      path.join(root, "trylo-c09.cmd"),
      "@echo off\r\necho STAR=[%*]\r\necho IDX=[%~1][%~2]\r\n",
      "utf8",
    );
    const outcome = await run(root, `trylo-c09.cmd "a b" c`);

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    // %~1 is the unquoted argument: "a b" as ONE word, and the second is "c".
    assert.match(stdoutOf(outcome), /IDX=\[a b\]\[c\]/);
  } finally {
    cleanup(root);
  }
});

test("a relative program name is found on PATH, not resolved against the workspace", async () => {
  // The complement of the absolute-path refusal: a bare name is the shell's
  // business, so the workspace does not get to insist the program lives inside
  // it. The rig puts the workspace FIRST on `PATH`, so this cannot pass by
  // finding some other launcher.
  const root = workspace({ "ping.js": "process.stdout.write('found me');\n" });
  try {
    const outcome = await run(root, `${NODE} ping.js`);
    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    assert.equal(stdoutOf(outcome), "found me");
  } finally {
    cleanup(root);
  }
});

test("a program the OS cannot start fails with the platform's own reason", async () => {
  // A `.js` file inside the workspace is still not an executable. Windows
  // Node/libuv reports EFTYPE, EINVAL or ENOENT for this shape, depending on
  // executable lookup and runtime version. Keep the native reason visible.
  // The test pins that the reason is reported rather than swallowed, because
  // "it did not run" without a reason is the answer that gets retried forever.
  if (process.platform !== "win32") {
    return;
  }

  const root = workspace({ "not-a-program.js": "// nothing executable here\n" });

  try {
    assert.equal(existsSync(path.join(root, "not-a-program.js")), true);
    const outcome = await run(root, "not-a-program.js");

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_spawn_failed");
      assert.match(outcome.message, /not-a-program\.js/);
      assert.match(outcome.message, /EFTYPE|EINVAL|ENOENT|not a valid/);
    }
  } finally {
    cleanup(root);
  }
});

test("a command that does not exist fails with the program named", async () => {
  const root = bareWorkspace();
  try {
    const outcome = await run(root, "trylo-no-such-program-9f2a");

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "shell_spawn_failed");
      // The guidance is part of the contract: the model has to be told that this
      // machine does not have the program, or it asks again the same way.
      assert.match(outcome.message, /trylo-no-such-program-9f2a/);
    }
  } finally {
    cleanup(root);
  }
});

/**
 * The environment half of WP05.2's acceptance, and the base WP05.3's isolation
 * clause stands on. Measured on this machine with a real child: a secret in the
 * parent process is absent inside the command, while PATH, HOME and TEMP are
 * present. So a command cannot quietly discover the API key the CLI was started
 * with, and `childEnvironment()` is a boundary rather than a convenience.
 */
test("the child environment is an allowlist: no credential, still a usable one", async () => {
  const secretName = "TRYLO_C09_SECRET_PROBE";
  const root = workspace({
    "env.js": [
      "const s = process.env.TRYLO_C09_SECRET_PROBE ?? 'absent';",
      "process.stdout.write(JSON.stringify({",
      "  secret: s,",
      "  path: !!process.env.PATH,",
      "  home: !!(process.env.HOME || process.env.USERPROFILE),",
      "  tmp: !!process.env.TEMP,",
      "}));",
      "",
    ].join("\n"),
  });
  const previous = process.env[secretName];

  try {
    process.env[secretName] = "must-not-reach-a-command";
    const outcome = await run(root, `${NODE} env.js`);

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    const seen = JSON.parse(stdoutOf(outcome)) as {
      secret: string; path: boolean; home: boolean; tmp: boolean;
    };

    assert.equal(seen.secret, "absent", "the parent credential reached the command");
    // Absent would be safe but useless: a command with no PATH cannot find
    // anything, and the whole point of the allowlist is that a command runs.
    assert.equal(seen.path, true);
    assert.equal(seen.home, true);
    assert.equal(seen.tmp, true);
  } finally {
    if (previous === undefined) {
      delete process.env[secretName];
    } else {
      process.env[secretName] = previous;
    }
    cleanup(root);
  }
});

test("a timeout is the clock's failure, and the partial output survives", async () => {
  // OPEN-WP05-1, measured not guessed: on Windows the timeout is reported
  // correctly but the process tree is NOT reaped. `shell-spawn.ts` calls
  // `child.kill()`, which terminates `cmd.exe`; the node process that `cmd.exe`
  // started keeps running and keeps the inherited stdout pipe open, so the
  // spawner's promise only settles when that grandchild exits on its own.
  // Probe on this machine: kill at 1522 ms, `close` at 8126 ms, sig=SIGTERM.
  //
  // So this test's own duration is the grandchild's lifetime, which is why the
  // timer below is 4s and not 60s. The assertions are about what the tool
  // REPORTS, and those are right: the code is the clock's, not `cancelled`,
  // and the output written before the hang is in the message. Fixing the reap
  // means changing `shell-spawn.ts`, which is another package's file — recorded
  // rather than quietly patched here.
  const root = workspace({
    "hang.js": "process.stdout.write('started'); setTimeout(() => {}, 4000);\n",
  });
  try {
    const outcome = await run(root, `${NODE} hang.js`, { timeoutMs: 1_500 });

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      // Not `cancelled`: nobody pressed anything, and reporting a clock as a
      // person reads exactly like the user stopping the run.
      assert.equal(outcome.code, "shell_timeout");
      assert.match(outcome.message, /started/);
    }
  } finally {
    cleanup(root);
  }
});
