import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord, SessionRecordView } from "../../../ports/session.js";
import { decodeSessionContent, sessionContentRecordView, sessionRecordOrigin, sessionRecordPublicText } from "./session-decode.js";
import { sessionContentLocators } from "./session-address.js";
import { readSessionContent, sessionContentRecordRef } from "./session.js";

const sessionId = "method-source-session", turnId = "business-turn", scope = "workspace:method-source";
const at = "2026-11-05T12:00:00Z";

function event(sequence: number, kind: string, payload: SessionRecord["payload"]): SessionRecord {
  return { formatVersion: "1", sessionId, turnId, sequence, type: "envelope", at,
    payload: { envelope: { protocolVersion: "0.0", eventId: `event:${sequence}`, sequence, timestamp: at,
      sessionId, turnId, attemptId: "attempt", producerId: "loop", producerSequence: sequence, kind, payload } } };
}

function journal(records: readonly SessionRecord[]): SessionRecordView {
  return { tornTail: false, records: [
    { formatVersion: "1", sessionId, sequence: 0, type: "session_start", at, payload: { fingerprint: {
      schemaVersion: "1", providerId: "contract", model: "contract", toolCatalogHash: "catalog", workspaceId: scope } } },
    { formatVersion: "1", sessionId, turnId, sequence: 1, type: "turn_input", at, payload: { text: "Inspect the original business source." } },
    ...records,
  ] };
}

const context = { component: "method_context", taskId: turnId, opportunityId: "original-opportunity", selected: 1 };
const refresh = { component: "method_context_refresh", taskId: turnId, reason: "new_user_input" };

test("method context diagnostics have no business source body, locator, catalog entry or exact page", async () => {
  const controls = [event(2, "observation", context), event(3, "observation", refresh)];
  const view = journal(controls);

  for (const record of controls) {
    assert.equal(sessionRecordOrigin(record), undefined, "host method diagnostics are not independent execution results");
    assert.equal(sessionRecordPublicText(record), undefined);
    assert.equal(sessionContentRecordView(record, scope), undefined);
  }

  assert.ok(sessionContentLocators(view, sessionId).every(row => ![2, 3].includes(row.journalSequence)));
  const decoded = decodeSessionContent(view, { sessionId, turnId, scope, subsystem: "method", envelopeSequences: [2, 3] });

  assert.ok(decoded.ok);
  assert.deepEqual(decoded.batch.records.map(row => row.sequence), [1]);
  const source = await readSessionContent({ session: { async readRecords() { return { ok: true, view }; } },
    sessionId, turnId, scope, subsystem: "method", enabled: () => true }, new AbortController().signal);

  assert.ok(source.ok);
  const catalog = await source.value.source.listMaterials(new AbortController().signal);
  assert.ok(catalog.ok);
  assert.deepEqual(catalog.value.entries.map(row => row.journalSequence), [1]);

  for (const record of controls) {
    const page = await source.value.source.readMaterial(sessionContentRecordRef(sessionId, record.sequence), new AbortController().signal);
    assert.deepEqual(page, { ok: false, reason: "content_material_missing" });
  }
});

test("extra fields, ordinary and checker observations, actual adoption feedback and business tools retain original sources", async () => {
  const retained = [
    event(2, "observation", { ...context, versionId: "method:v1", action: "adopt" }),
    event(3, "observation", { ...refresh, observationId: "original:correction", outcome: "unhelpful" }),
    event(4, "observation", { component: "business", result: "original business observation" }),
    event(5, "observation", { component: "checker", status: "passed", evidenceRef: "original:check" }),
    event(6, "observation", { component: "method_adoption", versionId: "method:v1", action: "adopt", reason: "actual original adoption" }),
    event(7, "observation", { component: "method_feedback", versionId: "method:v1", observationId: "original:correction", outcome: "unhelpful" }),
    event(8, "tool_use", context),
    event(9, "tool_result", { toolCallId: "business:call", status: "succeeded", value: context }),
  ];
  const view = journal(retained);

  for (const record of retained) {
    assert.equal(sessionRecordOrigin(record), "execution_result");
    assert.ok(sessionRecordPublicText(record));
    assert.ok(sessionContentRecordView(record, scope));
  }

  assert.deepEqual(sessionContentLocators(view, sessionId).filter(row => row.journalSequence >= 2).map(row => row.journalSequence), retained.map(row => row.sequence));
  const decoded = decodeSessionContent(view, { sessionId, turnId, scope, subsystem: "method", envelopeSequences: retained.map(row => row.sequence) });

  assert.ok(decoded.ok);
  assert.deepEqual(decoded.batch.records.map(row => row.sequence), [1, ...retained.map(row => row.sequence)]);
  const source = await readSessionContent({ session: { async readRecords() { return { ok: true, view }; } },
    sessionId, turnId, scope, subsystem: "method", enabled: () => true }, new AbortController().signal);

  assert.ok(source.ok);

  for (const record of retained) {
    const page = await source.value.source.readMaterial(sessionContentRecordRef(sessionId, record.sequence), new AbortController().signal);
    assert.ok(page.ok);
    assert.equal(page.value.text, sessionRecordPublicText(record));
    assert.equal(page.value.journalSequence, record.sequence);
  }
});
