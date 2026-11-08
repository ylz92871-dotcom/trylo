import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import { providerWaitObservationHash, type NormalProviderReturnObservation, type ProviderWaitObservation } from "../../learning/central/runtime/provider-positive.js";
import { createTurnRecorder } from "./turn-recorder.js";

const capture: ProviderWaitObservation = { schemaVersion: 1, scope: "scope", budgetId: "root",
  connectionRef: `central-learning-provider-connection:${"a".repeat(64)}`, sessionId: "s", turnId: "t", model: "m",
  wait: { ref: "wait", factRef: "fact", boardSequence: 7 } };
const returned: NormalProviderReturnObservation = { schemaVersion: 1, captureHash: providerWaitObservationHash(capture),
  attemptId: "actual-attempt", model: "m", finishReason: "stop", reportedTotalTokens: 5 };

function session() {
  const records: Omit<SessionRecord, "formatVersion" | "sequence">[] = [];
  const port: SessionPort = {
    start: async () => ({ ok: true }), attach: async () => ({ ok: true }), release: async () => {},

    append: async record => {
      records.push(record);
      return { ok: true, sequence: records.length };
    },

    repairTornTail: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); },
    readRecords: async () => { throw new Error("unused"); },
  };

  return { records, port };
}

async function record(read: () => NormalProviderReturnObservation | undefined, status: "completed" | "failed" = "completed") {
  const { records, port } = session();
  const recorder = createTurnRecorder({ session: port, sessionId: "s", turnId: "t", now: () => 0,
    providerWaitObservation: capture, readProviderReturnObservation: read });

  assert.ok(recorder);
  await recorder.start({ startedAt: 0, toolCatalogHash: "tools" });
  await recorder.finish({ status, finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });

  return records;
}

test("provider observations piggyback on existing start/terminal only and preserve the original append count", async () => {
  const records = await record(() => returned);
  assert.deepEqual(records.map(value => value.type), ["turn_start", "terminal"]);
  assert.deepEqual(records[0]?.payload.providerWaitObservation, capture);
  assert.deepEqual(records[1]?.payload.providerReturnObservation, returned);
  assert.deepEqual(records[1]?.payload.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test("observer exceptions, mismatched binding and failed PA omit optional return metadata without failing recording", async () => {
  for (const read of [() => { throw new Error("optional observer unavailable"); },
    () => ({ ...returned, captureHash: "b".repeat(64) }), () => undefined]) {
    const records = await record(read);
    assert.equal(Object.hasOwn(records[1]?.payload ?? {}, "providerReturnObservation"), false);
    assert.equal(records.length, 2);
  }
  assert.equal(Object.hasOwn((await record(() => returned, "failed"))[1]?.payload ?? {}, "providerReturnObservation"), false);
});
