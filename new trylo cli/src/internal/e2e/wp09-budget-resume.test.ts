import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * WP09.3 — a budget interruption is a stop, not an ending (L06/L07/C37).
 *
 * The acceptance this file pins: a run that a budget stops mid-task leaves
 * durable facts on disk; resuming the same session finishes the task and the
 * journal records a real terminal — not a fresh session that happens to share
 * the id, and not a completed status inferred from a missing stream.
 *
 * Run against the real CLI binary from `dist/`, like the W1 e2e.
 */

const cli = fileURLToPath(new URL("../../cmd/trylo/main.js", import.meta.url));

function spawnCli(home: string, workspace: string, args: ReadonlyArray<string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: home };

  delete env.TRYLO_API_KEY;
  delete env.OPENAI_API_KEY;

  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function journalRows(home: string, sessionId: string): Array<{ readonly type: string; readonly payload: Record<string, unknown> }> {
  const sessionsDir = join(home, "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const file = readdirSync(sessionsDir).find((entry) => entry === `${sessionId}.ndjson`);
  if (file === undefined) {
    return [];
  }

  return readFileSync(join(sessionsDir, file), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { record?: { type?: string; payload?: Record<string, unknown> } })
    .map((row) => {
      const record = row.record ?? { type: "", payload: {} };
      return { type: record.type ?? "", payload: record.payload ?? {} };
    });
}

/** Whether any durable journal record carries the named cause at all. */
function journalNamesCause(home: string, sessionId: string, cause: string): boolean {
  const sessionsDir = join(home, "sessions");
  const file = readdirSync(sessionsDir).find((entry) => entry === `${sessionId}.ndjson`);
  if (file === undefined) {
    return false;
  }
  return readFileSync(join(sessionsDir, file), "utf8").includes(cause);
}

function fixture(): { readonly workspace: string; readonly home: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-wp09-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workspace, ".trylo"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "wp09-budget-resume-fixture", version: "1.0.0" }, null, 2),
    "utf8",
  );

  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a run stopped by its output budget resumes to a real terminal and the task's artifact", () => {
  const fx = fixture();
  try {
    const sessionId = "ses-wp09-resume";
    // `--max-tokens 4` spends itself on the first stream: the fixture reports
    // 8 output tokens, so the turn stops explicitly instead of completing.
    const stopped = spawnCli(fx.home, fx.workspace, [
      "run",
      "perform write before crash",
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--session",
      sessionId,
      "--max-tokens",
      "4",
      "--format",
      "stream-json",
    ]);
    const stoppedText = stopped.stdout + stopped.stderr;

    assert.notEqual(stopped.status, 0, `the budgeted run must not complete: ${stoppedText}`);
    assert.equal(stoppedText.includes("output_tokens_exhausted"), true, "the stop names the budget that caused it");

    // The stop is durable: the journal holds a failed terminal and a record
    // naming the budget that caused it.
    const stoppedRows = journalRows(fx.home, sessionId);
    const stoppedTerminals = stoppedRows.filter((row) => row.type === "terminal");

    assert.equal(stoppedTerminals.length, 1, "exactly one terminal after the stopped run");
    assert.equal(stoppedTerminals[0]?.payload["reason"], "failed");
    assert.equal(
      journalNamesCause(fx.home, sessionId, "output_tokens_exhausted"),
      true,
      "the journal names the budget that stopped the run",
    );

    // Resuming the same session finishes the task and lands a completed turn.
    const resumed = spawnCli(fx.home, fx.workspace, [
      "run",
      "continue the task to the end",
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--resume",
      sessionId,
      "--format",
      "stream-json",
    ]);
    const resumedText = resumed.stdout + resumed.stderr;

    assert.equal(resumed.status, 0, `the resumed run must complete: ${resumedText}`);
    assert.equal(resumedText.includes('"status":"completed"'), true, "the resumed turn completes");

    // The task's artifact is on disk, and the journal holds both the stop and
    // the completion: a resume that only re-printed the session id would fail
    // the artifact and terminal checks, not pass them.
    const written = join(fx.workspace, "fixture-output.txt");

    assert.equal(existsSync(written), true, "the task's file artifact exists after the resume");
    assert.equal(readFileSync(written, "utf8"), "the fixture wrote this line");
    const terminals = journalRows(fx.home, sessionId).filter((row) => row.type === "terminal");

    assert.equal(terminals.length, 2, "the journal keeps the stopped terminal and adds the completed one");
    assert.equal(terminals.at(-1)?.payload["reason"], "completed");
  } finally {
    fx.cleanup();
  }
});

test("a context ceiling that cannot be cleared ends the run explicitly and resumes under its window", () => {
  const fx = fixture();
  try {
    const sessionId = "ses-wp09-context";

    writeFileSync(
      join(fx.workspace, ".trylo", "config.json"),
      JSON.stringify({ contextTokenLimit: 8, inputPricePerMTok: 1 }, null, 2),
      "utf8",
    );
    // A ceiling no window can clear (8 tokens, the tool table alone is larger)
    // must end the turn with an explicit cause, not a hang and not a success.
    const stopped = spawnCli(fx.home, fx.workspace, [
      "run",
      "perform write before crash",
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--session",
      sessionId,
      "--format",
      "stream-json",
    ]);
    const stoppedText = stopped.stdout + stopped.stderr;

    assert.notEqual(stopped.status, 0, `the over-limit run must not complete: ${stoppedText}`);
    assert.equal(stoppedText.includes("context_limit"), true, "the stop names the context ceiling");
    const stoppedRows = journalRows(fx.home, sessionId).filter((row) => row.type === "terminal");

    assert.equal(stoppedRows.at(-1)?.payload["reason"], "failed");
    assert.equal(
      journalNamesCause(fx.home, sessionId, "context_limit"),
      true,
      "the journal names the context ceiling that stopped the run",
    );

    // The resume raises the ceiling and reaches a real terminal; the window
    // the first turn stored (if any) stays the journal's fact either way.
    writeFileSync(
      join(fx.workspace, ".trylo", "config.json"),
      JSON.stringify({ contextTokenLimit: 32000, inputPricePerMTok: 1 }, null, 2),
      "utf8",
    );
    const resumed = spawnCli(fx.home, fx.workspace, [
      "run",
      "continue the task to the end",
      "--provider",
      "fixture-write",
      "--allow-writes",
      "--resume",
      sessionId,
      "--format",
      "stream-json",
    ]);
    const resumedText = resumed.stdout + resumed.stderr;

    assert.equal(resumed.status, 0, `the resumed run must complete: ${resumedText}`);
    const terminals = journalRows(fx.home, sessionId).filter((row) => row.type === "terminal");

    assert.equal(terminals.at(-1)?.payload["reason"], "completed");
  } finally {
    fx.cleanup();
  }
});
