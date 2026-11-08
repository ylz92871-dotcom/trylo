import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileCheckpointStore } from "../../adapters/checkpoint/store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint } from "../../ports/session.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { handleCheckpointDiff, handleDiff, handleReview } from "./commands-review.js";
import { handleSessionReview } from "./commands-session-review.js";
import { handleCheckpointRestore } from "./commands-checkpoint.js";
import type { CliContext } from "./context.js";
import type { GitCommandResult } from "./git-diff.js";

/**
 * WP11 handlers: `diff`, `review`, `checkpoint diff`, `session review`.
 *
 * Red evidence: the handlers did not exist before WP11. Behavioural red was
 * shown twice: pointing the scripted git at exit 2 makes `handleDiff`
 * report failure instead of printing, and snapshotting *after* the workspace
 * edit makes `handleCheckpointDiff` report identical instead of `M`.
 */

const FINGERPRINT: RuntimeFingerprint = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "default",
  toolCatalogHash: "catalog",
  workspaceId: "workspace",
};

function scriptedGit(script: ReadonlyArray<GitCommandResult>) {
  let index = 0;
  const seen: string[][] = [];

  return {
    seen,
    runner: {
      async run(argv: ReadonlyArray<string>): Promise<GitCommandResult> {
        seen.push([...argv]);
        const next = script[index];

        index += 1;

        if (next === undefined) {
          throw new Error("no scripted git response left");
        }

        return next;
      },
    },
  };
}

function contextOf(home: string, cwd: string, stdinText = ""): { ctx: CliContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,

    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => stdinText,
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, err };
}

