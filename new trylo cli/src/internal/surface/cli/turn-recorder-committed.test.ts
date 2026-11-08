import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { SessionPort } from "../../ports/session.js";
import type { Envelope } from "../../protocol/envelope.js";
import { createTurnRecorder } from "./turn-recorder.js";

const envelope: Envelope = { protocolVersion: "0.0", eventId: "record", sequence: 0, timestamp: "1970-01-01T00:00:00.000Z",
  sessionId: "s", turnId: "t", producerId: "loop", producerSequence: 0, kind: "tool_result",
  payload: { toolCallId: "record", status: "succeeded", value: {} } };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "trylo-workflow-ack-"));
  const store = createNdjsonSessionStore({ path: join(dir, "s.ndjson") });

  assert.equal((await store.start({ sessionId: "s", createdAt: envelope.timestamp, fingerprint: {
    schemaVersion: "1", providerId: "fixture", model: "default", toolCatalogHash: "h", workspaceId: "w",
  } })).ok, true);
  let blocked: string | undefined;
  let release: (() => void) | undefined;
  let reject = false;
  const port: SessionPort = { ...store, async append(record) {
    if (reject) return { ok: false, code: "disk_full" };
    if (record.type === blocked) await new Promise<void>(resolve => { release = resolve; });
    return store.append(record);
  } };
  const committedEnvelopes: Envelope[] = [];
  const effects: string[] = [];
  const recorder = createTurnRecorder({ session: port, sessionId: "s", turnId: "t", now: () => 0,
    onCommittedEnvelope: event => committedEnvelopes.push(event), onCommittedEffect: key => effects.push(key) })!;

  return { recorder, store, committedEnvelopes, effects, block(type: string) { blocked = type; }, unblock() {
    blocked = undefined;
    release?.();
  },

    rejectWrites() { reject = true; }, async cleanup() {
      await store.release();
      rmSync(dir, { recursive: true, force: true });
    } };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("durable observers wait for append acknowledgement and duplicate flush has one delivery", async () => {
  const fx = await fixture();
  try {
    fx.block("envelope");
    const flushing = fx.recorder.progress.flush({ transcript: [], envelopes: [envelope] });

    await tick();
    assert.equal(fx.committedEnvelopes.length, 0);
    fx.unblock();
    assert.equal((await flushing).ok, true);
    assert.equal(fx.committedEnvelopes.length, 1);
    assert.equal((await fx.recorder.progress.flush({ transcript: [], envelopes: [envelope] })).ok, true);
    assert.equal(fx.committedEnvelopes.length, 1);
    const records = await fx.store.readRecords();

    assert.equal(records.ok, true);

    if (records.ok) assert.equal(records.view.records.filter(item => item.type === "envelope").length, 1);
  } finally { await fx.cleanup(); }
});

test("effect-complete receipt waits for its own durable acknowledgement and failed writes emit no receipt", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.recorder.progress.issue("tool:record")).ok, true);
    fx.block("effect_committed");
    const settling = fx.recorder.progress.settle("tool:record", "succeeded");

    await tick();
    assert.equal(fx.effects.length, 0);
    fx.unblock();
    assert.equal((await settling).ok, true);
    assert.deepEqual(fx.effects, ["tool:record"]);
    fx.rejectWrites();
    assert.equal((await fx.recorder.progress.flush({ transcript: [], envelopes: [envelope] })).ok, false);
    assert.equal(fx.committedEnvelopes.length, 0);
    assert.equal((await fx.recorder.progress.settle("tool:refused", "succeeded")).ok, false);
    assert.deepEqual(fx.effects, ["tool:record"]);
  } finally { await fx.cleanup(); }
});
