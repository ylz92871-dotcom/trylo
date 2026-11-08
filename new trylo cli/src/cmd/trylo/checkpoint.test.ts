import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createFileCheckpointStore } from "../../internal/adapters/checkpoint/store.js";

/**
 * `trylo checkpoint` child-process contract (WP E 波 §6.2, 反方 #23–#25).
 *
 * The real binary is used because undo is only undo if it puts bytes back on
 * disk: a fake store would prove the handler calls a method, not that a person
 * can recover their file. The snapshot is taken in-process with the shipping
 * store so the fixture is a real snapshot, and the CLI is then asked to list
 * and restore it through the same roots the run uses.
 *
 * `TRYLO_HOME` points at the fixture, so nothing here touches a real profile.
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly note: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-checkpoint-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  const note = join(workspace, "note.txt");

  writeFileSync(note, "BEFORE-CONTENT", "utf8");

  return { workspace, home, note, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(fx: Fixture, args: readonly string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: fx.home };

  delete env.TRYLO_API_KEY;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The same roots the run uses: workspace = cwd, storage = $TRYLO_HOME/checkpoints. */
function store(fx: Fixture) {
  return createFileCheckpointStore({
    workspaceRoot: fx.workspace,
    storageRoot: join(fx.home, "checkpoints"),
  });
}

async function takeSnapshot(fx: Fixture): Promise<string> {
  const taken = await store(fx).snapshot({
    workspaceRoot: fx.workspace,
    label: "before:echo",
    createdAt: "2026-09-16T00:00:00.000Z",
  });
  if (!taken.ok) {
    throw new Error(`fixture snapshot failed: ${taken.code} ${taken.detail}`);
  }

  return taken.value.checkpointId;
}

test("反方 #23 — a snapshot taken by the run is listed by the CLI", async () => {
  const fx = fixture();
  try {
    const id = await takeSnapshot(fx);
    const listed = run(fx, ["checkpoint", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const parsed = JSON.parse(listed.stdout) as ReadonlyArray<{ checkpointId: string }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.checkpointId, id);
  } finally {
    fx.cleanup();
  }
});

test("反方 #24 — restore puts the file back and reports what it touched", async () => {
  const fx = fixture();
  try {
    const id = await takeSnapshot(fx);

    writeFileSync(fx.note, "AFTER-CONTENT", "utf8");

    const restored = run(fx, ["checkpoint", "restore", id]);

    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(fx.note, "utf8"), "BEFORE-CONTENT");
    assert.match(restored.stdout, new RegExp(`restored ${id}`));
  } finally {
    fx.cleanup();
  }
});

test("反方 #25 — restore is never automatic: an unknown id fails closed", async () => {
  const fx = fixture();
  try {
    await takeSnapshot(fx);
    writeFileSync(fx.note, "AFTER-CONTENT", "utf8");

    const missing = run(fx, ["checkpoint", "restore", "cp-does-not-exist"]);

    // 52: a store that cannot answer is a configuration problem, not a crash.
    assert.equal(missing.status, 52, missing.stderr);
    // The failed restore changed nothing: failing closed means the text stays.
    assert.equal(readFileSync(fx.note, "utf8"), "AFTER-CONTENT");
  } finally {
    fx.cleanup();
  }
});

test("a restore with no id is a usage error, not a guess at the newest one", () => {
  const fx = fixture();
  try {
    const bare = run(fx, ["checkpoint", "restore"]);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /checkpoint id/);
  } finally {
    fx.cleanup();
  }
});
