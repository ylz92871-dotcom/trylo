import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentPacket } from "./material.js";
import { compileContentProcess, runContentProcess } from "./process.js";
import { buildContentTopicHandoff } from "./topic-handoff.js";
import type { KnownApplicationDraft, ResidualReviewDraft } from "./process-contract.js";

function fixture(long = false) {
  const packet = buildContentPacket({ scope: "repo:a", domain: "tool", boardSequence: 3,
    records: [{ ref: "req", runId: "user-run", sequence: 0, scope: "repo:a", origin: "user_statement",
      text: `${long ? "Context. ".repeat(300) : ""}Keep the original precision; determine the missing condition.` },
    { ref: "answer", runId: "source-run", sequence: 7, scope: "repo:a", origin: "checker_result", text: "The known rule gives 2 + 2 = 4 under condition A." }],
    requirements: [{ id: "req:1", requirement: "Use the original precision", conditions: ["A or B"], answerRequirement: "A sufficient conditional answer", sourceRefs: ["req"] }],
    answers: [{ answerId: "old:1", question: "Value under A?", requirement: "Exact value", answer: "4", conditions: ["A"], supportRefs: ["answer"], artifactRefs: [] }],
    materials: [{ id: "source:1", kind: "known_answer", subsystem: "tool", context: "The old answer has a limited condition.",
      recordRefs: ["answer"], requirementIds: ["req:1"], answerIds: ["old:1"], links: { issueIds: [], topicIds: [], artifactRefs: [] } }] });

  assert.ok(packet.ok);
  const applied: KnownApplicationDraft = { schemaVersion: 1,
    knowledge: [{ id: "k", statement: "The answer is 4 within A.", conditions: "A", citations: [{ evidenceRef: "answer", quote: "2 + 2 = 4" }] }],
    applications: [{ id: "a", requirementRefs: ["req"], answerRefs: ["answer"], binding: "Original value at A", result: "4",
      conditions: "A only", citations: [{ evidenceRef: "answer", quote: "2 + 2 = 4" }] }],
    relations: ["known", "missing"].map(id => ({ id, question: id === "known" ? "Value under A?" : "Does the answer hold under B?",
      whenRelevant: "The original precision and A/B scope.", expectedChange: "Conditional use of the original answer.",
      citations: [{ evidenceRef: "req", quote: "determine the missing condition" }] })), preparations: [] };
  const review: ResidualReviewDraft = { schemaVersion: 1, assessments: [
    { relationId: "known", disposition: "answered", applicationIds: ["a"], reason: "The old answer was actually applied under A." },
    { relationId: "missing", disposition: "residual", applicationIds: ["a"], reason: "The old support did not cover B." }],
    comparisons: [], selectedRelationId: "missing", recommendation: { kind: "continue", reason: "Original scope retains B.", citations: [] } };

  return { packet: packet.value, applied, review };
}

test("the second semantic step receives actual applications, eliminates answered relations and retains the residual", async () => {
  const { packet, applied, review } = fixture(), stages: string[] = [];
  const result = await runContentProcess({ packet, maximumPromptChars: 100000, signal: new AbortController().signal,
    model: { async generate(request) {
      stages.push(request.stage);
      if (request.stage === "apply_known") return JSON.stringify(applied);
      const material = JSON.parse(request.materialJson) as { applied: KnownApplicationDraft };
      assert.equal(material.applied.applications[0]?.result, "4");
      return JSON.stringify(review);
    } } });

  assert.ok(result.ok);
  assert.deepEqual(stages, ["apply_known", "residual_review"]);
  assert.deepEqual(result.value.remaining.map(row => row.id), ["missing"]);
  const handoff = buildContentTopicHandoff(packet, result.value);
  assert.ok(handoff.ok);
  assert.equal(handoff.value.kind, "new_topic");
});

test("finite comparison reuses the old question and never mints a synonymous topic", () => {
  const { packet, applied, review } = fixture();
  const compared = { ...review, comparisons: [{ relationId: "missing", priorRef: "answer", kind: "same_question" as const,
    reason: "Same unresolved relation in the original conditions.", citations: [{ evidenceRef: "answer", quote: "under condition A" }] }] };
  const result = compileContentProcess(packet, JSON.stringify(applied), JSON.stringify(compared));
  assert.ok(result.ok);
  assert.deepEqual(buildContentTopicHandoff(packet, result.value), { ok: true, value: { kind: "existing_question", priorRefs: ["answer"], relationId: "missing" } });
});

test("long source excerpts retain the full original text and a reversible source map", () => {
  const { packet, applied, review } = fixture(true);
  const output = compileContentProcess(packet, JSON.stringify(applied), JSON.stringify(review));
  assert.ok(output.ok);
  const result = buildContentTopicHandoff(packet, output.value);
  assert.ok(result.ok);
  assert.equal(result.value.kind, "new_topic");

  if (result.value.kind !== "new_topic") return;

  const excerpt = result.value.excerpts[0]!;

  assert.equal(excerpt.sourceRef, "req");
  assert.equal(excerpt.sourceRunId, "user-run");
  const source = packet.records[0]!;
  const window = JSON.parse(result.value.windowJson) as { records: { ref: string; text: string }[] };

  assert.equal(window.records[0]?.text, source.text.slice(excerpt.start, excerpt.end));
  assert.ok(source.text.length > 2048);
  assert.notEqual(window.records[0]?.ref, source.ref);
});

test("missing review coverage, unknown applications, wrong-source quotes and cancellation fail explicitly", async () => {
  const { packet, applied, review } = fixture();

  assert.deepEqual(compileContentProcess(packet, JSON.stringify(applied), JSON.stringify({ ...review, assessments: [] })),
    { ok: false, reason: "content_review_incomplete" });
  const invalid = { ...review, assessments: review.assessments.map(row => ({ ...row, applicationIds: ["invented"] })) };

  assert.deepEqual(compileContentProcess(packet, JSON.stringify(applied), JSON.stringify(invalid)), { ok: false, reason: "content_reference_invalid" });
  const wrong = { ...applied, knowledge: [{ ...applied.knowledge[0], citations: [{ evidenceRef: "req", quote: "2 + 2 = 4" }] }] };

  assert.deepEqual(compileContentProcess(packet, JSON.stringify(wrong), JSON.stringify(review)), { ok: false, reason: "content_quote_invalid" });
  const controller = new AbortController();
  let calls = 0;
  const stopped = await runContentProcess({ packet, maximumPromptChars: 100000, signal: controller.signal,
    model: { async generate() {
      calls += 1;
      controller.abort();
      return JSON.stringify(applied);
    } } });

  assert.deepEqual(stopped, { ok: false, reason: "content_cancelled" });
  assert.equal(calls, 1);
});
