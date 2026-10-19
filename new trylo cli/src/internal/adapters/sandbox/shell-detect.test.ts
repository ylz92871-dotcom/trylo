import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  defaultShellKind,
  detectShellKind,
  needsVerbatimArguments,
  POWERSHELL_EXIT_TAIL,
  resolveDefaultShell,
  resolveShell,
  shellExecArgv,
  type ShellEnvironment,
} from "./shell-detect.js";

/**
 * WP05.1: which shell interprets a command, and what argument vector runs it.
 *
 * Every platform fact in here is an injected array, not a fact about the host,
 * so "a machine with no PowerShell" is assertable anywhere. The two tests marked
 * MEASURED were written against the numbers a real spawn produced on this
 * machine and are the reason several rules below exist; they are pinned here so
 * a future edit to a flag has to argue with the measurement.
 */

function surface(overrides: Partial<ShellEnvironment>): ShellEnvironment {
  return {
    platform: "win32",
    env: {},
    fileExists: () => false,
    ...overrides,
  };
}

/** PATH search as the platform would do it: `dir` + PATHEXT entries. */
function pathWith(...entries: ReadonlyArray<string>): Record<string, string | undefined> {
  return { PATH: entries.join(path.delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
}

test("a shell is recognised by its file stem, not by its exact name", () => {
  // The spellings a user, a PATH entry and a config file each produce.
  assert.equal(detectShellKind("bash"), "bash");
  assert.equal(detectShellKind("/usr/bin/bash"), "bash");
  assert.equal(detectShellKind("C:\\Program Files\\Git\\bin\\bash.EXE"), "bash");
  assert.equal(detectShellKind("pwsh"), "powershell");
  assert.equal(detectShellKind("powershell.exe"), "powershell");
  assert.equal(detectShellKind("cmd"), "cmd");
  assert.equal(detectShellKind("C:\\Windows\\System32\\cmd.exe"), "cmd");
  // Not a shell: answering `powershell` here would run a user's script under an
  // interpreter they never asked for.
  assert.equal(detectShellKind("node"), undefined);
  assert.equal(detectShellKind("npm.cmd"), undefined);
  assert.equal(detectShellKind(""), undefined);
});

test("PATH is searched before the install locations", () => {
  // The candidate strings here are spelled with the same case PATHEXT supplies,
  // because that is what the platform hands over: `PATHEXT` on this machine is
  // `.COM;.EXE;.BAT;.CMD` and the concatenation is literal. Case-insensitivity
  // of the real filesystem is `fileExists`' business, not this module's — see
  // the case test below.
  const host = surface({
    env: pathWith("C:\\tools\\bin", "C:\\other"),
    fileExists: (candidate) => candidate === "C:\\tools\\bin\\bash.EXE",
  });
  const result = resolveShell(host, "bash");
  assert.equal(result.ok, true);
  if (result.ok) {
    // A shell the user put on PATH is the one they meant; the fallback list
    // only answers "is there any of this here at all".
    assert.equal(result.shell.path, "C:\\tools\\bin\\bash.EXE");
    assert.equal(result.shell.kind, "bash");
  }
});

test("PATH order decides, so the first directory that has it wins", () => {
  const both = (candidate: string): boolean =>
    candidate === "C:\\first\\bash.EXE" || candidate === "C:\\second\\bash.EXE";
  const host = surface({ env: pathWith("C:\\first", "C:\\second"), fileExists: both });
  const result = resolveShell(host, "bash");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.shell.path, "C:\\first\\bash.EXE");
  }
});

