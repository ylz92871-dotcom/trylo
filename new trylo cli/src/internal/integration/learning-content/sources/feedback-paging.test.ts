import assert from "node:assert/strict";
import test from "node:test";
import type { ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import { canonicalJson } from "../../../learning/control/hash.js";
import { selectContentFeedbackMaterial } from "./feedback-paging.js";

test("long feedback transport keeps the real original/active correction heads and offers exact full-source pages", () => {
  const source = { sessionId: "old-session", turnId: "old-task", attemptId: "attempt", eventId: "use" };
  const history = Array.from({ length: 40 }, (_, index) => ({ state: index === 39 ? "active" : "superseded", feedbackArrayIndex: index,
    feedback: { id: `feedback-${index}`, exposureId: "original-exposure", source, origin: "user", evidenceIds: ["old-answer-ref", "x".repeat(512)],
      outcome: { kind: "measured", value: index === 39 ? -1 : 1, confidence: 1, noiseVariance: 1 }, attribution: { kind: "unresolved" },
      observedAt: index, ...(index === 0 ? {} : { supersedes: `feedback-${index - 1}` }) } }));
  const text = canonicalJson({ role: "board_explicit_user_feedback_without_requiring_current_session_binding", history,
    exposure: { id: "original-exposure", source, targets: [{ id: "old-answer", version: "v1" }] },
    issueIds: ["original-issue"], artifactRefs: [{ id: "old-answer", version: "v1" }], sourcePosition: { boardSequence: 123 },
    reportStatus: "not_inferred_from_current_journal", taskResult: "not_inferred", learningGain: "not_identified" });
  const make = (index: number): ContentMaterialBatch => ({ records: [{ ref: `original-${index}`, runId: "original-run", sequence: index,
    scope: "scope", origin: "user_statement", text: index === 79 ? text : `Prior feedback ${index}` }], requirements: [], answers: [],
    materials: [{ id: `original-${index}`, kind: "feedback", subsystem: "method", context: "Actual correction source.",
      recordRefs: [`original-${index}`], requirementIds: [], answerIds: [], links: { issueIds: ["original-issue"], topicIds: [],
        artifactRefs: [{ id: "old-answer", version: "v1" }] } }] });
  const transport = selectContentFeedbackMaterial({ batches: Array.from({ length: 80 }, (_, index) => make(index)), scope: "scope",
    artifactRefs: [{ id: "old-answer", version: "v1" }], maximumRecords: 6, maximumChars: 12000 });

  assert.equal(transport.coverage.available, 80);
  assert.ok(transport.coverage.omitted > 0);
  assert.ok(transport.coverage.deferredRecordRefs.includes("original-79"));
  assert.ok(canonicalJson(transport.batch).length <= 12000);
  assert.ok(transport.batch.records.some(record => record.text.includes("feedback-39") && record.text.includes("feedback-0")));
  assert.ok(transport.batch.materials.some(material => material.links.artifactRefs.some(ref => ref.id === "old-answer")));
  let recovered = "", next: number | null = 0;

  while (next !== null) {
    const page = transport.readMaterial("original-79", next, 4096);
    assert.ok(page.ok);
    recovered += page.text;
    next = page.nextStart;
    assert.deepEqual(page.originalCoordinate, { runId: "original-run", sequence: 79 });
  }

  assert.equal(recovered, text);
  assert.equal(transport.listMaterials(0, 5).nextStart, 5);
  assert.deepEqual(transport.readMaterial("missing"), { ok: false, reason: "content_feedback_material_missing" });
});
