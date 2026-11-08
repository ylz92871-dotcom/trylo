import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileCheckpointStore } from "../../adapters/checkpoint/store.js";
import { manifestRows, readCurrentRows, readManifest } from "./checkpoint-workspace.js";

/**
 * WP11/F12: the shared checkpoint reads.
 *
 * Red evidence: new module (import fails pre-remedy). The ignore-set case
 * pins F12: reading under `ignoreSet([])` instead of the manifest's own set
 * reports the excluded directory as added — the diff would promise files
 * the restore never touches.
 */

function world(ignores?: ReadonlyArray<string>) {
  const root = mkdtempSync(join(tmpdir(), "trylo-ckpt-ws-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "checkpoints");

  mkdirSync(join(workspace, "skipme"), { recursive: true });
  writeFileSync(join(workspace, "keep.ts"), "keep", "utf8");
  writeFileSync(join(workspace, "skipme", "inner.ts"), "inner", "utf8");

  return {
    root,
    workspace,
    storage,
    store: createFileCheckpointStore({
      workspaceRoot: workspace,
      storageRoot: storage,
      ...(ignores === undefined ? {} : { ignores }),
    }),
  };
}

test("readManifest validates the embedded checkpoint id", async () => {
  const fx = world();
  try {
    const taken = await fx.store.snapshot({
      workspaceRoot: fx.workspace,
      label: "before:x",
      createdAt: "2026-10-05T00:00:00.000Z",
    });

    assert.equal(taken.ok, true);

    if (!taken.ok) {
      return;
    }

    const id = taken.value.checkpointId;
    const read = readManifest(fx.storage, id);

    assert.equal(read.ok, true);
    cpSync(join(fx.storage, id), join(fx.storage, "cp-forged"), { recursive: true });
    const forged = readManifest(fx.storage, "cp-forged");

    assert.equal(forged.ok, false);

    if (!forged.ok) {
      assert.equal(forged.code, "checkpoint_id_mismatch");
    }

    const missing = readManifest(fx.storage, "cp-nope");

    assert.equal(missing.ok, false);

    if (!missing.ok) {
      assert.equal(missing.code, "checkpoint_not_found");
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("readCurrentRows honours the manifest ignore set, not a default", async () => {
  const fx = world(["skipme"]);
  try {
    const taken = await fx.store.snapshot({
      workspaceRoot: fx.workspace,
      label: "before:x",
      createdAt: "2026-10-05T00:00:00.000Z",
    });

    assert.equal(taken.ok, true);

    if (!taken.ok) {
      return;
    }

    const manifest = readManifest(fx.storage, taken.value.checkpointId);

    assert.equal(manifest.ok, true);

    if (!manifest.ok) {
      return;
    }

    assert.ok(manifest.manifest.ignores.includes("skipme"));
    assert.deepEqual(manifestRows(manifest.manifest).map((row) => row.path), ["keep.ts"]);
    const current = readCurrentRows(fx.workspace, manifest.manifest.ignores);

    assert.equal(current.ok, true);

    if (!current.ok) {
      return;
    }

    assert.deepEqual(current.rows.map((row) => row.path), ["keep.ts"]);
    assert.deepEqual(current.unreadable, []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