test("case-insensitivity is the probe's job, and this module does not re-add it", () => {
  // A Windows filesystem resolves `bash.exe` for `bash.EXE`; a Linux one does
  // not. The module concatenates literally and lets `fileExists` decide, so the
  // same rules give the right answer on both platforms without a platform
  // branch here — and a case-sensitive surface is expressed by an honest probe
  // rather than by pretending the platform is uniform.
  const caseSensitive = surface({
    platform: "linux",
    env: { PATH: "/bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    fileExists: (candidate) => candidate === "/bin/bash.exe",
  });
  const found = resolveShell(caseSensitive, "bash");
  assert.equal(found.ok, false, "a literal .EXE must not match a lowercase file on a case-sensitive fs");
  const insensitive = surface({
    platform: "win32",
    env: pathWith("C:\\tools"),
    fileExists: (candidate) => candidate.toLowerCase() === "c:\\tools\\bash.exe".toLowerCase(),
  });
  const alsoFound = resolveShell(insensitive, "bash");
  assert.equal(alsoFound.ok, true);
  // Unchanged on a non-Windows surface: no PATHEXT suffix is appended at all.
  const unix = surface({ platform: "linux", env: { PATH: "/bin" }, fileExists: (c) => c === "/bin/bash" });
  const onUnix = resolveShell(unix, "bash");
  assert.equal(onUnix.ok, true);
  if (onUnix.ok) {
    assert.equal(onUnix.shell.path, "/bin/bash");
  }
});

test("pwsh is preferred over powershell when both are installed", () => {
  const host = surface({
    env: pathWith("C:\\ps7", "C:\\ps51"),
    fileExists: (candidate) =>
      candidate === "C:\\ps7\\pwsh.EXE" || candidate === "C:\\ps51\\powershell.EXE",
  });
  const result = resolveShell(host, "powershell");
  assert.equal(result.ok, true);
  if (result.ok) {
    // PowerShell 7 is the one that behaves the way the exit-code contract
    // describes; 5.1 only works because of the `$LASTEXITCODE` tail.
    assert.equal(result.shell.path, "C:\\ps7\\pwsh.EXE");
  }
});

test("PATHEXT decides which spelling on PATH counts", () => {
  const host = surface({
    env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
    fileExists: (candidate) => candidate === "C:\\tools\\bash.CMD",
  });
  const result = resolveShell(host, "bash");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.shell.path, "C:\\tools\\bash.CMD");
  }
  // The same directory with a PATHEXT that has no .CMD does not resolve — the
  // extension list is what makes a bare name a program rather than a guess.
  const strict = resolveShell(
    surface({ env: { PATH: "C:\\tools", PATHEXT: ".EXE" }, fileExists: () => false }),
    "bash",
  );
  assert.equal(strict.ok, false);
});

test("a named shell that is not installed fails, and is never substituted", () => {
  const host = surface({ env: pathWith("C:\\tools"), fileExists: () => false });
  const result = resolveShell(host, "zsh");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "shell_not_installed");
    // The name the caller asked for is in the message, because "command not
    // found" from a substituted cmd is indistinguishable from the user's bug.
    assert.match(result.message, /zsh/);
  }
});

test("a missing PowerShell says so in the words a user would use", () => {
  const host = surface({ env: pathWith("C:\\tools"), fileExists: () => false });
  const result = resolveShell(host, "powershell");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "shell_not_installed");
    assert.match(result.message, /pwsh/);
    assert.match(result.message, /powershell/);
  }
});

test("the install locations are the fallback, not the first choice", () => {
  // PowerShell 5.1's own install path is what makes "PowerShell works" true on
  // a stock Windows box rather than "PowerShell works if you upgraded".
  const host = surface({
    env: {},
    fileExists: (candidate) =>
      candidate === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });
  const result = resolveShell(host, "powershell");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.shell.path, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  }
});
test("the default shell is the platform's own, and never the user's SHELL var", () => {
  assert.equal(defaultShellKind(surface({ platform: "win32" })), "powershell");
  assert.equal(defaultShellKind(surface({ platform: "linux" })), "sh");
  // A `SHELL` pointing at a login shell would make the result depend on whose
  // session is running it; this picks the interpreter for a command the MODEL
  // wrote, so it does not read that variable at all.
  const withShellVar = defaultShellKind(surface({ platform: "linux", env: { SHELL: "/bin/zsh" } }));
  assert.equal(withShellVar, "sh");
});

test("the default falls back only when the platform's own shell is missing", () => {
  const noPowerShell = surface({
    platform: "win32",
    env: {},
    fileExists: (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
  });
  const result = resolveDefaultShell(noPowerShell);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.shell.kind, "cmd");
  }
  // Nothing at all is a typed failure, not a guess.
  const bare = resolveDefaultShell(surface({ platform: "win32" }));
  assert.equal(bare.ok, false);
  if (!bare.ok) {
    assert.equal(bare.code, "no_shell_available");
  }
});

