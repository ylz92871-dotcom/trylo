import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { projectEnvelopeSequence } from "./stream-projection.js";

function observation(payload: JsonObject): Envelope {
  return { protocolVersion: "0.0", eventId: "budget-observation", sequence: 1,
    timestamp: "2026-11-08T00:00:00Z", kind: "observation", producerId: "loop", producerSequence: 1,
    sessionId: "s", turnId: "t", payload };
}

test("a selected local prompt budget remains canonical evidence without becoming a CLI warning", () => {
  const envelope = observation({ component: "prompt_budget", status: "selected", basis: "local", reason: "no_report",
    tokens: 12, localEstimate: 12, requestDigest: "fixture-request-digest", streamIndex: 1 });
  const original = JSON.stringify(envelope);
  assert.deepEqual(projectEnvelopeSequence([envelope]), []);
  assert.equal(JSON.stringify(envelope), original);
});

test("a selected server basis creates no warning, usage bill or compact result", () => {
  const envelope = observation({ component: "prompt_budget", status: "selected", basis: "server_plus_added", reason: "complete_prompt",
    tokens: 20, localEstimate: 100, observedInputTokens: 16, addedTokens: 4,
    inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 16 },
    requestDigest: "fixture-request-digest", streamIndex: 2, contextTokenLimit: 80, explicitOutputAllowance: 9 });
  assert.deepEqual(projectEnvelopeSequence([envelope]), []);
});

test("a prompt-budget diagnostic with a different status stays visible", () => {
  const events = projectEnvelopeSequence([observation({ component: "prompt_budget", status: "failed", reason: "fixture_failure" })]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "warning");
});

test("unrelated observation warnings retain their existing projection", () => {
  const events = projectEnvelopeSequence([observation({ component: "fixture_component", reason: "fixture_failure" })]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "warning");
});
