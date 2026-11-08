import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { COMPLETION_SHELLS, completionScript, isCompletionShell, parseCompletion } from "./completion.js";

/**
 * Completion contract (WP C 波 §4.1, 反方 #13).
 *
 * The promise is that completion is *context-free*: same bytes on a TTY and in a
 * pipe, with a good config, a broken config or no config at all. So the live
 * cases deliberately run the binary with stdin closed and an unusable
 * `config.json` in the workspace — if completion ever consulted either, it would
 * fail here.
 */

const cli = fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url));

function workspace(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-completion-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    // stdin closed: completion must not care whether it is talking to a person.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("each supported shell gets a non-empty script naming that shell's hook", () => {
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    assert.equal(script.length > 0, true, shell);
    assert.equal(script.endsWith("\n"), true, `${shell} script must end with a newline`);
    const marker = shell === "bash" ? "complete -F" : shell === "zsh" ? "#compdef" : "complete -c trylo";
    assert.equal(script.includes(marker), true, `${shell} script is missing ${marker}`);
  }
});

test("the command list is the same in every dialect", () => {
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    for (const command of ["run", "mcp", "config", "completion"]) {
      assert.equal(script.includes(command), true, `${shell} is missing ${command}`);
    }
  }
});

test("attack #13: completion is byte-identical with a broken config and no tty", () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws.dir, ".trylo"), { recursive: true });
    writeFileSync(join(ws.dir, ".trylo", "config.json"), "{ not json");
    const first = run(["completion", "bash"], ws.dir);
    const second = run(["completion", "bash"], ws.dir);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stdout, completionScript("bash"));
    assert.equal(first.stderr, "");
  } finally {
    ws.cleanup();
  }
});

test("an unknown shell is a usage error, never an empty stdout", () => {
  const ws = workspace();
  try {
    const result = run(["completion", "powershell"], ws.dir);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unknown shell/);
    const bare = run(["completion"], ws.dir);

    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /requires a shell/);
  } finally {
    ws.cleanup();
  }
});

test("the parser accepts each shell and refuses anything else", () => {
  for (const shell of COMPLETION_SHELLS) {
    const parsed = parseCompletion([shell]);
    assert.equal(parsed.kind, "completion");
    if (parsed.kind === "completion") {
      assert.equal(parsed.shell, shell);
    }
  }

  assert.equal(isCompletionShell("bash"), true);
  assert.equal(isCompletionShell("csh"), false);
  assert.equal(parseCompletion(["bash", "zsh"]).kind, "error");
  assert.equal(parseCompletion([]).kind, "error");
});
