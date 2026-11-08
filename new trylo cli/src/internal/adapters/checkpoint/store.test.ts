import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasDisclosureRisk } from "../../compaction/disclosure.js";
import type { CheckpointPort } from "../../ports/checkpoint.js";
import { createFileCheckpointStore } from "./store.js";

/**
 * Workspace checkpointing against a real disk.
 *
 * No in-memory stand-in for `restore`: the invariant under test is that bytes on
 * a filesystem move back to where they were, so a fake could satisfy every
 * assertion while restoring nothing.
 */

type Fixture = {
  readonly root: string;
  readonly workspace: string;
  readonly storage: string;
  readonly store: CheckpointPort;
};

const CREATED_AT = "2026-09-14T00:00:00.000Z";

function fixture(options: { readonly storageInside?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-checkpoint-"));
  const workspace = join(root, "workspace");
  const storage = options.storageInside === true ? join(workspace, "storage") : join(root, "storage");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(storage, { recursive: true });

  return {
    root,
    workspace,
    storage,
    store: createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage }),
  };
}

function file(workspace: string, relativePath: string, content: string): void {
  const parts = relativePath.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) {
    mkdirSync(join(workspace, ...parts.slice(0, depth)), { recursive: true });
  }
  writeFileSync(join(workspace, ...parts), content, "utf8");
}

function read(workspace: string, relativePath: string): string {
  return readFileSync(join(workspace, ...relativePath.split("/")), "utf8");
}

function populate(workspace: string): void {
  file(workspace, "README.md", "# project");
  file(workspace, "src/index.ts", "export const version = 1;");
  file(workspace, "src/deep/nested/util.ts", "export const util = true;");
  file(workspace, "node_modules/left-pad/index.js", "module.exports = () => '';");
  file(workspace, ".git/config", "[core]");
}

