import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import type { WorkflowImprovement, WorkflowImprovementResearchInput } from "../improvement/contracts.js";
import { searchImprovementFixture, searchImprovementWithRecoveryFixture } from "../testing/improvement-fixtures.js";
import { createWorkflowImprovementModel } from "./improvement-model.js";
import type { WorkflowResearchFinding, WorkflowResearchObservation } from "../improvement/research-contracts.js";
import { parseWorkflowResearchFinding } from "../improvement/research-finding.js";

const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };

function context(): WorkflowImprovementResearchInput {
  const source = searchImprovementFixture();
  return { opportunity: source.opportunity, evidence: source.evidence, feedback: [], observations: [] };
}

function modelFor(responses: readonly { readonly text: string; readonly complete?: boolean; readonly totalTokens?: number }[]) {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    const response = responses[requests.length]!;
    requests.push(request);
    yield { type: "text_delta", blockId: "research", text: response.text };
    if (response.complete !== false) {
      yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: 20, totalTokens: response.totalTokens ?? 40 } };
      yield finish;
    }
  } };
  const model = createWorkflowImprovementModel({ provider, model: "test" });

  return { requests, model };
}

test("workflow research honors the host output allocation beyond the former 6144 ceiling", async () => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { responseFormats: ["json_object"], async *stream(request) {
    requests.push(request);
    const complete = (request.maxOutputTokens ?? 0) >= 9000;
    if (complete) yield { type: "text_delta", blockId: "result", text: JSON.stringify({ kind: "stop", reason: "No justified further research remains." }) };
    yield { type: "finish", reason: complete ? "stop" : "length", rawReason: complete ? "stop" : "length", requiresFollowUp: false };
    const outputTokens = complete ? 9000 : request.maxOutputTokens ?? 0;
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens, totalTokens: outputTokens + 20 } };
  } };
  const model = createWorkflowImprovementModel({ provider, model: "test", maxOutputTokens: 32768 });

  assert.equal((await model.research!(context(), new AbortController().signal, 64000)).ok, true);
  assert.equal(requests[0]?.maxOutputTokens, 32768);
  assert.deepEqual(requests[0]?.responseFormat, { type: "json_object" });
  assert.deepEqual(model.researchUsage!(), { calls: 1, tokens: 9020, observedTokens: 9020, uncertain: false });
});

test("workflow research sends original material beyond 24k when the caller funds its context", async () => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "result", text: JSON.stringify({ kind: "stop", reason: "Original material reviewed." }) };
    yield finish;
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10000, outputTokens: 20, totalTokens: 10020 } };
  } };
  const material = { ref: "central-runtime-context:original-material", text: "Source-bound original facts. ".repeat(1100) };
  const input = { ...context(), centralContent: material };
  const model = createWorkflowImprovementModel({ provider, model: "test", maxPromptChars: 100000, maxOutputTokens: 32768 });

  assert.equal((await model.research!(input, new AbortController().signal, 160000)).ok, true);
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.messages[1]!.content.length > 24000);
  assert.deepEqual(JSON.parse(requests[0]!.messages[1]!.content).currentMaterial.centralContent, material);
  assert.equal(requests[0]!.maxOutputTokens, 32768);
});

test("workflow research retains known final usage after a length boundary", async () => {
  const provider: ProviderPort = { async *stream(request) {
    yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
    const outputTokens = request.maxOutputTokens ?? 0;
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens, totalTokens: outputTokens + 20 } };
  } };
  const model = createWorkflowImprovementModel({ provider, model: "test", maxOutputTokens: 10000 });
  const result = await model.research!(context(), new AbortController().signal, 64000);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "learning_incomplete");

  assert.deepEqual(model.researchUsage!(), { calls: 1, tokens: 10020, observedTokens: 10020, uncertain: false });
});

