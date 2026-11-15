import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../../protocol/envelope.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createTurnRecorder } from "./turn-recorder.js";

test("attempt sequence restarts are accepted while rewrites inside one attempt are rejected", async () => {
  const root = mkdtempSync(testScratchPath("recorder-attempts-"));
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });
  try {
    assert.ok((await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z",
      fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } })).ok);
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
    assert.ok(recorder);
    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const first: Envelope = { protocolVersion: "0.0", eventId: "a1-0", sequence: 0, timestamp: "1970-01-01T00:00:00.000Z",
      sessionId: "s", turnId: "t", attemptId: "a1", producerId: "loop", producerSequence: 1, kind: "observation", payload: { value: "first" } };
    const second = { ...first, eventId: "a2-0", attemptId: "a2", producerSequence: 2, payload: { value: "second" } };
    for (const envelope of [first, first, second]) assert.deepEqual(await recorder.progress.flush({ transcript: [], envelopes: [envelope] }), { ok: true });
    assert.deepEqual(await recorder.progress.flush({ transcript: [], envelopes: [{ ...second, payload: { value: "rewritten" } }] }),
      { ok: false, code: "progress_sequence_conflict:envelope" });
    const read = await session.readRecords();
    assert.ok(read.ok);
    assert.equal(read.view.records.filter(record => record.type === "envelope").length, 2);
  } finally { await session.release(); }
});