test("a snapshot records every workspace file and none of the ignored ones", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const outcome = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before edits", createdAt: CREATED_AT });

    assert.equal(outcome.ok, true);

    if (outcome.ok) {
      assert.equal(outcome.value.manifest.fileCount, 3);
      assert.deepEqual(
        outcome.value.manifest.files.map((entry) => entry.path),
        ["README.md", "src/deep/nested/util.ts", "src/index.ts"],
      );
      assert.ok(outcome.value.manifest.ignores.includes("node_modules"));
      assert.ok(outcome.value.manifest.ignores.includes(".git"));
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("extra ignore rules are recorded and honoured", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-checkpoint-"));
  try {
    const workspace = join(root, "workspace");
    const storage = join(root, "storage");

    mkdirSync(join(workspace, "sessions"), { recursive: true });
    mkdirSync(storage, { recursive: true });
    file(workspace, "keep.txt", "keep");
    file(workspace, "sessions/demo.ndjson", "journal line");
    const store = createFileCheckpointStore({
      workspaceRoot: workspace,
      storageRoot: storage,
      ignores: ["sessions"],
    });
    const outcome = await store.snapshot({ workspaceRoot: workspace, label: "ignoring sessions", createdAt: CREATED_AT });

    assert.equal(outcome.ok, true);

    if (outcome.ok) {
      assert.deepEqual(outcome.value.manifest.files.map((entry) => entry.path), ["keep.txt"]);
      assert.ok(outcome.value.manifest.ignores.includes("sessions"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ids are derived from what exists rather than from a clock or a coin", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const first = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "one", createdAt: CREATED_AT });
    const second = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "two", createdAt: CREATED_AT });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    if (first.ok && second.ok) {
      assert.equal(first.value.checkpointId, "cp-0001-one");
      assert.equal(second.value.checkpointId, "cp-0002-two");
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("restore brings back a file deleted after the snapshot", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before delete", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    rmSync(join(fix.workspace, "src", "index.ts"), { force: true });
    assert.equal(existsSync(join(fix.workspace, "src", "index.ts")), false);

    const restored = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, true);

    if (restored.ok) {
      assert.equal(restored.value.restoredFiles, 3);
    }

    assert.equal(read(fix.workspace, "src/index.ts"), "export const version = 1;");
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("restore removes files created after the snapshot", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before add", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    file(fix.workspace, "src/brand-new.ts", "export const brandNew = true;");
    const restored = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, true);

    if (restored.ok) {
      assert.equal(restored.value.removedFiles, 1);
    }

    assert.equal(existsSync(join(fix.workspace, "src", "brand-new.ts")), false);
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("restore reverts edited content, not just presence", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before edit", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    file(fix.workspace, "src/index.ts", "export const version = 9999;");
    const restored = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, true);
    assert.equal(read(fix.workspace, "src/index.ts"), "export const version = 1;");
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("a tampered stored copy is refused before anything enters the workspace", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before tamper", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    writeFileSync(join(fix.workspace, "src", "index.ts"), "locally edited; must survive a refused restore");
    writeFileSync(join(fix.storage, snapshot.value.checkpointId, "files", "src", "index.ts"), "poisoned by somebody else");

    const restored = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, false);

    if (!restored.ok) {
      assert.equal(restored.code, "checksum_mismatch");
    }

    // Nothing was replaced, nothing was removed: the workspace is untouched.
    assert.equal(read(fix.workspace, "src/index.ts"), "locally edited; must survive a refused restore");
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("a manifest whose digest was not recomputed is refused", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before rewrite", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    const manifestPath = join(fix.storage, snapshot.value.checkpointId, "manifest.json");
    const text = readFileSync(manifestPath, "utf8");

    writeFileSync(manifestPath, text.replace('"fileCount": 3', '"fileCount": 2'));

    const restored = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, false);

    if (!restored.ok) {
      assert.equal(restored.code, "checksum_mismatch");
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("a damaged recovery point is reported by list instead of skipped", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "listed", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    writeFileSync(
      join(fix.storage, snapshot.value.checkpointId, "manifest.json"),
      readFileSync(join(fix.storage, snapshot.value.checkpointId, "manifest.json"), "utf8").replace(
        snapshot.value.manifest.digest,
        "0".repeat(64),
      ),
    );
    const listed = await fix.store.list();

    assert.equal(listed.ok, false);

    if (!listed.ok) {
      assert.equal(listed.code, "checksum_mismatch");
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("list reports the snapshots it holds", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "first", createdAt: CREATED_AT });
    await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "second", createdAt: CREATED_AT });
    const listed = await fix.store.list();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      assert.deepEqual(listed.value.map((entry) => entry.checkpointId), ["cp-0001-first", "cp-0002-second"]);
      assert.equal(listed.value[0]?.fileCount, 3);
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("restore refuses an unknown checkpoint", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const restored = await fix.store.restore({ checkpointId: "cp-9999-nope" });
    assert.equal(restored.ok, false);
    if (!restored.ok) {
      assert.equal(restored.code, "checkpoint_not_found");
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("snapshot refuses a root that is not the configured workspace", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const elsewhere = join(fix.root, "elsewhere");

    mkdirSync(elsewhere, { recursive: true });
    file(elsewhere, "innocent.txt", "not mine");
    const outcome = await fix.store.snapshot({ workspaceRoot: elsewhere, label: "wrong tree", createdAt: CREATED_AT });

    assert.equal(outcome.ok, false);

    if (!outcome.ok) {
      assert.equal(outcome.code, "checkpoint_root_mismatch");
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("snapshot refuses storage nested inside its own subject", async () => {
  const fix = fixture({ storageInside: true });
  try {
    populate(fix.workspace);
    const outcome = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "self nesting", createdAt: CREATED_AT });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, "storage_unavailable");
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("a manifest carries neither absolute paths nor credential shapes", async () => {
  const fix = fixture();
  try {
    file(fix.workspace, "api-key-material.txt", "api_key=abcdef123456");
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "redaction check", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (snapshot.ok) {
      const serialized = JSON.stringify(snapshot.value.manifest);
      assert.equal(hasDisclosureRisk(serialized), false);
      assert.equal(serialized.includes(fix.workspace), false);
    }
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("an interrupted restore reports failure and stays retryable", async () => {
  const fix = fixture();
  try {
    populate(fix.workspace);
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "before obstacle", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    rmSync(join(fix.workspace, "src", "index.ts"), { force: true });
    // Turn the target into a directory: the write step has to fail for real.
    mkdirSync(join(fix.workspace, "src", "index.ts"), { recursive: true });
    const blocked = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(blocked.ok, false);

    if (!blocked.ok) {
      assert.equal(blocked.code, "restore_interrupted");
    }

    rmSync(join(fix.workspace, "src", "index.ts"), { recursive: true, force: true });
    const retried = await fix.store.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(retried.ok, true);
    assert.equal(read(fix.workspace, "src/index.ts"), "export const version = 1;");
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("an empty workspace still produces a usable checkpoint", async () => {
  const fix = fixture();
  try {
    const snapshot = await fix.store.snapshot({ workspaceRoot: fix.workspace, label: "empty", createdAt: CREATED_AT });

    assert.equal(snapshot.ok, true);

    if (snapshot.ok) {
      assert.equal(snapshot.value.manifest.fileCount, 0);
      assert.equal(snapshot.value.manifest.files.length, 0);
    }

    const restored = await fix.store.restore({ checkpointId: "cp-0001-empty" });

    assert.equal(restored.ok, true);

    if (restored.ok) {
      assert.equal(restored.value.restoredFiles, 0);
    }

    assert.equal(readdirSync(fix.workspace).length, 0);
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});
