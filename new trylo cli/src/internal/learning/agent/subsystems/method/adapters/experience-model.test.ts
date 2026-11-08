import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import type { CentralLearningUsage } from "../../../../control/coordination-contract.js";
import type { ExperienceReviewRequest } from "../experience-port.js";
import { createExperienceModel, ExperienceModelError, type ExperienceFundingPort } from "./experience-model.js";
import { procedureFixture } from "../testing/procedure-fixture.js";
import { packReviewMaterial } from "./review-material.js";
import { boundedContextResult, MAX_CONTEXT_RESULT_BYTES } from "./context-result-budget.js";
import { scopeCaption, MAX_SCOPE_DESCRIPTION_CHARS } from "../domain/scope-description.js";

const REQUEST: ExperienceReviewRequest = { snapshotId: "snapshot", versionId: "v1", method: "Inspect before retrying.", confidence: .99,
  observations: [], counterexamples: [], scope: { id: "h1", scopeId: "scope", versionId: "v1", proposedSequence: 0,
    predicate: { all: [{ feature: "operation", value: "retry" }], exclude: [] } } };
const REVIEW = { decision: "defer", score: .6, reason: "Insufficient variety of observed tasks.", sources: ["v1"] };

function harness(output: unknown = REVIEW, custom?: (signal: AbortSignal) => AsyncIterable<ProviderEvent>) {
  const requests: ProviderRequest[] = [], reservations: number[] = [], settlements: CentralLearningUsage[] = [];
  const child: ProviderPort = { async *stream(request, signal) {
    requests.push(request);
    if (custom !== undefined) {
      yield* custom(signal);
      return;
    }
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "text_delta", blockId: "b", text: JSON.stringify(output) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 30, totalTokens: 150 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const provider: ProviderPort = { fork: () => child, stream: child.stream };
  const funding: ExperienceFundingPort = {
    async inspect() { return { ok: true, active: true, remaining: { tokens: 24000, calls: 4, steps: 4 }, maxPromptChars: 12000 }; },
    async reserve(input) {
      reservations.push(input.maxTokens);
      return { ok: true, status: "reserved" };
    },
    async settle(input) {
      settlements.push(input.usage);
      return { ok: true };
    },
  };

  return { requests, reservations, settlements, provider, funding,
    model: createExperienceModel({ provider, funding, turnId: "task", model: "test" }) };
}

test("a genuine semantic deferral preserves M and charges one real tool-free call", async () => {
  const h = harness();

  assert.deepEqual(await h.model.review(REQUEST, new AbortController().signal), REVIEW);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0]?.tools, []);
  assert.equal(h.requests[0]?.maxOutputTokens, 1500);
  assert.ok(h.reservations[0]! <= 12000);
  assert.deepEqual(h.settlements, [{ kind: "reported", totalTokens: 150, inputTokens: 120, outputTokens: 30, model: "test" }]);
  await assert.rejects(h.model.review({ ...REQUEST, snapshotId: "new" }, new AbortController().signal), { reason: "method_review_turn_limit" });
  assert.equal(h.requests.length, 1);
});

test("no central allowance means no provider call and no invented M judgment", async () => {
  const h = harness(), model = createExperienceModel({ provider: h.provider, model: "test", turnId: "task" });
  await assert.rejects(model.review(REQUEST, new AbortController().signal), { reason: "method_review_unfunded" });
  assert.equal(h.requests.length, 0);
});

test("a provider-observed overrun is not hidden by an unknown capped settlement", async () => {
  const h = harness(REVIEW, async function* () {
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 50000, totalTokens: 50000 } };
    throw new Error("the adapter must abort at the known overrun");
  });

  await assert.rejects(h.model.review(REQUEST, new AbortController().signal), { reason: "method_review_budget_overrun" });
  assert.deepEqual(h.settlements, [{ kind: "reported", totalTokens: 50000, inputTokens: 50000, outputTokens: 0, model: "test" }],
    "the observed lower bound must reach the central overrun closure");
});

test("cancelled partial output is charged unknown and cannot become model consent", async () => {
  const abort = new AbortController();
  const h = harness(REVIEW, async function* () {
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "text_delta", blockId: "b", text: JSON.stringify({ ...REVIEW, decision: "promote", score: 1 }) };
    abort.abort();
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  });

  await assert.rejects(h.model.review(REQUEST, abort.signal), { reason: "method_review_cancelled" });
  assert.equal(h.settlements[0]?.kind, "unknown");
});

test("malformed model output and truncated finish cannot be a subjective decision", async () => {
  const malformed = harness({ ...REVIEW, score: 2 });

  await assert.rejects(malformed.model.review(REQUEST, new AbortController().signal), { reason: "method_review_shape_invalid" });
  const cut = harness(REVIEW, async function* () {
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "text_delta", blockId: "b", text: JSON.stringify(REVIEW) };
    yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
  });

  await assert.rejects(cut.model.review(REQUEST, new AbortController().signal), ExperienceModelError);
});

