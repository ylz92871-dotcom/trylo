import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint, type SessionRecord } from "../../ports/session.js";
import { createNdjsonSessionStore, encodeLine } from "./ndjson.js";

/**
 * Durable session recovery rules.
 *
 * The store is the authority for what happened after a crash, so every case
 * here is about refusing to invent history: the only permitted repair is an
 * unterminated final line, and even that is never implicit.
 */

const FINGERPRINT: RuntimeFingerprint = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "default",
  toolCatalogHash: "catalog",
  workspaceId: "workspace",
};

function tempDir(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-session-"));
}

function pathIn(dir: string): string {
  return join(dir, "sessions", "demo.ndjson");
}

async function startStore(dir: string) {
  const store = createNdjsonSessionStore({ path: pathIn(dir) });
  const started = await store.start({
    sessionId: "demo",
    createdAt: "2026-09-14T00:00:00.000Z",
    fingerprint: FINGERPRINT,
  });

  assert.equal(started.ok, true);

  return store;
}

function turnRecord(overrides: Record<string, unknown> = {}) {
  return {
    type: "turn_start" as const,
    sessionId: "demo",
    turnId: "t1",
    at: "2026-09-14T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

test("a session cannot be started twice without resuming it", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);

    await store.release();
    const again = createNdjsonSessionStore({ path: pathIn(dir) });
    const started = await again.start({
      sessionId: "demo",
      createdAt: "2026-09-14T00:00:00.000Z",
      fingerprint: FINGERPRINT,
    });

    assert.equal(started.ok, false);

    if (!started.ok) {
      assert.equal(started.code, "session_exists");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second writer is refused instead of interleaving", async () => {
  const dir = tempDir();
  try {
    const first = await startStore(dir);
    const second = createNdjsonSessionStore({ path: pathIn(dir) });
    const attached = await second.attach();

    assert.equal(attached.ok, false);

    if (!attached.ok) {
      assert.equal(attached.code, "lock_conflict");
    }

    const appended = await second.append(turnRecord());

    assert.equal(appended.ok, false);
    await first.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach refuses a session that does not exist", async () => {
  const dir = tempDir();
  try {
    const store = createNdjsonSessionStore({ path: pathIn(dir) });
    const attached = await store.attach();
    assert.equal(attached.ok, false);
    if (!attached.ok) {
      assert.equal(attached.code, "missing_session");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn tail is reported, blocks appends, and is only repaired explicitly", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);

    await store.append(turnRecord());
    appendFileSync(pathIn(dir), '{"sequence":2,"sum":"deadbeef","record":{"tr');

    const blocked = await store.append(turnRecord());

    assert.equal(blocked.ok, false);

    if (!blocked.ok) {
      assert.equal(blocked.code, "torn_tail_unrepaired");
    }

    const read = await store.read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.session.repairedTornTail, true);
      assert.equal(read.session.lastSequence, 1);
    }

    const repaired = await store.repairTornTail();

    assert.equal(repaired.ok, true);

    if (repaired.ok) {
      assert.equal(repaired.removedBytes > 0, true);
    }

    const appended = await store.append(turnRecord());

    assert.equal(appended.ok, true);
    const after = await store.read();

    assert.equal(after.ok, true);

    if (after.ok) {
      assert.equal(after.session.repairedTornTail, false);
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption in the middle of the journal is never treated as a torn tail", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);

    await store.append(turnRecord({ turnId: "t1" }));
    await store.append(turnRecord({ turnId: "t2" }));
    await store.append(turnRecord({ turnId: "t3" }));
    await store.release();

    const lines = readFileSync(pathIn(dir), "utf8").split("\n").filter((line) => line.length > 0);

    assert.equal(lines.length, 4);
    // Rewrite the second record so its checksum no longer matches.
    lines[1] = (lines[1] ?? "").replace('"payload":{}', '"payload":{"tampered":true}');
    writeFileSync(pathIn(dir), `${lines.join("\n")}\n`);

    const reopened = createNdjsonSessionStore({ path: pathIn(dir) });
    const read = await reopened.read();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "checksum_mismatch");
    }

    const attached = await reopened.attach();

    assert.equal(attached.ok, true);
    const repaired = await reopened.repairTornTail();

    assert.equal(repaired.ok, true);

    if (repaired.ok) {
      // Nothing may be silently dropped: the file ends with a newline.
      assert.equal(repaired.removedBytes, 0);
    }

    const again = await reopened.read();

    assert.equal(again.ok, false);
    await reopened.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown format version fails closed", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);
    const raw = readFileSync(pathIn(dir), "utf8");

    writeFileSync(pathIn(dir), raw.replace(`"formatVersion":"${SESSION_FORMAT_VERSION}"`, '"formatVersion":"99"'));
    const read = await store.read();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "unknown_format_version");
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sequence gap fails closed", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);

    await store.append(turnRecord());
    await store.release();
    const line = readFileSync(pathIn(dir), "utf8").split("\n").filter((l) => l.length > 0)[1];

    assert.notEqual(line, undefined);
    const parsed = JSON.parse(line ?? "{}") as { sequence: number; record: Record<string, unknown> };

    parsed.sequence = 7;
    parsed.record["sequence"] = 7;
    appendFileSync(pathIn(dir), `${JSON.stringify(parsed)}\n`);
    const read = await store.read();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "sequence_gap");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an effect issued without a commit is reported as needing reconciliation", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);

    await store.append({
      type: "effect_issued",
      sessionId: "demo",
      turnId: "t1",
      at: "2026-09-14T00:00:01.000Z",
      payload: { key: "tool:call-1" },
    });
    await store.append({
      type: "effect_issued",
      sessionId: "demo",
      turnId: "t1",
      at: "2026-09-14T00:00:02.000Z",
      payload: { key: "tool:call-2" },
    });
    await store.append({
      type: "effect_committed",
      sessionId: "demo",
      turnId: "t1",
      at: "2026-09-14T00:00:03.000Z",
      payload: { key: "tool:call-2" },
    });
    const read = await store.read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.deepEqual([...read.session.reconcileRequired], ["tool:call-1"]);
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript items survive a reload in order", async () => {
  const dir = tempDir();
  try {
    const store = await startStore(dir);

    await store.append({
      type: "transcript_item",
      sessionId: "demo",
      turnId: "t1",
      at: "2026-09-14T00:00:01.000Z",
      payload: { kind: "user", sequence: 0, text: "hello" },
    });
    await store.append({
      type: "transcript_item",
      sessionId: "demo",
      turnId: "t1",
      at: "2026-09-14T00:00:02.000Z",
      payload: { kind: "assistant_text", sequence: 1, blockId: "b1", text: "world" },
    });
    const read = await store.read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.deepEqual(
        read.session.transcript.map((item) => item.kind),
        ["user", "assistant_text"],
      );
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing session file is not a fabricated empty session", async () => {
  const dir = tempDir();
  try {
    assert.equal(existsSync(pathIn(dir)), false);
    const store = createNdjsonSessionStore({ path: pathIn(dir) });
    const read = await store.read();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "missing_session");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The byte-level checks (checksum, sequence, version) prove the journal was
 * written by a writer of this format; they cannot prove the *payload* of every
 * record still matches its type. A journal whose lines carry valid checksums
 * but wrong-shaped payloads — a writer bug, or a tamper that recomputed them —
 * must fail closed at recovery instead of projecting arbitrary objects into
 * `TranscriptItem` and `RuntimeFingerprint`.
 */
function writeHandJournal(dir: string, records: readonly SessionRecord[]): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const lines = records.map((record, index) => encodeLine(index, record));
  writeFileSync(pathIn(dir), `${lines.join("\n")}\n`);
}

const handStart: SessionRecord = {
  formatVersion: SESSION_FORMAT_VERSION,
  sequence: 0,
  type: "session_start",
  sessionId: "demo",
  at: "2026-09-14T00:00:00.000Z",
  payload: { fingerprint: FINGERPRINT },
};

test("a transcript_item whose payload is not a transcript item fails closed", async () => {
  const dir = tempDir();
  try {
    writeHandJournal(dir, [
      handStart,
      {
        formatVersion: SESSION_FORMAT_VERSION,
        sequence: 1,
        type: "transcript_item",
        sessionId: "demo",
        at: "2026-09-14T00:00:01.000Z",
        // Checksum valid, shape foreign: no sequence, no text.
        payload: { kind: "system" },
      },
    ]);
    const store = createNdjsonSessionStore({ path: pathIn(dir) });
    const read = await store.read();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "mid_file_corruption");
      assert.match(read.detail, /transcript_item/);
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session_start whose fingerprint is not a fingerprint fails closed", async () => {
  const dir = tempDir();
  try {
    writeHandJournal(dir, [
      {
        formatVersion: SESSION_FORMAT_VERSION,
        sequence: 0,
        type: "session_start",
        sessionId: "demo",
        at: "2026-09-14T00:00:00.000Z",
        payload: { fingerprint: 42 },
      },
    ]);
    const store = createNdjsonSessionStore({ path: pathIn(dir) });
    const read = await store.read();

    assert.equal(read.ok, false);

    if (!read.ok) {
      assert.equal(read.code, "mid_file_corruption");
      assert.match(read.detail, /fingerprint/);
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a well-formed transcript_item passes the payload check", async () => {
  const dir = tempDir();
  try {
    writeHandJournal(dir, [
      handStart,
      {
        formatVersion: SESSION_FORMAT_VERSION,
        sequence: 1,
        type: "transcript_item",
        sessionId: "demo",
        at: "2026-09-14T00:00:01.000Z",
        payload: { sequence: 1, kind: "system", text: "hello" },
      },
    ]);
    const store = createNdjsonSessionStore({ path: pathIn(dir) });
    const read = await store.read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.session.transcript.length, 1);
      const item = read.session.transcript[0];
      assert.equal(item?.kind, "system");
      if (item?.kind === "system") {
        assert.equal(item.text, "hello");
      }
    }

    await store.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