test("workflow research does not impose the former default 90 second deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let continueResponse: () => void = () => {};
  let started = false;
  const gate = new Promise<void>(resolve => { continueResponse = resolve; });
  const provider: ProviderPort = { async *stream(_request, signal) {
    started = true;
    await gate;
    if (signal.aborted) throw new Error("The host cancelled healthy research");
    yield { type: "text_delta", blockId: "result", text: JSON.stringify({ kind: "stop", reason: "Research completed after continued computation." }) };
    yield finish;
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: 20, totalTokens: 40 } };
  } };
  const model = createWorkflowImprovementModel({ provider, model: "test" });
  const pending = model.research!(context(), new AbortController().signal, 64000);

  await Promise.resolve();
  assert.equal(started, true);
  t.mock.timers.tick(90001);
  continueResponse();
  assert.equal((await pending).ok, true);
});

test("research exposes requested facts only and requires a new funded call to correct an unexposed proposal", async () => {
  const proposal = searchImprovementFixture().proposal;
  const fx = modelFor([{ text: JSON.stringify({ kind: "propose", proposal }) }, { text: JSON.stringify({ kind: "propose", proposal }) }]);
  const first = await fx.model.research!(context(), new AbortController().signal, 32000);

  assert.equal(first.ok, false);

  if (!first.ok) assert.equal(first.code, "improvement_evidence_unexposed");

  assert.equal(fx.requests.length, 1, "an invalid response must not cause an adapter retry");
  const originalPrompt = JSON.parse(fx.requests[0]!.messages[1]!.content);

  assert.deepEqual(originalPrompt.currentMaterial.evidence, []);
  assert.equal(originalPrompt.materialIndex.entries.length, context().evidence.length);
  const next = await fx.model.research!({ ...context(), observations: [
    { kind: "invalid_response", code: "improvement_evidence_unexposed", message: "Read the supporting facts before proposing." },
    { kind: "material_read", evidenceRefs: proposal.diagnosis.supportingRefs },
  ] }, new AbortController().signal, 32000);

  assert.equal(next.ok, true);

  if (next.ok) assert.equal(next.value.kind, "propose");

  assert.equal(fx.requests.length, 2);
  const supplied = JSON.parse(fx.requests[1]!.messages[1]!.content);

  assert.deepEqual(supplied.currentMaterial.evidence.map((item: { ref: string }) => item.ref), [...proposal.diagnosis.supportingRefs]);
});

test("research material selection is replaceable and a prior unknown call does not poison later measured usage", async () => {
  const fx = modelFor([{ text: JSON.stringify({ kind: "read_material", evidenceRefs: ["receipt:search-1"] }), complete: false },
    { text: JSON.stringify({ kind: "read_material", evidenceRefs: ["receipt:search-2"] }) }]);

  assert.equal((await fx.model.research!(context(), new AbortController().signal, 32000)).ok, false);
  assert.equal(fx.model.researchUsage!().uncertain, true);
  assert.equal(fx.model.researchUsage!().calls, 1);
  assert.ok(fx.model.researchUsage!().tokens > 40);
  const second = await fx.model.research!({ ...context(), observations: [
    { kind: "material_read", evidenceRefs: ["receipt:search-1"] },
    { kind: "material_read", evidenceRefs: ["receipt:layout"] },
  ] }, new AbortController().signal, 32000);

  assert.equal(second.ok, true);
  assert.deepEqual(fx.model.researchUsage!(), { calls: 1, tokens: 40, observedTokens: 40, uncertain: false });
  assert.deepEqual(fx.model.usage(), { calls: 0, tokens: 0, observedTokens: 0, uncertain: false });
  const supplied = JSON.parse(fx.requests[1]!.messages[1]!.content);

  assert.deepEqual(supplied.currentMaterial.evidence.map((item: { ref: string }) => item.ref), ["receipt:layout"]);
});

test("bounded exact research actions reject unknown refs, extra authority and oversized requests without local retries", async () => {
  const responses = [
    { kind: "read_material", evidenceRefs: ["missing"] },
    { kind: "read_material", evidenceRefs: Array.from({ length: 9 }, (_value, i) => `evidence:${i}`) },
    { kind: "compare_versions", versionIds: Array.from({ length: 5 }, (_value, i) => `version:${i}`) },
    { kind: "stop", reason: "x".repeat(1501) },
    { kind: "stop", reason: "Done", permission: "approved" },
    { kind: "wait_for_evidence", reason: "Need the next actual task observation", evidenceRefs: [] },
  ];
  const fx = modelFor(responses.map(value => ({ text: JSON.stringify(value) })));

  for (let i = 0; i < responses.length; i++) {
    const result = await fx.model.research!(context(), new AbortController().signal, 32000);
    assert.equal(result.ok, i === responses.length - 1);
    assert.equal(fx.requests.length, i + 1);
  }
});

