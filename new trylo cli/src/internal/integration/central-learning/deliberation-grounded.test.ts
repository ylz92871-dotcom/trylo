import test from "node:test";
import assert from "node:assert/strict";
import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { projectOrganizationDomainRows } from "./organization-feedback-domain.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";

const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 };
const request: CentralDeliberationRequest = { schemaVersion: 1, scope: "project:grounded-semantic", budgetId: "budget:grounded",
  configuration: { schemaVersion: 1, configurationRef: "configuration:grounded", authorizationRef: "authorization:grounded", allowance },
  boardSequence: 1, resources: { boardSequence: 1, budgetId: "budget:grounded", limits: { tokens: 32000, calls: 4, steps: 4 },
    occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
  stateRef: "state:grounded", state: { schemaVersion: 1, scope: "project:grounded-semantic", intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
  opportunities: [], organization: [], materials: [
    { ref: "source:case-a", kind: "source", sourceRefs: ["source:case-a"], text: "PA handled this with ordinary execution. Reviewer confirmation happened after handoff." },
    { ref: "source:case-b", kind: "source", sourceRefs: ["source:case-b"], text: "This prior issue is resolved. Confirmation happened before handoff and prevented one repeated request." },
  ], operation: { kind: "think", operationId: "operation:grounded", purpose: "Relate actual experiences.", expectedChange: "Form a source-bound reusable question.", sourceRefs: ["source:case-a", "source:case-b"] } };

function grounded() {
  return { schemaVersion: 1, sourceRefs: ["source:case-a", "source:case-b"], publicExplanation: "Compare confirmation timing across the two actual cases.",
    alternatives: [], organizationUse: null, organizationKnowledge: [], intents: [{
      intentId: "intent:confirmation", subject: { plane: "central", questionRef: "intent:confirmation" }, goal: "Learn when confirmation belongs before a handoff.",
      rationale: "The two actual cases differ in timing; the relation is a hypothesis, not an independently measured gain.",
      conditions: ["A reviewer can confirm the interface before delegation."], knowledge: [], residual: ["Does earlier confirmation help in both settings?"],
      commitment: { purpose: "Understand the timing condition.", assumptions: ["The two records describe comparable handoffs."], reconsiderWhen: ["A counterexample changes the condition."] },
      revisionReason: "A new question derived from actual material, preserving both original PA judgements.", sourceRefs: ["source:case-a", "source:case-b"],
      derivation: { relation: "Both cases involve confirmation timing relative to handoff.", whenRelevant: "A later cross-specialty delegation with uncertain reviewer timing.",
        parentRefs: ["source:case-a", "source:case-b"], citations: [
          { evidenceRef: "source:case-a", quote: "Reviewer confirmation happened after handoff." },
          { evidenceRef: "source:case-b", quote: "Confirmation happened before handoff" },
        ] },
      continuation: { kind: "ready", operation: { kind: "dispatch", operationId: "operation:compare-confirmation",
        purpose: "Compare the two timing procedures.", expectedChange: "Find the conditions for earlier confirmation.", sourceRefs: ["source:case-a", "source:case-b"],
        allowance, destination: { plane: "agent", domain: "workflow" } } },
    }] };
}

test("a central question can be grounded in ordinary/resolved actual material without an existing opportunity or invented domain issue", () => {
  const result = decodeCentralDeliberation(grounded(), request, []);
  assert.equal(result.intents[0]?.subject.plane, "central");
  assert.deepEqual(result.intents[0]?.derivation?.parentRefs, ["source:case-a", "source:case-b"]);
  assert.equal(result.intents[0]?.continuation.kind, "ready");
});

test("a derived central purpose rejects invented quotations, unseen parents and dispatch without a destination", () => {
  const noQuote = grounded();
  noQuote.intents[0]!.derivation.citations[0]!.quote = "Invented evidence that was never supplied.";
  const unseen = grounded();
  unseen.intents[0]!.derivation.parentRefs.push("source:unseen");
  const noDestination = grounded();
  const wire = JSON.parse(JSON.stringify(noDestination));
  wire.intents[0].continuation.operation.destination = null;
  for (const invalid of [noQuote, unseen, wire]) assert.throws(() => decodeCentralDeliberation(invalid, request, []));
});

test("late adoption and context-mismatch feedback use the actual source-owned wrapper, while wrong identities and decision bodies are refused", () => {
  const projected = projectOrganizationDomainRows("decision:late", { sourceRef: "frame:late", sourceRefs: ["source:case-a"], records: [
    { kind: "collaboration_dispatched", receiptId: "dispatch:actual", relevantVersionIds: ["experience:one"] },
    { kind: "collaboration_use_feedback", factRef: "collaboration:late-mismatch", usageReceiptId: "dispatch:actual",
      relevantVersionIds: ["experience:one"], outcome: "uncertain", assessments: [{ versionId: "experience:one",
        diagnosis: "context_mismatch", observations: [{ expectationId: "receiver-continues", result: "unknown", sourceRefs: [] }] }] },
  ] }, ["experience:one"]);
  const adoption = projected.find(row => row.result.kind === "adoption")!;
  const mismatch = projected.find(row => row.result.kind === "outcome")!;

  assert.equal(adoption.result.kind, "adoption");
  assert.equal(mismatch.result.kind, "outcome");
  assert.deepEqual(mismatch.result.kind === "outcome" ? { state: mismatch.result.state, attribution: mismatch.result.attribution } : {},
    { state: "unknown", attribution: "unknown" });
  assert.match(JSON.stringify(mismatch), /context_mismatch/);
  const materials = [adoption, mismatch].map((value, index) => ({ ref: `organization-record:late-${index}`, kind: "organization" as const,
    sourceRefs: value.sourceRefs, text: JSON.stringify({ role: "source_bound_organization_feedback_not_identified_economic_gain",
      factId: `organization-record:late-${index}`, sequence: index + 1, value }) }));
  const decision = { schemaVersion: 1, intents: [], publicExplanation: "Limit the research hypothesis to the actual exposure conditions.",
    sourceRefs: materials.map(row => row.ref), organizationKnowledge: [{ kind: "knowledge", knowledgeId: "knowledge:late",
      supersedes: null, statement: "Actual adoption is present, but a context mismatch does not identify benefit.",
      conditions: "Only this source exposure.", conditionKeys: ["domain:collaboration"], exceptions: "Context mismatch remains an unknown outcome.",
      exceptionKeys: ["context_mismatch"], implication: "Inspect the applicability conditions before further investment.",
      supportFactIds: [materials[0]!.ref], counterexampleFactIds: [materials[1]!.ref], state: "proposed" }] };
  const actualInput = { ...request, organization: materials };

  assert.equal(decodeCentralDeliberation(decision, actualInput, []).organizationKnowledge?.[0]?.counterexampleFactIds[0], materials[1]!.ref);

  for (const change of [{ factId: "organization-record:never-delivered" }, { sequence: -1 },
    { role: "original_organization_decision_not_business_evidence" }, { value: { kind: "decision" } }]) {
    const invalid = { ...actualInput, organization: materials.map((row, index) => index === 0
      ? { ...row, text: JSON.stringify({ ...JSON.parse(row.text), ...change }) } : row) };
    assert.throws(() => decodeCentralDeliberation(decision, invalid, []), /organization_support_unbound/);
  }

  const factIds = [adoption, mismatch].map(value => buildOrganizationRecord(request.scope, value).id);
  const presented = [adoption, mismatch].map((value, index) => createOrganizationFeedbackMaterial(request.scope, factIds[index]!, value));
  const presentedInput = { ...request, organization: presented };
  const sourceBoundDecision = { ...decision, sourceRefs: presented.map(row => row.ref),
    organizationKnowledge: decision.organizationKnowledge.map(value => ({ ...value,
      supportFactIds: [factIds[0]!], counterexampleFactIds: [factIds[1]!] })) };
  const accepted = decodeCentralDeliberation(sourceBoundDecision, presentedInput, []).organizationKnowledge?.[0];

  assert.deepEqual(accepted?.supportFactIds, [factIds[0]]);
  assert.deepEqual(accepted?.counterexampleFactIds, [factIds[1]]);
  const presentationSupport = { ...sourceBoundDecision, organizationKnowledge: sourceBoundDecision.organizationKnowledge.map(value => ({ ...value,
    supportFactIds: [presented[0]!.ref] })) };

  assert.throws(() => decodeCentralDeliberation(presentationSupport, presentedInput, []), /organization_support_unbound/);
  const original = presented[0]!;

  for (const altered of [
    { ...original, text: JSON.stringify({ ...JSON.parse(original.text), value: mismatch }) },
    { ...original, text: JSON.stringify({ ...JSON.parse(original.text), sequence: 1 }) },
    { ...original, sourceRefs: adoption.sourceRefs },
  ]) {
    assert.throws(() => decodeCentralDeliberation(sourceBoundDecision, { ...presentedInput,
      organization: [altered, presented[1]!] }, []), /organization_support_unbound/);
  }

  assert.throws(() => decodeCentralDeliberation(presentationSupport, { ...presentedInput,
    organization: [{ ...original, text: JSON.stringify(adoption) }, presented[1]!] }, []), /organization_support_unbound/,
  "a malformed canonical namespace cannot borrow the legacy raw feedback reader");
});
