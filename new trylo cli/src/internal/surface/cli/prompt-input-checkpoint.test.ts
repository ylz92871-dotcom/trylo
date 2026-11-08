import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import type { SessionPort } from "../../ports/session.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createTurnRecorder } from "./turn-recorder.js";
import { persistTurn } from "./session-record.js";

const stamp = "2026-11-08T00:00:00.000Z", hash = "a".repeat(64);
const basis = { version: 1, model: "synthetic", input: { kind: "complete_prompt", source: "provider_complete_input", tokens: 77 },
  inputBindingDigest: hash, settingsDigest: hash, toolDigest: hash, windowDigest: hash, nativeMode: "none",
  nonSystem: { count: 1, digest: hash }, systems: { count: 0, digest: hash, nativeDigest: hash } } as const;
const checkpoint = { version: 1, sessionId: "s", turnId: "t", attemptId: "a", streamIndex: 1, basis } as const;

function envelope(kind: string, sequence: number, attemptId = "a"): Envelope {
  return { protocolVersion: "0.0", eventId: `e-${sequence}`, sequence, timestamp: stamp, sessionId: "s", turnId: "t", attemptId,
    correlationId: "c", producerId: "loop", producerSequence: sequence, kind,
    payload: kind === "stream_end" ? { reason: "stop", requiresFollowUp: false } : { attemptId } };
}

async function fixture() {
  const directory = mkdtempSync(testScratchPath("prompt-input-checkpoint-"));
  const store = createNdjsonSessionStore({ path: join(directory, "s.ndjson") });

  assert.equal((await store.start({ sessionId: "s", createdAt: stamp, fingerprint: {
    schemaVersion: "1", providerId: "fixture", model: "synthetic", toolCatalogHash: "tools", workspaceId: "workspace",
  } })).ok, true);
  const appended: Array<Parameters<SessionPort["append"]>[0]> = [];
  let reject = false;
  const session: SessionPort = { ...store, async append(record) {
    if (reject) return { ok: false, code: "disk_full" };
    const result = await store.append(record);
    if (result.ok) appended.push(record);
    return result;
  } };
  const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

  return { recorder, store, appended, reject() { reject = true; }, async cleanup() {
    await store.release();
    rmSync(directory, { recursive: true, force: true });
  } };
}

test("a completed request checkpoint shares the stream_end append without changing its public envelope", async () => {
  const f = await fixture();
  try {
    const started = envelope("api_call", 0), ended = envelope("stream_end", 1);
    const progress = { transcript: [], envelopes: [started, ended], promptInputCheckpoint: checkpoint };

    assert.equal((await f.recorder.progress.flush(progress)).ok, true);
    const stored = f.appended.find(row => row.payload.envelope === undefined ? false
      : (row.payload.envelope as JsonObject).kind === "stream_end");

    assert.ok(stored);
    assert.deepEqual(stored.payload.promptInputCheckpoint, checkpoint);
    assert.deepEqual(stored.payload.envelope, ended);
    assert.equal(f.appended.length, 2, "the extension is not a second append or public event");
    assert.equal((await f.recorder.progress.flush(progress)).ok, true);
    assert.equal(f.appended.length, 2, "duplicate flush cannot duplicate its durable receipt");
  } finally { await f.cleanup(); }
});

for (const [label, override] of [
  ["foreign session", { sessionId: "foreign" }], ["other turn", { turnId: "old" }],
  ["other attempt", { attemptId: "old" }], ["other stream", { streamIndex: 2 }],
] as const) test(`a ${label} checkpoint cannot attach to the current completion`, async () => {
  const f = await fixture();
  try {
    const progress = { transcript: [], envelopes: [envelope("api_call", 0), envelope("stream_end", 1)],
      promptInputCheckpoint: { ...checkpoint, ...override } };
    assert.equal((await f.recorder.progress.flush(progress)).ok, true);
    assert.equal(f.appended.some(row => row.payload.promptInputCheckpoint !== undefined), false);
  } finally { await f.cleanup(); }
});

test("a failed completion append provides no durable checkpoint and a later stream cannot borrow old metadata", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.recorder.progress.flush({ transcript: [], envelopes: [envelope("api_call", 0)] })).ok, true);
    f.reject();
    const progress = { transcript: [], envelopes: [envelope("stream_end", 1)], promptInputCheckpoint: checkpoint };
    assert.equal((await f.recorder.progress.flush(progress)).ok, false);
    assert.equal(f.appended.some(row => row.payload.promptInputCheckpoint !== undefined), false);
  } finally { await f.cleanup(); }
});

test("legacy completions retain the original payload without checkpoint metadata", async () => {
  const f = await fixture();
  try {
    const ended = envelope("stream_end", 1);
    assert.equal((await f.recorder.progress.flush({ transcript: [], envelopes: [envelope("api_call", 0), ended] })).ok, true);
    assert.deepEqual(f.appended[1]?.payload, { envelope: ended });
  } finally { await f.cleanup(); }
});

test("bulk persistence attaches its one last checkpoint only to the corresponding accepted stream", async () => {
  const f = await fixture();
  try {
    await persistTurn(f.store, { sessionId: "s", turnId: "t", startedAt: stamp, finishedAt: stamp, clock: () => stamp,
      newTranscript: [], envelopes: [envelope("api_call", 0), envelope("stream_end", 1), envelope("api_call", 2), envelope("stream_end", 3)],
      issuedKeys: [], committedKeys: [], terminalReason: "completed", finishReason: "stop", iterations: 2,
      usage: { inputTokens: 154, outputTokens: 2, totalTokens: 156 },
      promptInputCheckpoint: { ...checkpoint, streamIndex: 2 },
    });
    const read = await f.store.readRecords();
    assert.ok(read.ok);
    const marked = read.view.records.filter(record => record.payload.promptInputCheckpoint !== undefined);

    assert.equal(marked.length, 1);
    assert.deepEqual(marked[0]?.payload.promptInputCheckpoint, { ...checkpoint, streamIndex: 2 });
    assert.equal((marked[0]?.payload.envelope as JsonObject).eventId, "e-3");
  } finally { await f.cleanup(); }
});
