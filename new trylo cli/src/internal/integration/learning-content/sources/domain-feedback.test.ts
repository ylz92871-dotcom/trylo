import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoardState } from "../../../learning/control/state.js";
import { canonicalJson } from "../../../learning/control/hash.js";
import { readDomainFeedbackMaterial, contentDomainFeedbackFingerprint, readContentDomainFeedbackBasis,
  type ContentDomainFeedback } from "./domain-feedback.js";
import { createTaskSourcePageReader } from "../task-source-pages.js";

test("domain owner facts retain original roles/units, stable basis, exact deferred pages and explicit source gaps", async () => {
  const first: ContentDomainFeedback = { sourceRef: "tool-feedback:stable", sourceRefs: ["use:1", "correction:1"], records: [
    { role: "actual_use", artifactRef: "tool:v1", reportStatus: "returned", taskResult: "unknown", learningGain: "unknown" },
    { role: "user_correction", text: "The returned answer did not satisfy the original requirement.", sourceRef: "correction:1" },
    { role: "actual_cost", value: 32, unit: "input_tokens", sourceRef: "usage:1" },
  ] };
  const large: ContentDomainFeedback = { sourceRef: "method-feedback:large", sourceRefs: ["review:2"], records: [{
    role: "checker_report", verdict: "unverified", originalOutput: "x".repeat(70000) }] };
  const input = { board: emptyBoardState(), scope: "repo:a", domain: "tool" as const, issueIds: ["issue:1", "issue:2", "issue:absent"],
    signal: new AbortController().signal, maximumChars: 10000,
    domainFeedback: async (_board: ReturnType<typeof emptyBoardState>, issueId: string) => issueId === "issue:1" ? first : issueId === "issue:2" ? large : undefined };
  const read = await readDomainFeedbackMaterial(input);
  assert.ok(read.ok);
  assert.deepEqual(read.value.coverage.absentIssueIds, ["issue:absent"]);
  assert.deepEqual(read.value.coverage.gaps, []);
  assert.equal(read.value.coverage.frames[0]?.transport, "inline");
  assert.equal(read.value.coverage.frames[1]?.transport, "manifest");
  assert.ok(canonicalJson(read.value.batch).includes("input_tokens"));
  assert.ok(canonicalJson(read.value.batch).includes("learningGain"));
  const basis = readContentDomainFeedbackBasis(read.value.batch, "issue:1");
  assert.equal(basis.length, 1);
  assert.equal(readContentDomainFeedbackBasis(read.value.batch, "issue:2").length, 1);
  assert.equal(basis[0]?.fingerprint, contentDomainFeedbackFingerprint(first));
  const again = await readDomainFeedbackMaterial({ ...input, board: { ...input.board, sequence: 100 } });
  assert.ok(again.ok);
  assert.equal(readContentDomainFeedbackBasis(again.value.batch, "issue:1")[0]?.fingerprint, basis[0]?.fingerprint);
  assert.notEqual(contentDomainFeedbackFingerprint({ ...first, records: [...first.records, { role: "late_correction", text: "New source evidence." }] }), basis[0]?.fingerprint);
  const tampered = { ...read.value.batch, records: read.value.batch.records.map(row => row.ref.startsWith("domain-feedback-basis:") ? { ...row, text: row.text.replace("stable", "mutated") } : row) };

  assert.throws(() => readContentDomainFeedbackBasis(tampered), /content_domain_feedback_basis_invalid/);
  const missing = { async readMaterial() { return { ok: false as const, reason: "content_material_missing" }; } };
  const pages = createTaskSourcePageReader({ session: missing, board: missing,
    feedback: { readMaterial: () => ({ ok: false as const, reason: "content_feedback_material_missing" as const }) }, domainFeedback: read.value });
  const page = await pages.read(large.sourceRef, new AbortController().signal, 68000, 8192);
  assert.ok(page.ok);
  assert.equal(page.value.owner, "domain_feedback");
  assert.equal(page.value.origin, "model_proposal");
  assert.equal(page.value.sourceHash, read.value.coverage.frames[1]?.sourceHash);
  assert.ok(page.value.coordinate.runId.startsWith("domain-feedback-frame-projection:"));
  const gap = await readDomainFeedbackMaterial({ scope: "repo:a", domain: "tool", issueIds: ["issue:1"], signal: input.signal,
    reader: async () => { throw new Error("source unavailable"); } });

  assert.ok(!gap.ok);
  assert.equal(gap.coverage.gaps[0]?.reason, "reader_failed");
  const invalid = await readDomainFeedbackMaterial({ ...input, issueIds: ["issue:1"], domainFeedback: async () => ({
    sourceRef: "invalid", sourceRefs: [], records: [{ value: Infinity }] }) });

  assert.ok(!invalid.ok);
  assert.equal(invalid.coverage.gaps[0]?.reason, "frame_invalid");
  const capacity = await readDomainFeedbackMaterial({ ...input, maximumChars: 1024 });
  assert.ok(!capacity.ok);
  assert.equal(capacity.reason, "content_domain_feedback_capacity");
});