test("a scope proposal survives transport validation without turning into evidence", async () => {
  const h = harness({ ...REVIEW, decision: "narrow", scopes: [REQUEST.scope] });
  const review = await h.model.review(REQUEST, new AbortController().signal);
  assert.deepEqual(review.scopes, [REQUEST.scope]);
  assert.equal(REQUEST.observations.length, 0);
});

test("model decoding reuses canonical source, method and compact shape limits", async t => {
  const invalid = [
    { label: "source limit", output: { ...REVIEW, sources: Array.from({ length: 9 }, (_, index) => `v${index}`) } },
    { label: "method limit", output: { ...REVIEW, decision: "behavior", revisedMethod: "x".repeat(201) } },
    { label: "compact closed shape", output: { ...REVIEW, compact: { when: "retry", action: "inspect", exceptions: "unknown",
      permissions: "grant extra access" } } },
  ];
  for (const item of invalid) await t.test(item.label, async () => {
    const h = harness(item.output);
    await assert.rejects(h.model.review(REQUEST, new AbortController().signal), { reason: "method_review_shape_invalid" });
    assert.equal(h.requests.length, 1);
  });
});

test("prompt size and exhausted reservations fail before spending", async () => {
  const h = harness();

  await assert.rejects(h.model.review({ ...REQUEST, method: "x".repeat(13000) }, new AbortController().signal), { reason: "method_review_prompt_limit" });
  assert.equal(h.requests.length, 0);
  assert.equal(h.reservations.length, 0);
  const model = createExperienceModel({ provider: h.provider, model: "test", turnId: "task", funding: { ...h.funding,
    async reserve() { return { ok: false, reason: "learning_grant_exhausted" }; } } });

  await assert.rejects(model.review(REQUEST, new AbortController().signal), { reason: "learning_grant_exhausted" });
  assert.equal(h.requests.length, 0);
});

test("a larger honest evidence view can reserve above 6000 without raising the lifetime allowance", async () => {
  const h = harness();
  await h.model.review({ ...REQUEST, counterexamples: ["counterexample ".repeat(350)] }, new AbortController().signal);
  assert.equal(h.requests.length, 1);
  assert.ok(h.reservations[0]! > 6000 && h.reservations[0]! <= 12000);
  assert.equal(h.requests[0]?.maxOutputTokens, 1500);
});

test("a transport ignoring abort cannot hold the review open after its deadline", async () => {
  let start: () => void = () => {}, expire: () => void = () => {};
  const entered = new Promise<void>(resolve => { start = resolve; });
  const h = harness(REVIEW, async function* () {
    start();
    await new Promise<void>(() => {});
  });
  const model = createExperienceModel({ provider: h.provider, funding: h.funding, turnId: "task", model: "test",
    scheduler: (_delay, fire) => {
      expire = fire;
      return { cancel() {} };
    } });
  const result = model.review(REQUEST, new AbortController().signal);

  await entered;
  expire();
  await assert.rejects(result, { reason: "method_review_timeout" });
  assert.deepEqual(h.settlements, [{ kind: "unknown", reason: "method_review_timeout" }]);
});

const SOURCE_REQUEST: ExperienceReviewRequest = { ...REQUEST, observations: [{ observationId: "source-help", taskId: "source-task",
  opportunityId: "retry", versionId: "v1", scopeId: "scope", sequence: 1, revision: 0, adoption: "adopted",
  outcome: "helped", source: "self_report", features: { operation: "retry" } }] };

function compiledReview(request = SOURCE_REQUEST) {
  return { decision: "promote" as const, score: .9, reason: "Retain the supported source action and result check.", sources: ["v1"],
    compact: { when: "retry", action: "Inspect.", exceptions: "Unknown: block." }, procedure: procedureFixture(request, "Inspect.", "retry", "known result") };
}

test("new compiler output requires real source IR, complete artifacts and fieldable delivery", async () => {
  const good = compiledReview();

  assert.deepEqual(await harness(good).model.review(SOURCE_REQUEST, new AbortController().signal), good);
  await assert.rejects(harness({ ...good, procedure: undefined }).model.review(SOURCE_REQUEST, new AbortController().signal),
    { reason: "method_review_procedure_required" });
  const forged = { ...good, procedure: { ...good.procedure, eliminatedDecisions: good.procedure.eliminatedDecisions.map(item => ({ ...item, evidenceIds: ["unseen"] })) } };

  await assert.rejects(harness(forged).model.review(SOURCE_REQUEST, new AbortController().signal), { reason: "procedure_source_evidence_unavailable" });
  await assert.rejects(harness({ ...good, compact: { ...good.compact, when: "x".repeat(500) } }).model.review(SOURCE_REQUEST, new AbortController().signal),
    { reason: "method_compilation_slot_limit" });
  await assert.rejects(harness({ ...good, decision: "narrow", procedure: undefined }).model.review(SOURCE_REQUEST, new AbortController().signal),
    { reason: "method_review_procedure_required" });
});