test("research version material preserves the nominated local edit scope", async () => {
  const source = searchImprovementWithRecoveryFixture();
  const parent: WorkflowImprovement = { type: "workflow_improvement", schemaVersion: 1, opportunity: source.opportunity,
    proposal: source.proposal, evidence: source.evidence, claim: "proposed_improvement" };
  const fx = modelFor([{ text: JSON.stringify({ kind: "compare_versions", versionIds: ["parent:v1"] }) },
    { text: JSON.stringify({ kind: "stop", reason: "No justified local edit follows from the supplied facts." }) }]);
  const input = { ...context(), opportunity: { ...source.opportunity, affectedStepIds: ["scoped-search"] }, parent,
    history: [{ versionId: "parent:v1", artifact: parent }] };

  assert.equal((await fx.model.research!(input, new AbortController().signal, 64000)).ok, true);
  assert.equal((await fx.model.research!({ ...input, observations: [{ kind: "versions_compared", versionIds: ["parent:v1"] }] },
    new AbortController().signal, 64000)).ok, true);
  const supplied = JSON.parse(fx.requests[1]!.messages[1]!.content);
  const material = supplied.comparedVersions[0].procedure;

  assert.equal(material.steps, undefined);
  assert.deepEqual(material.editableSteps.map((step: { id: string }) => step.id), ["confirm-owner", "scoped-search"]);
  assert.equal(material.stepsOutline.some((step: { id: string }) => step.id === "recover-moved-owner"), true);
});

test("invalid observations and insufficient envelopes return zero-call accounting", async () => {
  const fx = modelFor([]);
  const result = await fx.model.research!(context(), new AbortController().signal, 1024);
  assert.equal(result.ok, false);
  assert.equal(fx.requests.length, 0);
  assert.deepEqual(fx.model.researchUsage!(), { calls: 0, tokens: 0, observedTokens: 0, uncertain: false });
});

function finding(overrides: Partial<WorkflowResearchFinding> = {}): WorkflowResearchFinding {
  return { kind: "hypothesis", statement: "Repeated broad search may be caused by discarding the previously located owner.",
    conditions: "The owner still exists in the current repository snapshot.", sourceRefs: ["receipt:search-1"],
    nextQuestion: "Does a scoped search preserve completeness under the same source-evidence check?", ...overrides };
}

test("recorded findings require exposed sources rather than directory entries", async () => {
  const learned = finding();
  const fx = modelFor([{ text: JSON.stringify({ kind: "record_finding", finding: learned }) },
    { text: JSON.stringify({ kind: "record_finding", finding: learned }) }]);
  const unseen = await fx.model.research!(context(), new AbortController().signal, 32000);

  assert.equal(unseen.ok, false);

  if (!unseen.ok) assert.equal(unseen.code, "improvement_evidence_unexposed");

  const read = await fx.model.research!({ ...context(), observations: [{ kind: "material_read", evidenceRefs: learned.sourceRefs }] },
    new AbortController().signal, 32000);

  assert.deepEqual(read, { ok: true, value: { kind: "record_finding", finding: learned } });
  assert.equal(fx.requests.length, 2);
});

