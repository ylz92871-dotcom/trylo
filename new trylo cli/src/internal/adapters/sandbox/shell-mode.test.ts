import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_SHELL_BINDING } from "../tools/mutating/bindings.js";
import {
  compositionRefusal,
  readShellSetting,
  resolveShellMode,
  shellModeShape,
  type ShellMode,
} from "./shell-mode.js";
import type { ShellEnvironment } from "./shell-detect.js";
import { SHELL_KINDS, isShellKind } from "./shell-detect.js";

/**
 * WP05.1b: the shape of a run that hands its command string to an interpreter.
 *
 * The load-bearing test here is the last one. A `shell` property on `run_shell`
 * was the obvious way to expose this and it was measured and rejected: the
 * property changes `parameters`, `parameters` is what `toolCatalogHash` hashes,
 * and `session-open.ts:90` refuses any session whose stored hash is neither the
 * current one nor a declared-compatible one. So the decision is a per-run
 * setting instead, and this file pins that the tool surface did not move.
 */

function surface(overrides: Partial<ShellEnvironment>): ShellEnvironment {
  return { platform: "win32", env: {}, fileExists: () => false, ...overrides };
}

const withBash = surface({
  env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
  fileExists: (candidate) => candidate === "C:\\tools\\bash.EXE",
});

test("an absent setting means no shell, which is the shipped behaviour", () => {
  // undefined = not configured, null = configured with something unusable.
  // Neither is a reason to start interpreting commands.
  assert.equal(readShellSetting(undefined), undefined);
  assert.equal(readShellSetting(null), undefined);
});

test("a setting that is not a shell name is refused, not guessed at", () => {
  // `shell: ""` expresses an intent this cannot honour. Falling back to a
  // default would run the command under an interpreter the user did not pick.
  assert.equal(readShellSetting(""), null);
  assert.equal(readShellSetting("fish"), null);
  assert.equal(readShellSetting(7), null);
  assert.equal(readShellSetting({}), null);
  assert.equal(readShellSetting("bash"), "bash");
  assert.equal(readShellSetting("powershell"), "powershell");
});

test("no setting resolves to the platform's own shell", () => {
  const win = resolveShellMode(withBash, undefined);
  assert.equal(win.ok, false, "the fixture has no PowerShell, and that is the answer");
  if (!win.ok) {
    assert.equal(win.code, "shell_not_installed");
  }
  const withPowerShell = surface({
    env: { PATH: "C:\\ps", PATHEXT: ".EXE" },
    fileExists: (candidate) => candidate === "C:\\ps\\powershell.EXE",
  });
  const resolved = resolveShellMode(withPowerShell, undefined);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.mode.kind, "shell");
  }
});

test("a named shell that is absent fails with its name, never substituted", () => {
  const result = resolveShellMode(withBash, "zsh");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "shell_not_installed");
    assert.match(result.message, /zsh/);
  }
});

test("a named shell is resolved on this machine, not assumed", () => {
  const result = resolveShellMode(withBash, "bash");
  assert.equal(result.ok, true);
  if (result.ok && result.mode.kind === "shell") {
    assert.equal(result.mode.shell.kind, "bash");
    assert.equal(result.mode.shell.path, "C:\\tools\\bash.EXE");
  }
});

test("no-shell mode produces the existing direct shape, unchanged", () => {
  const none: ShellMode = { kind: "none" };
  // Byte-identical to what `shapeCommand` gives a plain argv today: the flag-off
  // run must not be able to tell that this module exists.
  assert.deepEqual(shellModeShape(none, "node -v"), { kind: "direct", argv: ["node -v"] });
});

test("shell mode puts the whole command in one argv element", () => {
  const mode: ShellMode = { kind: "shell", shell: { kind: "bash", path: "/bin/bash" } };
  const shape = shellModeShape(mode, "echo a && echo b > out.txt");
  assert.equal(shape.kind, "direct");
  // One element, unquoted: the interpreter parses it, so a second quoting layer
  // would reinterpret every operator instead of preserving it.
  assert.deepEqual(shape.argv, ["/bin/bash", "-c", "echo a && echo b > out.txt"]);
});

test("steps and pipeTo are refused under a shell rather than double-run", () => {
  // Both are this package's composition — planned and approved per segment.
  // Passing them to an interpreter too would execute a segment under two
  // different admission stories, and the checked one would not be the strict one.
  assert.equal(compositionRefusal(false, false), undefined);
  assert.equal(compositionRefusal(true, false), "shell_mode_rejects_composition");
  assert.equal(compositionRefusal(false, true), "shell_mode_rejects_composition");
  assert.equal(compositionRefusal(true, true), "shell_mode_rejects_composition");
});