test("the command string reaches the shell as one argument, unquoted", () => {
  const bash = { kind: "bash", path: "/bin/bash" } as const;
  // `&&`, a pipe, a redirection and a substitution have to arrive as the author
  // wrote them: a second quoting layer would reinterpret them, and every
  // construct it mangles is a bug report instead of a command.
  assert.deepEqual(shellExecArgv(bash, "a && b | c > d"), ["/bin/bash", "-c", "a && b | c > d"]);
  assert.deepEqual(shellExecArgv({ kind: "zsh", path: "/bin/zsh" }, "x"), ["/bin/zsh", "-c", "x"]);
  assert.deepEqual(shellExecArgv({ kind: "sh", path: "/bin/sh" }, "x"), ["/bin/sh", "-c", "x"]);
});

test("PowerShell gets -NoProfile -NonInteractive and the exit-code tail", () => {
  const argv = shellExecArgv({ kind: "powershell", path: "pwsh.exe" }, "Write-Output hi");
  assert.equal(argv[0], "pwsh.exe");
  assert.equal(argv[1], "-NoProfile");
  assert.equal(argv[2], "-NonInteractive");
  assert.equal(argv[3], "-Command");
  // Text is between the UTF-8 setup and the exit-code tail, unchanged.
  const command = argv[4] ?? "";
  assert.equal(command.includes("\nWrite-Output hi"), true);
  assert.equal(command.startsWith("[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = "), true);
  assert.equal(command.endsWith(POWERSHELL_EXIT_TAIL), true);
  // `-NoProfile` keeps a user's aliases out of a command the model wrote;
  // `-NonInteractive` stops an asking script from hanging until the timeout.
  assert.equal(command.includes("$PROFILE"), false);
});

test("cmd gets /d so AutoRun state is not inherited", () => {
  assert.deepEqual(shellExecArgv({ kind: "cmd", path: "cmd.exe" }, "echo a && echo b"), [
    "cmd.exe",
    "/d",
    "/c",
    "echo a && echo b",
  ]);
});

/**
 * MEASURED (win32, PowerShell 5.1): `cmd /c exit 4; Write-Output after` exits
 * **0** without the tail and **4** with it. This is why the tail exists, and
 * why it is not optional polish: without it a failed native command is reported
 * to the model as success.
 */
test("the PowerShell tail reads $LASTEXITCODE before $?", () => {
  assert.match(POWERSHELL_EXIT_TAIL, /\$LASTEXITCODE/);
  // `$LASTEXITCODE` is consulted first, and `exit` is what makes the value the
  // process's exit status — PowerShell does not otherwise propagate it upward.
  const lastExitAt = POWERSHELL_EXIT_TAIL.indexOf("$LASTEXITCODE");
  const questionAt = POWERSHELL_EXIT_TAIL.indexOf("$?");
  assert.equal(lastExitAt < questionAt, true, "tail must read $LASTEXITCODE before $?");
  assert.match(POWERSHELL_EXIT_TAIL, /exit \$_ec/);
});

/**
 * MEASURED (win32, this machine, both spellings):
 *
 *   cmd.exe       `windowsVerbatimArguments: true`   → `echo "a b" && echo c` works
 *   cmd.exe       default Node quoting              → prints `\"a b\"`, first `&&` lost
 *   powershell    `windowsVerbatimArguments: true`   → `Write-Output "a b"` splits; prints `a\nb`
 *   bash          `windowsVerbatimArguments: true`   → **no output, exit 0**
 *
 * The bash row is why this is not a platform-level flag: verbatim there is a
 * command reported as successful that did nothing at all.
 */
test("verbatim arguments belong to cmd alone", () => {
  assert.equal(needsVerbatimArguments({ kind: "cmd", path: "cmd.exe" }), true);
  assert.equal(needsVerbatimArguments({ kind: "powershell", path: "pwsh.exe" }), false);
  assert.equal(needsVerbatimArguments({ kind: "bash", path: "/bin/bash" }), false);
  assert.equal(needsVerbatimArguments({ kind: "zsh", path: "/bin/zsh" }), false);
  assert.equal(needsVerbatimArguments({ kind: "sh", path: "/bin/sh" }), false);
});