test("a finding may interpret an exposed compared version but cannot cite its directory entry", async () => {
  const source = searchImprovementFixture();
  const artifact: WorkflowImprovement = { type: "workflow_improvement", schemaVersion: 1, opportunity: source.opportunity,
    proposal: source.proposal, evidence: source.evidence, claim: "proposed_improvement" };
  const learned = finding({ kind: "interpretation", sourceRefs: ["workflow:previous"] });
  const fx = modelFor([{ text: JSON.stringify({ kind: "record_finding", finding: learned }) },
    { text: JSON.stringify({ kind: "record_finding", finding: learned }) }]);
  const input = { ...context(), history: [{ versionId: "workflow:previous", artifact }] };
  const indexed = await fx.model.research!(input, new AbortController().signal, 64000);

  assert.equal(indexed.ok, false);
  const exposed = await fx.model.research!({ ...input, observations: [{ kind: "versions_compared", versionIds: ["workflow:previous"] }] },
    new AbortController().signal, 64000);

  assert.deepEqual(exposed, { ok: true, value: { kind: "record_finding", finding: learned } });
});

test("the latest eight findings retain conditions and unresolved source pointers after context changes", async () => {
  const observations: WorkflowResearchObservation[] = Array.from({ length: 10 }, (_value, i) => ({ kind: "finding_recorded",
    finding: finding({ statement: `Working interpretation ${i}`, conditions: `Only under source condition ${i}`,
      sourceRefs: [`old-source:${i}`], nextQuestion: `What observation distinguishes interpretation ${i}?` }) }));
  const fx = modelFor([{ text: JSON.stringify({ kind: "stop", reason: "The new source context needs a different bounded investigation." }) }]);
  const nextContext = { ...context(), observations, opportunity: { ...context().opportunity, evidenceRefs: ["new-source"] },
    evidence: [{ ref: "new-source", kind: "context" as const, summary: "A different repository layout now applies." }] };

  assert.equal((await fx.model.research!(nextContext, new AbortController().signal, 64000)).ok, true);
  const supplied = JSON.parse(fx.requests[0]!.messages[1]!.content);

  assert.equal(supplied.recentFindings.length, 8);
  assert.equal(supplied.omittedFindings, 2);
  assert.deepEqual(supplied.recentFindings.map((item: { finding: WorkflowResearchFinding }) => item.finding),
    observations.slice(-8).map(item => item.kind === "finding_recorded" ? item.finding : undefined));
  assert.deepEqual(supplied.currentMaterial.evidence, []);
  assert.equal(supplied.observations.some((item: WorkflowResearchObservation) => item.kind === "finding_recorded"), false,
    "older findings must not reappear through the ordinary observation list");
  assert.deepEqual(supplied.recentFindings[0].sourceStatus, [{ ref: "old-source:2", resolvedInCurrentContext: false, exposedInThisCall: false }]);
  assert.match(fx.requests[0]!.messages[0]!.content, /findings do not resolve those sources, create new evidence/);
});

test("a retained finding never substitutes for currently exposed proposal evidence", async () => {
  const proposal = searchImprovementFixture().proposal;
  const learned = finding({ sourceRefs: proposal.diagnosis.supportingRefs });
  const fx = modelFor([{ text: JSON.stringify({ kind: "propose", proposal }) }]);
  const result = await fx.model.research!({ ...context(), observations: [{ kind: "finding_recorded", finding: learned }] },
    new AbortController().signal, 32000);

  assert.equal(result.ok, false);

  if (!result.ok) assert.equal(result.code, "improvement_evidence_unexposed");

  const supplied = JSON.parse(fx.requests[0]!.messages[1]!.content);

  assert.equal(supplied.recentFindings[0].sourceStatus.every((item: { exposedInThisCall: boolean }) => !item.exposedInThisCall), true);
});

test("the reusable finding parser rejects oversized, duplicate, empty or authority-bearing shapes", () => {
  assert.deepEqual(parseWorkflowResearchFinding(finding()), { ok: true, value: finding() });
  for (const raw of [finding({ statement: "x".repeat(1501) }), finding({ conditions: "x".repeat(1001) }),
    finding({ nextQuestion: "x".repeat(1001) }), finding({ sourceRefs: [] }), finding({ sourceRefs: ["same", "same"] }),
    finding({ sourceRefs: Array.from({ length: 9 }, (_value, i) => `source:${i}`) }), { ...finding(), permission: "approved" },
    { ...finding(), kind: "verified_fact" }]) assert.equal(parseWorkflowResearchFinding(raw).ok, false);
});
