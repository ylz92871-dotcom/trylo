import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMPACTION_FORMAT_VERSION } from "../../ports/compaction.js";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint } from "../../ports/session.js";
import { createCompactionService } from "../../compaction/service.js";
import { listTranscript } from "../../compaction/projection.js";
import { createNdjsonSessionStore } from "./ndjson.js";

/**
 * Compaction against the real journal, plus the compatibility matrix:
 * no compact record, one, two, and a broken one.
 *
 * `compact` is a new *record type*, not a new format. Everything the nightly
 * slice proved — checksums, sequence continuity, single writer, torn-tail-only
 * repair — has to keep holding with the extra line present, which is why the
 * nightly behaviours are re-asserted here rather than assumed.
 */

const service = createCompactionService();

const FINGERPRINT: RuntimeFingerprint = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "default",
  toolCatalogHash: "catalog",
  workspaceId: "workspace",
};

const CLOCK = "2026-09-14T00:00:00.000Z";

function fixture() {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-compact-"));
  return { root, path: join(root, "sessions", "demo.ndjson") };
}

async function started(path: string) {
  const store = createNdjsonSessionStore({ path });
  const outcome = await store.start({ sessionId: "demo", createdAt: CLOCK, fingerprint: FINGERPRINT });
  assert.equal(outcome.ok, true);
  return store;
}

async function say(store: ReturnType<typeof createNdjsonSessionStore>, sequence: number, text: string) {
  const outcome = await store.append({
    type: "transcript_item",
    sessionId: "demo",
    turnId: "t1",
    at: CLOCK,
    payload: { kind: "user", sequence, text },
  });
  assert.equal(outcome.ok, true);
}

