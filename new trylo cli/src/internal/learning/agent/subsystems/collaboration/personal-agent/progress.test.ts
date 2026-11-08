import assert from "node:assert/strict";
import test from "node:test";
import { compactPersonalAgentFacts } from "./progress.js";

test("large source coordinates no longer hide the tool fact, and unresolved calls have a bounded opportunity before routine progress", () => {
  const pending = { kind: "tool_pending", sourceRef: "execution-event:actual-pending", memberId: "worker", round: 2, toolName: "read_file",
    source: { eventId: "e".repeat(512), sessionId: "s".repeat(512), producerSequence: 22, raw: "private-body-must-not-copy" } };
  const values = [pending, ...Array.from({ length: 20 }, (_, index) => ({ kind: "round_dispatched", sourceRef: `boundary:${index}`, memberId: "reviewer", round: index }))];
  const rendered = compactPersonalAgentFacts(values), data = JSON.parse(rendered);

  assert.ok(rendered.length <= 1000);
  assert.equal(data.availableFacts, 21);
  assert.equal(data.facts[0].sourceRef, pending.sourceRef);
  assert.equal(data.facts[0].toolName, "read_file");
  assert.ok(data.omittedFacts > 0);
  assert.equal(data.omittedFacts + data.facts.length, 21);
  assert.doesNotMatch(rendered, /private-body|Snapshot omitted|producerSequence/);
  assert.equal(compactPersonalAgentFacts([]), "");
});

test("overlong fact references are omitted as a unit and never become fabricated shortened sources", () => {
  const sourceRef = "execution-event:" + "x".repeat(1500);
  const data = JSON.parse(compactPersonalAgentFacts([{ kind: "tool_pending", sourceRef, memberId: "worker" }]));
  assert.deepEqual(data.facts, []);
  assert.equal(data.omittedFacts, 1);
  assert.match(data.next, /collaboration_inspect/);
});
