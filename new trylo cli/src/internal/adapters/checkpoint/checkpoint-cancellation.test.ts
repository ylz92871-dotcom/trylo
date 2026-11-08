import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { testScratchPath } from "../../testing/scratch.js";
import { createFileCheckpointStore } from "./store.js";
import { takeSnapshot } from "./snapshot.js";
import { storePaths } from "./support.js";

test("snapshot yields to control input and cancellation never publishes a checkpoint", async () => {
  const scratch = testScratchPath("checkpoint-control");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "checkpoint-control-"));
  const workspace = path.join(root, "workspace"),
    storage = path.join(root, "storage");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "work.txt"), "unchanged");
  const controller = new AbortController();
  try {
    const store = createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage });
    let completed = false;
    const operation = store
      .snapshot({
        workspaceRoot: workspace,
        label: "before:edit_file",
        createdAt: "2026-11-09T00:00:00Z",
        signal: controller.signal,
      })
      .then((result) => {
        completed = true;
        return result;
      });
    let completedBeforeControl = false;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        completedBeforeControl = completed;
        controller.abort();
        resolve();
      }),
    );
    const result = await operation;
    assert.equal(completedBeforeControl, false, "synchronous checkpoint IO blocked the control reader");
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(workspace, "work.txt"), "utf8"), "unchanged");
    assert.deepEqual(fs.readdirSync(storage), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent snapshot preparations own distinct recoverable directories", async () => {
  const parent = testScratchPath("checkpoint-concurrent");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const workspace = path.join(root, "workspace"),
    storage = path.join(root, "storage");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "work.txt"), "unchanged");
  try {
    const options = { workspaceRoot: workspace, storageRoot: storage };
    const input = { workspaceRoot: workspace, label: "same-label", createdAt: "fixture" };
    const [one, two] = await Promise.all([
      createFileCheckpointStore(options).snapshot(input),
      createFileCheckpointStore(options).snapshot(input),
    ]);
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    if (one.ok && two.ok) {
      assert.notEqual(one.value.checkpointId, two.value.checkpointId);
      const listed = await createFileCheckpointStore(options).list();
      assert.equal(listed.ok, true);
      if (listed.ok) assert.equal(listed.value.length, 2);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a removed incomplete checkpoint never lets a later snapshot overwrite a surviving id", async () => {
  const parent = testScratchPath("checkpoint-id-gap");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const workspace = path.join(root, "workspace"),
    storage = path.join(root, "storage");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "work.txt"), "unchanged");
  try {
    const store = createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage });
    const input = { workspaceRoot: workspace, label: "same-label", createdAt: "fixture" };
    const one = await store.snapshot(input),
      two = await store.snapshot(input),
      three = await store.snapshot(input);
    assert.equal(one.ok && two.ok && three.ok, true);
    if (!two.ok || !three.ok) return;
    const preserved = path.join(storage, three.value.checkpointId, "manifest.json");
    const original = fs.readFileSync(preserved);
    fs.rmSync(path.join(storage, two.value.checkpointId), { recursive: true });
    const next = await store.snapshot({ ...input, createdAt: "later" });
    assert.equal(next.ok, true);
    if (next.ok) assert.notEqual(next.value.checkpointId, three.value.checkpointId);
    assert.deepEqual(fs.readFileSync(preserved), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file changed after enumeration still produces a verifiable undo checkpoint", async () => {
  const parent = testScratchPath("checkpoint-changed-source");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const workspace = path.join(root, "workspace"),
    storage = path.join(root, "storage");
  fs.mkdirSync(workspace);
  fs.mkdirSync(storage);
  const source = path.join(workspace, "work.txt");
  fs.writeFileSync(source, "old");
  const enumeratedBytes = fs.statSync(source).size;
  fs.writeFileSync(source, "changed before the asynchronous copy");
  try {
    const input = {
      paths: storePaths(storage),
      checkpointId: "cp-0001-changed",
      label: "changed",
      createdAt: "2026-11-09T00:00:00Z",
      files: [{ absolutePath: source, relativePath: "work.txt", bytes: enumeratedBytes }],
      ignoredNames: [],
      maxFiles: 10,
      maxTotalBytes: 1024,
    };
    const captured = await takeSnapshot(input);
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    const stored = path.join(storage, captured.value.checkpointId, "files/work.txt");
    assert.equal(captured.value.manifest.files[0]?.bytes, fs.statSync(stored).size);
    const original = fs.readFileSync(stored);
    fs.writeFileSync(source, "later user edit");
    const restored = await createFileCheckpointStore({
      workspaceRoot: workspace,
      storageRoot: storage,
    }).restore({ checkpointId: captured.value.checkpointId });
    assert.equal(restored.ok, true);
    assert.deepEqual(fs.readFileSync(source), original);
    const grownBeyondAllowance = await takeSnapshot({ ...input, maxTotalBytes: 8 });
    assert.equal(grownBeyondAllowance.ok, false);
    if (!grownBeyondAllowance.ok) assert.equal(grownBeyondAllowance.code, "size_limit_exceeded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