test("a compact record round-trips and filters the prompt view after a reload", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    await say(store, 1, "second");
    const view = await store.readRecords();

    assert.equal(view.ok, true);

    if (!view.ok) {
      return;
    }

    const draft = service.compact({
      records: view.view.records,
      sessionId: "demo",
      at: CLOCK,
      summary: "two messages, unresolved",
    });

    assert.equal(draft.ok, true);

    if (!draft.ok) {
      return;
    }

    const appended = await store.append(draft.record);

    assert.equal(appended.ok, true);
    await store.release();

    const reopened = createNdjsonSessionStore({ path: dir.path });
    const attached = await reopened.attach();

    assert.equal(attached.ok, true);
    const reloaded = await reopened.readRecords();

    assert.equal(reloaded.ok, true);

    if (reloaded.ok) {
      const projected = service.projectForPrompt({ records: reloaded.view.records });

      assert.equal(projected.ok, true);

      if (projected.ok) {
        assert.equal(projected.view.window?.windowId, "w1");
        assert.equal(projected.view.items.length, 0);
        // The replaced messages are still on disk; only the model loses them.
        assert.equal(listTranscript(reloaded.view.records).length, 2);
      }
    }

    await reopened.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("a journal with no compact record behaves exactly like the nightly one", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    await say(store, 1, "second");
    const recovered = await store.read();

    assert.equal(recovered.ok, true);

    if (recovered.ok) {
      assert.equal(recovered.session.transcript.length, 2);
      assert.equal(recovered.session.lastSequence, 2);
      assert.equal(recovered.session.repairedTornTail, false);
    }

    const view = await store.readRecords();

    assert.equal(view.ok, true);

    if (view.ok) {
      const again = service.projectForPrompt({ records: view.view.records });
      assert.equal(again.ok, true);
      if (again.ok) {
        assert.equal(again.view.items.length, 2);
        assert.equal(again.view.window, undefined);
      }
    }

    await store.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("two windows on disk leave only the newest one in the prompt view", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    await say(store, 1, "second");
    const recordsFor = async () => {
      const view = await store.readRecords();
      assert.equal(view.ok, true);
      if (!view.ok) {
        return [];
      }
      return [...view.view.records];
    };
    let draft = service.compact({ records: await recordsFor(), sessionId: "demo", at: CLOCK, summary: "first two" });

    assert.equal(draft.ok, true);

    if (draft.ok) {
      await store.append(draft.record);
    }

    await say(store, 2, "third");
    draft = service.compact({ records: await recordsFor(), sessionId: "demo", at: CLOCK, summary: "then a third" });
    assert.equal(draft.ok, true);

    if (draft.ok) {
      assert.equal(draft.record.payload.windowId, "w2");
      assert.equal(draft.record.payload.replacedFromSequence, 3);
      await store.append(draft.record);
    }

    const view = await store.readRecords();

    assert.equal(view.ok, true);

    if (view.ok) {
      const projected = service.projectForPrompt({ records: view.view.records });

      assert.equal(projected.ok, true);

      if (projected.ok) {
        assert.equal(projected.view.window?.windowId, "w2");
        assert.equal(projected.view.window?.summary, "then a third");
        assert.equal(projected.view.items.length, 0);
      }

      assert.equal(listTranscript(view.view.records).length, 3);
    }

    await store.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("the nightly recovery still returns every transcript item after compaction", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    await say(store, 1, "second");
    const draft = service.compact({
      records: (await recordsOf(store)).records,
      sessionId: "demo",
      at: CLOCK,
      summary: "both",
    });

    assert.equal(draft.ok, true);

    if (draft.ok) {
      await store.append(draft.record);
    }

    const recovered = await store.read();

    assert.equal(recovered.ok, true);

    if (recovered.ok) {
      // `read` is the UI/journal projection, not the model's. It must not shrink.
      assert.equal(recovered.session.transcript.length, 2);
    }

    await store.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("a tampered compact line fails closed like any other tampered line", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    const draft = service.compact({ records: (await recordsOf(store)).records, sessionId: "demo", at: CLOCK, summary: "first" });

    assert.equal(draft.ok, true);

    if (draft.ok) {
      await store.append(draft.record);
    }

    await store.release();
    const lines = readFileSync(dir.path, "utf8").split("\n").filter((line) => line.length > 0);

    assert.equal(lines.length, 3);
    lines[2] = (lines[2] ?? "").replace('"summary":"first"', '"summary":"lies"');
    writeFileSync(dir.path, `${lines.join("\n")}\n`);

    const reopened = createNdjsonSessionStore({ path: dir.path });
    const read = await reopened.readRecords();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "checksum_mismatch");
    }
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("a torn compact tail is reported and never taken as a window", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    await store.release();
    appendFileSync(dir.path, `{"sequence":2,"sum":"deadbeef","record":{"formatVersion":"${SESSION_FORMAT_VERSION}","sequence":2,"type":"compact"`);

    const reopened = createNdjsonSessionStore({ path: dir.path });
    const attached = await reopened.attach();

    assert.equal(attached.ok, true);
    const view = await reopened.readRecords();

    assert.equal(view.ok, true);

    if (view.ok) {
      assert.equal(view.view.tornTail, true);
      // The half line is not history: no window may appear because of it.
      const projected = service.projectForPrompt({ records: view.view.records });

      assert.equal(projected.ok, true);

      if (projected.ok) {
        assert.equal(projected.view.window, undefined);
        assert.equal(projected.view.items.length, 1);
      }
    }

    const blocked = await reopened.append({
      type: "transcript_item",
      sessionId: "demo",
      at: CLOCK,
      payload: { kind: "user", sequence: 2, text: "after the crash" },
    });

    assert.equal(blocked.ok, false);

    if (!blocked.ok) {
      assert.equal(blocked.code, "torn_tail_unrepaired");
    }

    await reopened.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("an unknown compact version on disk refuses the projection", async () => {
  const dir = fixture();
  try {
    const store = await started(dir.path);

    await say(store, 0, "first");
    await store.append({
      type: "compact",
      sessionId: "demo",
      at: CLOCK,
      payload: {
        windowId: "w1",
        replacedFromSequence: 0,
        replacedToSequence: 1,
        summary: "written by a future build",
        formatVersion: "99",
      },
    });
    const view = await store.readRecords();

    assert.equal(view.ok, true);

    if (view.ok) {
      const projected = service.projectForPrompt({ records: view.view.records });
      assert.equal(projected.ok, false);
      if (!projected.ok) {
        assert.equal(projected.code, "compact_format_unknown");
      }
    }

    await store.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("appending a compact record still requires holding the lock", async () => {
  const dir = fixture();
  try {
    const owner = await started(dir.path);

    await say(owner, 0, "first");
    const stranger = createNdjsonSessionStore({ path: dir.path });
    const written = await stranger.append({
      type: "compact",
      sessionId: "demo",
      at: CLOCK,
      payload: {
        windowId: "w1",
        replacedFromSequence: 0,
        replacedToSequence: 1,
        summary: "written without the lock",
        formatVersion: COMPACTION_FORMAT_VERSION,
      },
    });

    assert.equal(written.ok, false);

    if (!written.ok) {
      assert.equal(written.code, "lock_conflict");
    }

    await owner.release();
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test("a missing session still reports missing_session through the record view", async () => {
  const dir = fixture();
  try {
    const store = createNdjsonSessionStore({ path: dir.path });
    const view = await store.readRecords();
    assert.equal(view.ok, false);
    if (!view.ok) {
      assert.equal(view.code, "missing_session");
    }
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

async function recordsOf(store: ReturnType<typeof createNdjsonSessionStore>) {
  const view = await store.readRecords();
  assert.equal(view.ok, true);
  if (!view.ok) {
    throw new Error("fixture journal unreadable");
  }
  return { records: view.view.records };
}
