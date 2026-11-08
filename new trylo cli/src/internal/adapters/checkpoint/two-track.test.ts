import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCompactionService } from "../../compaction/service.js";
import { listTranscript } from "../../compaction/projection.js";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint } from "../../ports/session.js";
import { createNdjsonSessionStore } from "../session-store/ndjson.js";
import { createFileCheckpointStore } from "./store.js";

/**
 * A fake loop driving all three ports, which is what the work package defines
 * completion as: it can compress, filter, persist, reload and undo files, with
 * the two undo rails unable to interfere with each other.
 *
 * Nothing here is fake at the storage layer — every file touched in these cases
 * is a real file on disk, because "the rails are independent" is a claim about
 * the filesystem, not about this test's objects.
 */

const service = createCompactionService();

const FINGERPRINT: RuntimeFingerprint = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "default",
  toolCatalogHash: "catalog",
  workspaceId: "workspace",
};

const CREATED_AT = "2026-09-14T00:00:00.000Z";

type World = {
  readonly root: string;
  readonly workspace: string;
  readonly sessionPath: string;
  readonly checkpoints: ReturnType<typeof createFileCheckpointStore>;
};

function world(): World {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-two-track-"));
  const workspace = join(root, "workspace");
  const sessionPath = join(root, "sessions", "demo.ndjson");
  const storage = join(root, "checkpoints");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "original", "utf8");

  return {
    root,
    workspace,
    sessionPath,
    checkpoints: createFileCheckpointStore({ workspaceRoot: workspace, storageRoot: storage }),
  };
}

function noteFile(workspace: string): string {
  return readFileSync(join(workspace, "notes.txt"), "utf8");
}

async function twoMessageSession(sessionPath: string) {
  const store = createNdjsonSessionStore({ path: sessionPath });
  const started = await store.start({ sessionId: "demo", createdAt: CREATED_AT, fingerprint: FINGERPRINT });

  assert.equal(started.ok, true);
  await store.append({
    type: "transcript_item",
    sessionId: "demo",
    turnId: "t1",
    at: CREATED_AT,
    payload: { kind: "user", sequence: 0, text: "read the notes" },
  });
  await store.append({
    type: "transcript_item",
    sessionId: "demo",
    turnId: "t1",
    at: CREATED_AT,
    payload: { kind: "assistant_text", sequence: 1, blockId: "b1", text: "done" },
  });

  return store;
}

