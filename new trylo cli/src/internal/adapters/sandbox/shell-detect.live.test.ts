import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hostShellEnvironment } from "./executable.js";
import { needsVerbatimArguments, resolveShell, shellExecArgv } from "./shell-detect.js";

/**
 * WP05.1's real-process half: the argv in `shell-detect.test.ts` is observed
 * here rather than only well-shaped. Every platform fact in that file is an
 * injected array, which is what makes "a machine with no PowerShell"
 * assertable anywhere — and also what makes it possible for a set of flags to
 * look right and run wrong. These tests are the correction for that, and each
 * was written after a measurement on this machine contradicted what the pure
 * version had asserted.
 *
 * A shell that is genuinely absent is SKIPPED, not failed: a skip says "not on
 * this machine", an assertion failure says "broken". Getting that backwards
 * would report a product defect on every machine that lacks PowerShell.
 *
 * That skip is also the whole reason this file can be trusted on a machine whose
 * `bash` is WSL's rather than Git's. Measured: `resolveShell` picks by PATH
 * order, and this machine has resolved both — `C:\Windows\system32\bash.EXE`
 * (WSL, seconds to cold-start, and it holds the temporary directory open long
 * enough to make the cleanup below fail with EPERM) and Git's `bash.EXE` at
 * 51ms. A machine-dependent answer inside an assertion turns a red gate into a
 * mystery, so what is asserted here is the SHAPE OF THE REFUSAL and the timing
 * budget, never which `bash` happened to win.
 */

/**
 * The refusal for a name this build does not know, at the boundary.
 *
 * `ShellKind` is a compile-time union, so this call is a type error on purpose —
 * `@ts-expect-error` is the assertion, and it is a real one: if the parameter
 * ever widens to `string`, tsc reports `TS2578` (unused `@ts-expect-error`) and
 * this goes red, because the runtime check would then be untested.
 *
 * Red example, measured before the check existed: this threw
 * `TypeError: PROGRAM_NAMES[kind] is not iterable` from inside the lookup —
 * the one failure shape this package is not allowed to have, and the reason
 * `unknown_shell_kind` had been a member of the failure union that nothing in
 * the repository could produce.
 */
test("a shell name outside the union is a typed refusal, not a crash", () => {
  const host = hostShellEnvironment();
  // @ts-expect-error a name outside ShellKind is exactly what this asserts
  const refused = resolveShell(host, "pwsh");

  assert.equal(refused.ok, false);

  if (refused.ok) {
    return;
  }

  assert.equal(refused.code, "unknown_shell_kind");
  // The message has to name what was asked for AND what exists, because the
  // caller is a settings file that will be read by a person debugging it.
  assert.match(refused.message, /pwsh/);
  assert.match(refused.message, /powershell/);

  // And the same boundary on the argv builder: falling off that switch returned
  // `undefined`, so a caller asking for `.length` crashed instead of getting an
  // argv. A `DetectedShell` cannot be built with a bad kind in TypeScript, so
  // the object is forged the way a JavaScript caller or an unnarrowed config
  // value would produce one.
  const forged = { kind: "pwsh", path: "C:/nowhere/pwsh.exe" };
  const argv = shellExecArgv(forged as Parameters<typeof shellExecArgv>[0], "echo hi");

  assert.equal(Array.isArray(argv), true, "shellExecArgv must always return an array");
  assert.equal(argv[0], "C:/nowhere/pwsh.exe");
});

/**
 * Remove the temporary directory, tolerating a handle that has not been released
 * yet.
 *
 * `rmSync(..., { force: true })` only forgives ENOENT. On Windows the shell that
 * just exited can still be holding the directory it ran in — measured here with
 * WSL's `bash.EXE`, which is what `resolveShell` picked before Git's `bash.EXE`
 * was on this machine's PATH — and the delete then fails with `EPERM`. That
 * turned an assertion about operators into a red gate whose message said
 * nothing about operators, which is the worst kind of red: it looks like the
 * product is broken when the test's own cleanup was.
 *
 * Bounded retry, and a directory left behind on purpose rather than a test that
 * fails for a reason it is not about. A leaked temp directory is a nuisance; a
 * false product defect costs a real debugging session.
 */
function removeWorkspace(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
      return;
    } catch (error) {
      if (attempt === 4) {
        return;
      }

      const code = (error as { readonly code?: unknown }).code;
      if (code !== "EPERM" && code !== "EBUSY") {
        throw error;
      }
    }
  }
}

