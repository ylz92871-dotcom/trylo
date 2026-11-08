import test from "node:test";
import assert from "node:assert/strict";
import { groundLearningTopic } from "./ground.js";
import { TOPIC_LIMITS, type TopicDraft, type TopicEvidenceWindow } from "./contracts.js";
import { sha256Hex } from "../../../control/hash.js";

function evidenceWindow(): TopicEvidenceWindow {
  return { schemaVersion: 1, domain: "prompt", scope: "workspace:one", boardSequence: 7,
    watermarks: [{ runId: "run-one", throughSequence: 3 }], records: [
      { ref: "event-one", runId: "run-one", sequence: 2, scope: "workspace:one",
        origin: "execution_result", text: "解析失败：带 BOM 的输入在首列多出一个字符。" },
      { ref: "event-two", runId: "run-one", sequence: 3, scope: "workspace:one",
        origin: "checker_result", text: "同内容去掉 BOM 后，外部检查通过。" },
    ] };
}

function draft(): TopicDraft {
  return { schemaVersion: 1, question: "怎样区分输入编码标记与字段解析逻辑导致的首列错误？",
    whenRelevant: "同类输入文件在第一列出现额外字符时", expectedChange: "先核对编码边界，再决定是否修改解析步骤。",
    citations: [{ evidenceRef: "event-one", quote: "带 BOM 的输入在首列多出一个字符" }],
    alternatives: [{ id: "encoding", explanation: "编码标记被当成字段正文。" },
      { id: "parser", explanation: "字段切分本身处理错误。" }],
    discriminator: { observation: "固定字段内容，分别检查有无编码标记时的首列结果。", hypothesisIds: ["encoding", "parser"] } };
}

const run = (proposal: unknown = draft(), window: unknown = evidenceWindow()) =>
  groundLearningTopic(JSON.stringify(proposal), JSON.stringify(window));

test("open semantic topic is grounded without assigning it a failure-code lesson", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.question, draft().question);
  assert.equal(result.value.domain, "prompt");
  assert.equal(result.value.scope, "workspace:one");
  assert.equal(result.value.status, "grounded_hypothesis");
});

test("host pins exact source span and hashes rather than trusting model hashes", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const citation = result.value.citations[0];
  assert.ok(citation);
  const text = evidenceWindow().records[0]!.text, quote = draft().citations[0]!.quote;
  assert.equal(text.slice(citation.start, citation.end), quote);
  assert.equal(citation.sourceHash, sha256Hex(text));
  assert.equal(citation.quoteHash, sha256Hex(quote));
});

test("grounded output is deeply immutable and its identity is reproducible", () => {
  const first = run(), second = run();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.topicId, second.value.topicId);
  assert.ok(Object.isFrozen(first.value));
  assert.ok(Object.isFrozen(first.value.alternatives));
  assert.ok(Object.isFrozen(first.value.alternatives[0]));
  assert.ok(Object.isFrozen(first.value.citations[0]));
});

test("a different open question is accepted and receives its own identity", () => {
  const result = run({ ...draft(), question: "如何识别一次成功是否只在当前输入条件下成立？" });
  const original = run();
  assert.equal(result.ok, true);
  assert.equal(original.ok, true);
  if (result.ok && original.ok) assert.notEqual(result.value.topicId, original.value.topicId);
});

for (const field of ["score", "probability", "permission", "scope", "domain"]) {
  test(`model cannot attach authoritative ${field} fields`, () => {
    assert.deepEqual(run({ ...draft(), [field]: "model assertion" }), { ok: false, reason: "topic_shape_invalid" });
  });
}

test("missing event reference is not manufactured into evidence", () => {
  assert.deepEqual(run({ ...draft(), citations: [{ evidenceRef: "invented", quote: "BOM" }] }),
    { ok: false, reason: "topic_evidence_missing" });
});

test("a quote must actually occur in the source", () => {
  assert.deepEqual(run({ ...draft(), citations: [{ evidenceRef: "event-one", quote: "解析已修复" }] }),
    { ok: false, reason: "topic_quote_missing" });
});