test("positive evidence corrections allow ordinary practice, real repair rejects no-op and host reentry permits reconsideration", async () => {
  const good = compiledReview();
  const current = { compilationId: "c1", compact: good.compact, procedure: good.procedure, sources: good.sources, withdrawn: false };
  const request: ExperienceReviewRequest = { ...SOURCE_REQUEST, currentCompilation: { ...current, repairRequired: false },
    reconsideration: { compilationId: "c1", reason: "evidence_change", evidenceRevisions: ["compiled:1"],
      observations: [{ ...SOURCE_REQUEST.observations[0]!, observationId: "compiled", compilationId: "c1", revision: 1 }], confidence: .8, changeProbability: 0 } };

  assert.equal((await harness(good).model.review(request, new AbortController().signal)).decision, "promote");
  await assert.rejects(harness(good).model.review({ ...request, currentCompilation: { ...current, repairRequired: true } },
    new AbortController().signal), { reason: "method_review_unchanged_procedure" });
  const requalified = { ...request, currentCompilation: { ...current, repairRequired: true, withdrawn: true,
    reentry: { afterSequence: 3, successes: 10, failures: 0, confidence: .99 } } };

  assert.equal((await harness(good).model.review(requalified, new AbortController().signal)).decision, "promote");
});

test("UTF-8 packing preserves prior assessment and identities while omitted observations cannot be cited", async () => {
  const previousAssessment = { reviewId: "prior", snapshotId: "prior-snapshot", decision: "defer" as const,
    score: .3, reason: "Need a distinct boundary example.", excerpted: false };
  const request: ExperienceReviewRequest = { ...SOURCE_REQUEST, previousAssessment,
    observations: [...SOURCE_REQUEST.observations, { ...SOURCE_REQUEST.observations[0]!, observationId: "large-help", taskId: "other",
      features: { operation: "retry", detail: "中".repeat(160) } }], counterexamples: ["负".repeat(1800)] };
  const packed = packReviewMaterial(request, 1700, 2200);

  assert.ok(packed.ok);
  assert.deepEqual(packed.supplied.previousAssessment, previousAssessment);
  assert.equal(packed.supplied.snapshotId, request.snapshotId);
  assert.ok(new TextEncoder().encode(packed.material).length <= 2200);
  assert.ok(JSON.parse(packed.material).packing.omitted.counterexamples > 0);
  const omitted = { ...SOURCE_REQUEST.observations[0]!, observationId: "omitted-help", taskId: "oversize-source",
    features: Object.fromEntries(Array.from({ length: 24 }, (_value, index) => [`detail${index}`, "中".repeat(160)])) };
  const original = { ...SOURCE_REQUEST, observations: [...SOURCE_REQUEST.observations, omitted] };
  const h = harness(compiledReview({ ...SOURCE_REQUEST, observations: [omitted] }));

  await assert.rejects(h.model.review(original, new AbortController().signal), { reason: "procedure_source_evidence_unavailable" });
  const actual = JSON.parse(h.requests[0]!.messages.find(item => item.role === "user")!.content) as ExperienceReviewRequest;

  assert.equal(actual.observations.some(item => item.observationId === omitted.observationId), false,
    "the cited id existed in the original request but its whole record did not reach the provider");
});

test("stable reservation identity spans turns and concurrent review starts produce one stream", async () => {
  const h = harness(), seen = new Set<string>();
  const funding: ExperienceFundingPort = { ...h.funding, async reserve(input) {
    if (seen.has(input.reservationId)) return { ok: true, status: "duplicate" };
    seen.add(input.reservationId);
    return { ok: true, status: "reserved" };
  } };
  const first = createExperienceModel({ provider: h.provider, funding, turnId: "first", model: "test" });
  const second = createExperienceModel({ provider: h.provider, funding, turnId: "second", model: "test" });

  await first.review(REQUEST, new AbortController().signal);
  await assert.rejects(second.review(REQUEST, new AbortController().signal), { reason: "method_review_already_reserved" });
  assert.equal(h.requests.length, 1);
  const concurrent = harness();
  const results = await Promise.allSettled([concurrent.model.review(REQUEST, new AbortController().signal),
    concurrent.model.review(REQUEST, new AbortController().signal)]);

  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(concurrent.requests.length, 1);
});

test("context response keeps complete literals and JSON under UTF-8 budget and scope captions fit their persisted grammar", () => {
  const conditions = Array.from({ length: 4 }, (_value, index) => ({ versionId: `v${index}`, scopeId: "scope", condition: "中".repeat(240),
    missing: Array.from({ length: 6 }, (_item, literal) => ({ relation: "required", feature: `f${literal}` + "中".repeat(60), expectedValue: "中".repeat(160) })) }));
  const result = boundedContextResult({ status: "context_ready", selected: [], next: { phase: "clarify_scope_facts", conditions } });

  assert.ok(result);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= MAX_CONTEXT_RESULT_BYTES);
  const parsed = JSON.parse(JSON.stringify(result));

  assert.ok(parsed.next.omitted.conditions > 0);

  for (const condition of parsed.next.conditions) assert.deepEqual(condition.missing, conditions[0]!.missing);

  const caption = scopeCaption("😀".repeat(1000), MAX_SCOPE_DESCRIPTION_CHARS);

  assert.ok(caption.length <= MAX_SCOPE_DESCRIPTION_CHARS && caption.endsWith("…"));
  assert.equal(caption.includes("\uFFFD"), false);
});
