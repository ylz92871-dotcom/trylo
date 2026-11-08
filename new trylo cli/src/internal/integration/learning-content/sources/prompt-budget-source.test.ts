import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope, JsonObject } from "../../../protocol/envelope.js";
import type { SessionRecord, SessionRecordView } from "../../../ports/session.js";
import { promptBudgetObservationPayload } from "../../../loop/prompt-budget-observation.js";
import { createCollaborationObjectiveObservations } from "../../../learning/agent/subsystems/collaboration/runtime/objective-observations.js";
import { personalAgentFactsContext } from "../../../surface/cli/collaboration-parent-prompt.js";
import { decodeSessionContent, sessionContentRecordView, sessionRecordOrigin, sessionRecordPublicText } from "./session-decode.js";
import { sessionContentLocators } from "./session-address.js";
import { readSessionContent, sessionContentRecordRef } from "./session.js";

const sessionId = "budget-source-session", turnId = "budget-source-turn", scope = "workspace:budget-source", at = "2026-11-08T00:00:00Z";

function envelope(sequence: number, payload: JsonObject): Envelope {
  return { protocolVersion: "0.0", eventId: `event:${sequence}`, sequence, timestamp: at, sessionId, turnId,
    attemptId: "attempt", producerId: "loop", producerSequence: sequence, kind: "observation", payload };
}

const selected = (sequence: number): Envelope => envelope(sequence, promptBudgetObservationPayload({ basis: "local", tokens: 20,
  localEstimate: 20, reason: "no_report", requestDigest: "a".repeat(64) }, { turnId, attemptId: "attempt", streamIndex: sequence }));

function record(event: Envelope): SessionRecord {
  return { formatVersion: "1", sessionId, turnId, sequence: event.sequence, type: "envelope", at, payload: { envelope: event } };
}

function journal(events: readonly Envelope[]): SessionRecordView {
  return { tornTail: false, records: [
    { formatVersion: "1", sessionId, sequence: 0, type: "session_start", at, payload: { fingerprint: {
      schemaVersion: "1", providerId: "contract", model: "contract", toolCatalogHash: "catalog", workspaceId: scope } } },
    { formatVersion: "1", sessionId, turnId, sequence: 1, type: "turn_input", at, payload: { text: "Keep the real task result available." } },
    ...events.map(record),
  ] };
}

test("normal per-request budget observations do not evict original PA progress facts", () => {
  const objective = createCollaborationObjectiveObservations({ scope, turnId, taskId: turnId, maxFacts: 4 });

  objective.capture(envelope(1, { component: "business", result: "original verification" }));

  for (let index = 2; index <= 65; index++) objective.capture(selected(index));

  const facts = objective.recentFacts();

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.component, "business");
  assert.equal(personalAgentFactsContext(facts, []).includes("prompt_budget"), false);
});

test("selected budget metadata has no learning body, locator, catalog entry or exact page", async () => {
  const event = selected(2), row = record(event), view = journal([event]);

  assert.equal(sessionRecordOrigin(row), undefined);
  assert.equal(sessionRecordPublicText(row), undefined);
  assert.equal(sessionContentRecordView(row, scope), undefined);
  assert.deepEqual(sessionContentLocators(view, sessionId).map(value => value.journalSequence), [0, 1]);
  const decoded = decodeSessionContent(view, { sessionId, turnId, scope, subsystem: "method", envelopeSequences: [2] });

  assert.ok(decoded.ok);
  assert.deepEqual(decoded.batch.records.map(value => value.sequence), [1]);
  const source = await readSessionContent({ session: { async readRecords() { return { ok: true, view }; } },
    sessionId, turnId, scope, subsystem: "method", enabled: () => true }, new AbortController().signal);

  assert.ok(source.ok);
  const catalog = await source.value.source.listMaterials(new AbortController().signal);
  assert.ok(catalog.ok);
  assert.deepEqual(catalog.value.entries.map(value => value.journalSequence), [1]);
  assert.deepEqual(await source.value.source.readMaterial(sessionContentRecordRef(sessionId, 2), new AbortController().signal),
    { ok: false, reason: "content_material_missing" });
  assert.deepEqual(view.records[2]?.payload.envelope, event, "raw canonical audit evidence remains unchanged");
});

test("failed budget and unrelated checker observations retain original PA progress", () => {
  const objective = createCollaborationObjectiveObservations({ scope, turnId, taskId: turnId });
  objective.capture(envelope(2, { component: "prompt_budget", status: "failed", reason: "fixture_failure" }));
  objective.capture(envelope(3, { component: "checker", status: "selected", result: "verified" }));
  objective.capture(envelope(4, { component: "business", status: "selected" }));
  objective.capture(envelope(5, { component: "unknown_component", status: "selected" }));
  assert.deepEqual(objective.recentFacts().map(value => value.component), ["prompt_budget", "checker", "business", "unknown_component"]);
});

test("failed budget and unrelated observations retain their learning source identities", () => {
  const events = [envelope(2, { component: "prompt_budget", status: "failed", reason: "fixture_failure" }),
    envelope(3, { component: "checker", status: "selected", result: "verified" }),
    envelope(4, { component: "business", status: "selected" }),
    envelope(5, { component: "unknown_component", status: "selected" })];
  const view = journal(events);

  for (const event of events) {
    assert.equal(sessionRecordOrigin(record(event)), "execution_result");
    assert.ok(sessionRecordPublicText(record(event)));
  }

  assert.deepEqual(sessionContentLocators(view, sessionId).map(value => value.journalSequence), [0, 1, 2, 3, 4, 5]);
});