test("an ambiguous repeated quote cannot silently select the first occurrence", () => {
  const window = evidenceWindow();
  assert.deepEqual(run({ ...draft(), citations: [{ evidenceRef: "event-one", quote: "BOM" }] },
    { ...window, records: [{ ...window.records[0]!, text: "BOM 与 BOM 的区别" }] }),
  { ok: false, reason: "topic_quote_ambiguous" });
});

test("two identical citations cannot count as distinct support", () => {
  const citation = draft().citations[0]!;
  assert.deepEqual(run({ ...draft(), citations: [citation, citation] }), { ok: false, reason: "topic_citation_duplicate" });
});

test("model proposals alone cannot ground their own learning question", () => {
  const window = evidenceWindow();
  assert.deepEqual(run(draft(), { ...window, records: window.records.map(row => ({ ...row, origin: "model_proposal" })) }),
    { ok: false, reason: "topic_self_support_only" });
});

test("a declared future event cannot cross the host watermark", () => {
  const window = evidenceWindow();
  assert.deepEqual(run(draft(), { ...window, watermarks: [{ runId: "run-one", throughSequence: 1 }] }),
    { ok: false, reason: "topic_window_invalid" });
});

test("an event from a different scope is rejected before grounding", () => {
  const window = evidenceWindow();
  assert.deepEqual(run(draft(), { ...window, records: [{ ...window.records[0]!, scope: "workspace:two" }] }),
    { ok: false, reason: "topic_window_invalid" });
});

test("unknown or repeated hypothesis identities cannot be used by a discriminator", () => {
  assert.deepEqual(run({ ...draft(), discriminator: { observation: "观察", hypothesisIds: ["encoding", "invented"] } }),
    { ok: false, reason: "topic_shape_invalid" });
  const alternative = draft().alternatives[0]!;
  assert.deepEqual(run({ ...draft(), alternatives: [alternative, alternative] }), { ok: false, reason: "topic_shape_invalid" });
});

test("duplicate event identities and missing run watermarks invalidate the host window", () => {
  const window = evidenceWindow();
  assert.deepEqual(run(draft(), { ...window, records: [window.records[0], window.records[0]] }),
    { ok: false, reason: "topic_window_invalid" });
  assert.deepEqual(run(draft(), { ...window, watermarks: [] }), { ok: false, reason: "topic_window_invalid" });
});

test("malformed and oversized model text have closed failure reasons", () => {
  assert.deepEqual(groundLearningTopic("{raw private snippet", JSON.stringify(evidenceWindow())),
    { ok: false, reason: "topic_json_invalid" });
  assert.deepEqual(groundLearningTopic(" ".repeat(TOPIC_LIMITS.proposalChars + 1), JSON.stringify(evidenceWindow())),
    { ok: false, reason: "topic_input_size" });
});

test("changed source content changes the pinned window basis even if the cited quote remains", () => {
  const window = evidenceWindow(), first = run();
  const second = run(draft(), { ...window, records: [{ ...window.records[0]!, text: window.records[0]!.text + " 已复核" }] });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.notEqual(first.value.basis.evidenceWindowHash, second.value.basis.evidenceWindowHash);
});

test("ill-formed Unicode source text cannot alias UTF-8 evidence hashes", () => {
  const window = evidenceWindow();
  assert.deepEqual(run({ ...draft(), citations: [{ evidenceRef: "event-one", quote: "\ud800" }] },
    { ...window, records: [{ ...window.records[0]!, text: "source \ud800" }] }),
    { ok: false, reason: "topic_window_invalid" });
});

test("an exact quote cannot split a Unicode scalar into half a surrogate pair", () => {
  const window = evidenceWindow();
  assert.deepEqual(run({ ...draft(), citations: [{ evidenceRef: "event-one", quote: "\ud83d" }] },
    { ...window, records: [{ ...window.records[0]!, text: "source 😀" }] }),
    { ok: false, reason: "topic_shape_invalid" });
});