test("rolling back the transcript leaves the workspace exactly as it was", async () => {
  const place = world();
  try {
    const store = await twoMessageSession(place.sessionPath);
    const snapshot = await place.checkpoints.snapshot({
      workspaceRoot: place.workspace,
      label: "before the turn",
      createdAt: CREATED_AT,
    });

    assert.equal(snapshot.ok, true);
    // Pretend the loop ran a writing tool, then the user rewound the conversation.
    writeFileSync(join(place.workspace, "notes.txt"), "edited by a tool", "utf8");
    writeFileSync(join(place.workspace, "scratch.txt"), "newly created", "utf8");

    const records = await store.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) {
      return;
    }

    const rollback = service.rollbackTranscript({ records: records.view.records, sequence: 1 });

    assert.equal(rollback.ok, true);

    if (rollback.ok) {
      const projected = service.projectForPrompt({
        records: records.view.records,
        horizonSequence: rollback.horizonSequence,
      });

      assert.equal(projected.ok, true);

      if (projected.ok) {
        assert.equal(projected.view.items.length, 1);
      }
    }

    // The file rail did not move: rollback is a way of looking at the journal.
    assert.equal(noteFile(place.workspace), "edited by a tool");
    assert.equal(existsSync(join(place.workspace, "scratch.txt")), true);
    await store.release();
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

test("restoring files leaves the journal exactly as it was", async () => {
  const place = world();
  try {
    const store = await twoMessageSession(place.sessionPath);
    const snapshot = await place.checkpoints.snapshot({
      workspaceRoot: place.workspace,
      label: "before the turn",
      createdAt: CREATED_AT,
    });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    writeFileSync(join(place.workspace, "notes.txt"), "edited by a tool", "utf8");
    writeFileSync(join(place.workspace, "scratch.txt"), "newly created", "utf8");

    const restored = await place.checkpoints.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, true);
    assert.equal(noteFile(place.workspace), "original");
    assert.equal(existsSync(join(place.workspace, "scratch.txt")), false);

    const after = await store.readRecords();

    assert.equal(after.ok, true);

    if (after.ok) {
      // Same records, same order, same content: the transcript rail did not move.
      assert.equal(after.view.records.length, 3);
      assert.equal(listTranscript(after.view.records).length, 2);
      assert.equal(after.view.records[2]?.type, "transcript_item");
    }

    await store.release();
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

test("a refused restore leaves both rails untouched", async () => {
  const place = world();
  try {
    const store = await twoMessageSession(place.sessionPath);
    const snapshot = await place.checkpoints.snapshot({
      workspaceRoot: place.workspace,
      label: "before tampering",
      createdAt: CREATED_AT,
    });

    assert.equal(snapshot.ok, true);

    if (!snapshot.ok) {
      return;
    }

    writeFileSync(join(place.workspace, "notes.txt"), "local work in progress", "utf8");
    writeFileSync(
      join(place.root, "checkpoints", snapshot.value.checkpointId, "files", "notes.txt"),
      "tampered",
      "utf8",
    );

    const restored = await place.checkpoints.restore({ checkpointId: snapshot.value.checkpointId });

    assert.equal(restored.ok, false);

    if (!restored.ok) {
      assert.equal(restored.code, "checksum_mismatch");
    }

    assert.equal(noteFile(place.workspace), "local work in progress");

    const after = await store.readRecords();

    assert.equal(after.ok, true);

    if (after.ok) {
      assert.equal(after.view.records.length, 3);
    }

    await store.release();
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

test("refusing to roll back further leaves the workspace untouched too", async () => {
  const place = world();
  try {
    const store = await twoMessageSession(place.sessionPath);

    writeFileSync(join(place.workspace, "notes.txt"), "untouched", "utf8");
    const records = await store.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) {
      return;
    }

    const rollback = service.rollbackTranscript({ records: records.view.records, sequence: 2 });

    assert.equal(rollback.ok, false);

    if (!rollback.ok) {
      assert.equal(rollback.code, "nothing_to_roll_back");
    }

    assert.equal(noteFile(place.workspace), "untouched");
    await store.release();
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

test("a checkpoint can be taken while the session write lock is held", async () => {
  const place = world();
  try {
    const store = await twoMessageSession(place.sessionPath);
    // The two rails own different trees, so there is nothing to serialise; if a
    // future change makes them share a tree, this is where it has to show up.
    const snapshot = await place.checkpoints.snapshot({
      workspaceRoot: place.workspace,
      label: "while writing",
      createdAt: CREATED_AT,
    });

    assert.equal(snapshot.ok, true);

    if (snapshot.ok) {
      const restored = await place.checkpoints.restore({ checkpointId: snapshot.value.checkpointId });
      assert.equal(restored.ok, true);
    }

    const write = await store.append({
      type: "transcript_item",
      sessionId: "demo",
      turnId: "t1",
      at: CREATED_AT,
      payload: { kind: "user", sequence: 2, text: "still writable afterwards" },
    });

    assert.equal(write.ok, true);
    await store.release();
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

test("a fake turn can compact, reload and still recover its files", async () => {
  const place = world();
  try {
    const store = await twoMessageSession(place.sessionPath);
    const snapshot = await place.checkpoints.snapshot({
      workspaceRoot: place.workspace,
      label: "before compaction",
      createdAt: CREATED_AT,
    });

    assert.equal(snapshot.ok, true);

    writeFileSync(join(place.workspace, "notes.txt"), "edited during the turn", "utf8");

    const before = await store.readRecords();

    assert.equal(before.ok, true);

    if (!before.ok) {
      return;
    }

    const draft = service.compact({
      records: before.view.records,
      sessionId: "demo",
      at: CREATED_AT,
      summary: "read notes, replied briefly",
    });

    assert.equal(draft.ok, true);

    if (draft.ok) {
      const appended = await store.append(draft.record);
      assert.equal(appended.ok, true);
    }

    await store.release();

    const reopened = createNdjsonSessionStore({ path: place.sessionPath });
    const attached = await reopened.attach();

    assert.equal(attached.ok, true);
    const after = await reopened.readRecords();

    assert.equal(after.ok, true);

    if (after.ok) {
      const projected = service.projectForPrompt({ records: after.view.records });

      assert.equal(projected.ok, true);

      if (projected.ok) {
        assert.equal(projected.view.items.length, 0);
        assert.equal(projected.view.window?.summary, "read notes, replied briefly");
      }

      // Files are still where the turn left them: compaction is not undo.
      assert.equal(noteFile(place.workspace), "edited during the turn");
      const restored = await place.checkpoints.restore({ checkpointId: "cp-0001-before-compaction" });

      assert.equal(restored.ok, true);
      assert.equal(noteFile(place.workspace), "original");
      const stillThere = await reopened.readRecords();

      assert.equal(stillThere.ok, true);

      if (stillThere.ok) {
        assert.equal(stillThere.view.records.length, 4);
      }
    }

    await reopened.release();
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});