test("handleDiff prints the workspace diff and names non-repos", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-diff-"));
  try {
    const { ctx, out } = contextOf(join(root, "home"), join(root, "work"));
    const git = scriptedGit([
      { exit: 0, stdout: "", stderr: "" },
      { exit: 1, stdout: "", stderr: "" },
      { exit: 1, stdout: "--- a/f.ts\n", stderr: "" },
      { exit: 0, stdout: "", stderr: "" },
    ]);
    const code = await handleDiff(ctx, { json: false }, { runner: git.runner });

    assert.equal(code, EXIT_CODES.OK);
    assert.match(out.join(""), /--- a\/f\.ts/);

    const outside = scriptedGit([{ exit: 128, stdout: "", stderr: "nope" }]);
    const { ctx: ctx2, out: out2 } = contextOf(join(root, "home"), join(root, "work"));
    const code2 = await handleDiff(ctx2, { json: false }, { runner: outside.runner });

    assert.equal(code2, EXIT_CODES.OK);
    assert.match(out2.join(""), /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleDiff reports git failures instead of printing", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-diff-fail-"));
  try {
    const { ctx } = contextOf(join(root, "home"), join(root, "work"));
    const git = scriptedGit([
      { exit: 0, stdout: "", stderr: "" },
      { exit: 1, stdout: "", stderr: "" },
      { exit: 2, stdout: "", stderr: "boom" },
    ]);
    const code = await handleDiff(ctx, { json: false }, { runner: git.runner });

    assert.notEqual(code, EXIT_CODES.OK);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleReview resolves the target and attaches the uncommitted diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-cmd-"));
  try {
    const { ctx, out } = contextOf(join(root, "home"), join(root, "work"));
    const git = scriptedGit([
      { exit: 0, stdout: "", stderr: "" },
      { exit: 1, stdout: "", stderr: "" },
      { exit: 1, stdout: "--- a/f.ts\n", stderr: "" },
      { exit: 0, stdout: "", stderr: "" },
    ]);
    const code = await handleReview(ctx, { uncommitted: true, json: false }, { runner: git.runner });

    assert.equal(code, EXIT_CODES.OK);
    const said = out.join("");

    assert.match(said, /reviewing current changes/);
    assert.match(said, /staged, unstaged, and untracked files/);
    assert.match(said, /--- a\/f\.ts/);
    assert.match(said, /findings, not fixes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleReview refuses conflicting targets as usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-conflict-"));
  try {
    const { ctx } = contextOf(join(root, "home"), join(root, "work"));
    const code = await handleReview(ctx, { uncommitted: true, base: "main", json: false });
    assert.equal(code, EXIT_CODES.USAGE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleReview reads a lone dash prompt from stdin (F6)", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-stdin-"));
  try {
    const { ctx, out } = contextOf(join(root, "home"), join(root, "work"), "check the auth flow");
    // A custom prompt reviews without git: no git calls happen at all.
    const voidRunner = scriptedGit([]);
    const code = await handleReview(
      ctx,
      { uncommitted: false, promptFromStdin: true, json: false },
      { runner: voidRunner.runner },
    );

    assert.equal(code, EXIT_CODES.OK);
    assert.match(out.join(""), /check the auth flow/);
    assert.deepEqual(voidRunner.seen.length, 0);

    const { ctx: emptyCtx } = contextOf(join(root, "home"), join(root, "work"), "   ");
    const empty = await handleReview(emptyCtx, { uncommitted: false, promptFromStdin: true, json: false });

    assert.equal(empty, EXIT_CODES.USAGE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F3 scoped restore rewinds in scope and keeps user files", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-scoped-"));
  const home = join(root, "home");
  const workspace = join(root, "work");
  const storage = join(home, ".trylo", "checkpoints");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(storage, { recursive: true });

  try {
    writeFileSync(join(workspace, "task.ts"), "before", "utf8");
    const store = createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage });
    const snap = await store.snapshot({ workspaceRoot: workspace, label: "before:write", createdAt: "2026-10-05T00:00:00.000Z" });

    assert.equal(snap.ok, true);

    if (!snap.ok) {
      return;
    }

    const id = snap.value.checkpointId;

    writeFileSync(join(workspace, "task.ts"), "after", "utf8");
    writeFileSync(join(workspace, "mine.txt"), "user file", "utf8");
    const { ctx, out } = contextOf(home, workspace);
    const code = await handleCheckpointRestore(ctx, { checkpointId: id, only: ["task.ts"], json: false });

    assert.equal(code, EXIT_CODES.OK);
    assert.match(out.join(""), /scoped to 1 path/);
    assert.equal(readFileSync(join(workspace, "task.ts"), "utf8"), "before");
    assert.equal(readFileSync(join(workspace, "mine.txt"), "utf8"), "user file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F3 the legacy restore warns when it deletes post-snapshot files", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-legacy-warn-"));
  const home = join(root, "home");
  const workspace = join(root, "work");
  const storage = join(home, ".trylo", "checkpoints");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(storage, { recursive: true });

  try {
    writeFileSync(join(workspace, "task.ts"), "before", "utf8");
    const store = createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage });
    const snap = await store.snapshot({ workspaceRoot: workspace, label: "before:write", createdAt: "2026-10-05T00:00:00.000Z" });

    assert.equal(snap.ok, true);

    if (!snap.ok) {
      return;
    }

    writeFileSync(join(workspace, "mine.txt"), "user file", "utf8");
    const { ctx, err } = contextOf(home, workspace);
    const code = await handleCheckpointRestore(ctx, { checkpointId: snap.value.checkpointId, json: false });

    assert.equal(code, EXIT_CODES.OK);
    assert.match(err.join(""), /warning: restore removed 1 file\(s\)/);
    assert.match(err.join(""), /--only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleCheckpointDiff shows what a restore would change", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-cpdiff-"));
  const home = join(root, "home");
  const workspace = join(root, "work");
  const storage = join(home, ".trylo", "checkpoints");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(storage, { recursive: true });

  try {
    writeFileSync(join(workspace, "a.ts"), "before", "utf8");
    const store = createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage });
    const snap = await store.snapshot({ workspaceRoot: workspace, label: "before:apply_patch", createdAt: "2026-10-05T00:00:00.000Z" });

    assert.equal(snap.ok, true);

    if (!snap.ok) {
      return;
    }

    writeFileSync(join(workspace, "a.ts"), "after", "utf8");
    writeFileSync(join(workspace, "mine.ts"), "user file", "utf8");
    const { ctx, out } = contextOf(home, workspace);
    const code = await handleCheckpointDiff(ctx, { checkpointId: snap.value.checkpointId, json: false });

    assert.equal(code, EXIT_CODES.OK);
    const said = out.join("");

    assert.match(said, /M a\.ts/);
    assert.match(said, /A mine\.ts/);

    const { ctx: ctx2, out: out2 } = contextOf(home, workspace);
    const missing = await handleCheckpointDiff(ctx2, { checkpointId: "cp-nope", json: false });

    assert.equal(missing, EXIT_CODES.CONFIG);
    assert.equal(out2.join(""), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handleSessionReview shows one turn and its rollback path", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-review-session-"));
  const home = join(root, "home");
  const sessions = join(home, ".trylo", "sessions");

  mkdirSync(sessions, { recursive: true });
  const sessionId = "wp11-test";

  try {
    const store = createNdjsonSessionStore({ path: join(sessions, `${sessionId}.ndjson`) });
    const started = await store.start({ sessionId, createdAt: "2026-10-05T00:00:00.000Z", fingerprint: FINGERPRINT });

    assert.equal(started.ok, true);
    const turnId = "turn-1";
    const appended = await store.append({
      type: "transcript_item",
      sessionId,
      turnId,
      at: "2026-10-05T00:00:01.000Z",
      payload: { kind: "user", sequence: 0, text: "fix it" },
    });

    assert.equal(appended.ok, true);
    const failed = await store.append({
      type: "transcript_item",
      sessionId,
      turnId,
      at: "2026-10-05T00:00:02.000Z",
      payload: {
        kind: "tool_result",
        sequence: 1,
        toolCallId: "c1",
        name: "apply_patch",
        output: "patch_hunk_mismatch",
        truncated: false,
        outcome: "failed",
      },
    });

    assert.equal(failed.ok, true);
    await store.release();

    const { ctx, out } = contextOf(home, join(root, "work"));
    const code = await handleSessionReview(ctx, { session: sessionId, json: false });

    assert.equal(code, EXIT_CODES.OK);
    const said = out.join("");

    assert.match(said, /turn turn-1/);
    assert.match(said, /failed/);
    assert.match(said, /session fork/);

    const { ctx: ctx2, out: out2 } = contextOf(home, join(root, "work"));
    const coded = await handleSessionReview(ctx2, { session: sessionId, message: 1, json: true });

    assert.equal(coded, EXIT_CODES.OK);
    const parsed = JSON.parse(out2.join("")) as { turn: { turnId: string } };

    assert.equal(parsed.turn.turnId, "turn-1");

    const { ctx: ctx3 } = contextOf(home, join(root, "work"));
    const missing = await handleSessionReview(ctx3, { session: sessionId, turn: "turn-nope", json: false });

    assert.equal(missing, EXIT_CODES.CONFIG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