/**
 * The measurement that chose the design. `toolCatalogHash` hashes each binding's
 * `parameters`, and `session-open.ts:90` refuses a stored hash that is neither
 * current nor declared compatible — so a new `run_shell` property costs every
 * session recorded before it. Asserted on the real binding rather than on a
 * copy, so a future edit to it turns this red.
 *
 * `runInBackground` (WP06) and `stdoutFile` (terminal repair) are reviewed additions,
 * the reason it is not automatically the thing this test forbids: the cost of a
 * new property is paid by *stored sessions*, so the question is whether those
 * sessions can still be honoured. `session-open.ts:90` has the machinery for it
 * (`compatibleCatalogs` plus `migrate.catalog`), but **nothing in production
 * passes that list yet** — so today a session recorded before this property is
 * refused, and this assertion is recording a debt rather than a permission.
 * stdoutFile saves complete foreground output without changing command parsing;
 * older catalogs still require explicit migrate.catalog, as the real resume
 * receipt records. A `shell` property remains refused, because naming a shell
 * changes what every command means rather than adding an option to one.
 */
test("run_shell keeps interpreter selection out and declares only reviewed additive options", () => {
  const properties = RUN_SHELL_BINDING.parameters.properties as Record<string, unknown>;
  assert.equal(
    Object.hasOwn(properties, "shell"),
    false,
    "a shell property on run_shell changes toolCatalogHash and refuses every older session",
  );
  // The composition arguments are also unchanged, because the shell mode refuses
  // them rather than redefining them. Reviewed additions are listed explicitly
  // so adding a further property still turns this red.
  assert.deepEqual(Object.keys(properties).sort(), [
    "command",
    "cwd",
    "pipeTo",
    "runInBackground",
    "stdoutFile",
    "steps",
    "timeoutMs",
  ]);
  assert.deepEqual(RUN_SHELL_BINDING.parameters.required, ["command"]);
  assert.deepEqual(properties["stdoutFile"] !== undefined && (properties["stdoutFile"] as { type: string }).type, "string");
});

/**
 * The two enumerations of shell names, checked against each other.
 *
 * `SHELL_KINDS` is what this layer can RESOLVE and `SETTINGS_SCHEMA.shell` is
 * what a config file is allowed to SAY. They are written out separately — one is
 * a union of a runtime lookup, the other a closed config set that has to reject
 * a typo — so nothing stops them drifting. Drift is silent and nasty in
 * direction one (a name the schema accepts that no lookup can resolve, which
 * fails at run time with "shell not installed" for a shell this build does not
 * know) and merely cosmetic in the other.
 *
 * Read through the real schema, not a copy, so a new name in one place and not
 * the other turns this red.
 */
test("the settings schema accepts exactly the shell names this layer can resolve", async () => {
  const { SETTINGS_SCHEMA } = await import("../../settings/schema.js");
  const spec = SETTINGS_SCHEMA["shell"];
  assert.notEqual(spec, undefined, "the run-level shell setting is not in the closed set");
  assert.equal(spec?.kind, "enum", "shell must stay an enum so a typo is refused, not looked up");
  if (spec?.kind !== "enum") {
    return;
  }
  assert.deepEqual([...spec.members].sort(), [...SHELL_KINDS].sort());
  // And every name the schema admits is one this layer will resolve rather than
  // treat as a typo, so the two directions cannot drift apart silently.
  for (const name of spec.members) {
    assert.equal(isShellKind(name), true, `${name} is accepted by settings but unknown here`);
  }
});

/**
 * The setting is not a packaged default, so a build that never asked for an
 * interpreter does not get one in front of every command. Asserted here as well
 * as in the settings suite because the consequence of forgetting is this
 * layer's: commands would be read by a shell nobody chose.
 */
test("no packaged default puts an interpreter in front of an ordinary run", async () => {
  const { PACKAGED_DEFAULTS } = await import("../../settings/schema.js");
  assert.equal(Object.hasOwn(PACKAGED_DEFAULTS, "shell"), false);
  // What that means at this layer is a TWO-step contract, and stating only half
  // of it would hide the trap: `readShellSetting` answers "was one asked for"
  // and `resolveShellMode` answers "which one", so an unset setting resolves a
  // shell (the platform's) and it is the CALLER that must not call it. The
  // pairing below is the run as it must actually be written.
  const requested = readShellSetting(undefined);
  assert.equal(requested, undefined, "unset must be distinguishable from a bad value");
  const mode: ShellMode = requested === undefined ? { kind: "none" } : resolveOrFail(requested);
  assert.deepEqual(mode, { kind: "none" });
  assert.deepEqual(shellModeShape(mode, "echo hi"), { kind: "direct", argv: ["echo hi"] });
});

/** The other half of the pairing above: only reached when a shell WAS asked for. */
function resolveOrFail(requested: NonNullable<ReturnType<typeof readShellSetting>>): ShellMode {
  const resolved = resolveShellMode(withBash, requested);
  assert.equal(resolved.ok, true, "the fixture has bash, so a named bash must resolve");
  if (!resolved.ok) {
    throw new Error("unreachable");
  }
  return resolved.mode;
}