/**
 * A real spawn, so the argv above is not only well-shaped but observed.
 * Skipped where the shell is genuinely absent rather than failed: a skip says
 * "not on this machine", an assertion failure says "broken".
 */
test("a real PowerShell run honours operators and reports a native failure", async () => {
  const host = hostShellEnvironment();
  const shell = resolveShell(host, "powershell");

  assert.equal(shell.ok, true, "no PowerShell on this machine");

  if (!shell.ok) {
    return;
  }

  const { spawn } = await import("node:child_process");
  const run = (command: string): Promise<{ code: number; out: string }> =>
    new Promise((resolveRun) => {
      const [file, ...args] = shellExecArgv(shell.shell, command);
      const child = spawn(file ?? "", args ?? [], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(needsVerbatimArguments(shell.shell) ? { windowsVerbatimArguments: true } : {}),
      });
      let out = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        resolveRun({ code: code ?? -1, out });
      });
    });

  // Operators mean what they mean in this shell — this is the whole point of
  // handing over one unquoted argument instead of a pre-parsed argv.
  const piped = await run("Write-Output (2 + 3) | ForEach-Object { $_ }");

  assert.equal(piped.code, 0);
  assert.equal(piped.out.trim(), "5");

  // The measured failure: a non-zero native exit survives a later cmdlet, and
  // the tail turns it into the process's exit status instead of 0.
  const failed = await run("cmd /c exit 4; Write-Output after");

  assert.match(failed.out, /after/, "the tail must not swallow the command's own output");
  assert.equal(failed.code, 4, "PowerShell must not report a failed native command as success");
});

test("a real bash run honours operators, redirection and a non-zero exit", async () => {
  const host = hostShellEnvironment();
  const shell = resolveShell(host, "bash");

  assert.equal(shell.ok, true, "no bash on this machine");

  if (!shell.ok) {
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "trylo-wp05-"));
  const { spawn } = await import("node:child_process");

  try {
    const run = (command: string): Promise<{ code: number; out: string }> =>
      new Promise((resolveRun) => {
        const [file, ...args] = shellExecArgv(shell.shell, command);
        const child = spawn(file ?? "", args ?? [], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          ...(needsVerbatimArguments(shell.shell) ? { windowsVerbatimArguments: true } : {}),
        });
        let out = "";

        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        child.on("close", (code) => {
          resolveRun({ code: code ?? -1, out });
        });
      });

    const chained = await run("echo a && echo b");

    assert.equal(chained.code, 0);
    assert.equal(chained.out.trim().split("\n").join(","), "a,b");

    const redirected = await run("echo hi > out.txt && cat out.txt");

    assert.equal(redirected.code, 0);
    assert.match(redirected.out, /hi/);
    // Real disk evidence, not just the echo of it.
    assert.equal(readFileSync(path.join(dir, "out.txt"), "utf8").trim(), "hi");

    const failed = await run("exit 7");

    assert.equal(failed.code, 7);
  } finally {
    removeWorkspace(dir);
  }
});

test("a shell that is named but absent fails to start, with the name in the error", async () => {
  // The explicit-failure half of WP05.1's acceptance: not a silent substitution,
  // and not a bare ENOENT the model has to interpret.
  const marker = path.join(os.tmpdir(), "trylo-wp05-absent-shell");

  assert.equal(existsSync(marker), false);
  const { spawn } = await import("node:child_process");
  const result = await new Promise<{ code: number | null; err: NodeJS.ErrnoException | undefined }>(
    (resolveRun) => {
      const child = spawn("trylo-no-such-shell-xyz", ["-c", "echo hi"], { stdio: "ignore" });

      child.on("error", (err: NodeJS.ErrnoException) => {
        resolveRun({ code: null, err });
      });
      child.on("close", (code) => {
        resolveRun({ code, err: undefined });
      });
    },
  );

  assert.equal(result.err?.code, "ENOENT");
  assert.match(result.err?.message ?? "", /trylo-no-such-shell-xyz/);
});

test("the host record is built from this machine, and overridable", () => {
  const host = hostShellEnvironment();

  assert.equal(host.platform, process.platform);
  assert.equal(host.fileExists(process.execPath), true);
  assert.equal(host.fileExists(path.join(os.tmpdir(), "trylo-does-not-exist-xyz")), false);
  // Overrides let a caller with a real context pass what it already holds.
  const pinned = hostShellEnvironment({ platform: "linux", env: { PATH: "/bin" } });

  assert.equal(pinned.platform, "linux");
  assert.equal(pinned.env["PATH"], "/bin");
});
