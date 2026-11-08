import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { prepareAllocationApplication } from "../../learning/control/allocation-application-plan.js";
import { allocationAuditCommand } from "../../learning/control/allocation-application-state.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";
import type { CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { CentralLearningEvidenceInput } from "./evidence-decision-contract.js";
import { createCentralResponseWindowDraft } from "./response-registration.js";
import { decideCentralLearningWithEvidence } from "./evidence-decision.js";
import { createCentralPursuitObservationDraft } from "./pursuit-observations.js";

const scope = "workspace:evidence-decision", condition = "c".repeat(64), date = "2026-11-04T15:00:00.000Z";
const deployedTarget: CentralResponseTarget = { key: "target:actual-window-effect", utilityUnit: "utility:verified-deployment-effect",
  referenceKey: "population:predeclared-window", baselineRuleKey: "rule:frozen-baseline", windowRef: "window:one-use" };
const target: CentralResponseTarget = { ...deployedTarget, estimand: "learning_policy_response" };

type Domain = "tool" | "skill";

type History = { readonly domain: Domain; readonly value: number; readonly pending?: boolean;
  readonly support?: readonly [number, number] };

function candidate(id: string, domain: Domain): CentralPursuitCandidate {
  const policyRef = `policy:${domain}:bounded-stage`;
  return { opportunity: { opportunityId: `opportunity:${id}`, scope, targetRef: target.key, instanceRef: `stage:${id}`,
    sourceRef: `source:${id}`, stage: "initial", conditionRef: condition, baselineRef: `baseline:${id}`, windowRef: target.windowRef,
    offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain }, policyRef,
      reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } },
    source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `binding:${id}`, domainStage: {
      stageRef: `stage:${id}`, kind: "initial", policyRef, sourceReportId: `report:${id}`,
      readiness: { kind: "ready", evidenceRefs: [`source:${id}`] } } },
    readiness: { kind: "ready", sourceRef: "business:confirmed-boundary", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "source:fixed-window-start-family" },
    fee: { kind: "hard-budget-only", sourceRef: "source:physical-caps-only" }, purpose: "focused_learning",
    objective: { instanceId: `objective:${id}`, criterion: "checker_verified", definitionRef: "criterion:external-verification",
      familyRef: `pursuit-family:${domain}`, familySourceRef: `source:pursuit-family-${domain}` } };
}

/** Synthetic measurement values exercise real reducer/registry/source/model paths;
 * no predicted means, priors or winning actions are supplied to production APIs. */
function fixture(histories: readonly History[] = [], responseTarget: CentralResponseTarget = target): CentralLearningEvidenceInput {
  let board = emptyBoardState();
  const coordinate = (action: CoordinationAction) => {
    const result = reduce(board, { type: "coordinate_learning", commandId: `setup:${board.sequence}`, issuedAt: date, action });
    if (!result.ok) assert.fail(JSON.stringify(result));
    board = result.state;
  };
  const append = (fact: RewardV2Draft) => {
    const result = reduce(board, { type: "record_reward_v2_fact", commandId: `fact:${board.sequence}`,
      issuedAt: date, expectedSequence: board.sequence, fact });
    if (!result.ok) assert.fail(JSON.stringify(result));
    board = result.state;
  };
  const focus = (source: CentralPursuitCandidate) => {
    const owner = source.opportunity.offer.owner;
    if (owner.plane !== "agent") assert.fail("agent_required");

    coordinate({ kind: "report", scope, issueId: source.source.issueId, problemKey: source.source.issueId,
      report: { reportId: source.source.domainStage.sourceReportId, source: { subsystem: owner.domain === "tool" ? "tool" : "skill",
        taskId: source.opportunity.instanceRef, versionId: source.opportunity.sourceRef },
      facts: ["Declared source-owned bounded stage for a synthetic contract"], evidenceRefs: [source.opportunity.sourceRef] } });
    coordinate({ kind: "decide", issueId: source.source.issueId, expectedRevision: 1, decision: "focused_learning",
      reason: "Explicit source preparation contract", sourceRefs: [source.opportunity.sourceRef] });
  };

  for (const history of histories) {
    const id = `past-${history.domain}`, source = candidate(id, history.domain);
    focus(source);
    coordinate({ kind: "fund", issueId: source.source.issueId, expectedRevision: 2, grantId: source.source.grantId,
      domain: history.domain, allowance: { schemaVersion: 2, unit: "total_model_tokens",
        maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } });
    const protocol = { scope, experimentRef: `experiment:${history.domain}:deployed-pair`, experimentVersion: "1",
      conditionHash: condition, utilityUnit: target.utilityUnit,
      deltaBounds: { minimum: history.support?.[0] ?? -1, maximum: history.support?.[1] ?? 1, sourceRef: "objective:hard-window-support" },
      policyFamilyRef: `response-family:${history.domain}`, familySourceRef: `source:response-family-${history.domain}` };

    for (const suffix of history.pending ? ["observed", "pending"] : ["observed"]) {
      const name = `${id}:${suffix}`, opportunity = { ...source.opportunity,
        instanceRef: `stage:${name}`, baselineRef: `baseline:${name}` };
      let assignment: RewardV2Draft | undefined;

      if (responseTarget.estimand === "learning_policy_response") {
        const draft = createCentralPursuitObservationDraft({ unitId: `unit:${name}`, scope, conditionRef: condition,
          objective: candidate(name, history.domain).objective, grantId: source.source.grantId, stageRef: opportunity.instanceRef,
          treatmentRef: centralPursuitTreatmentRef(opportunity.offer),
          sourceRef: `source:assignment:${name}`, revisionRef: `revision:assignment:${name}`, outcome: "pending" });
        if (draft.status !== "ready") assert.fail(draft.reason);
        assignment = draft.value;
      }

      const comparison = assignment === undefined ? { kind: "deployed_learning_vs_frozen_baseline" as const,
        resultRef: `result:${name}`, adoptionRef: `adoption:${name}`, registrationRef: `registration:${name}`,
        baselineRuleKey: responseTarget.baselineRuleKey } : { kind: "learning_policy_vs_frozen_baseline" as const,
        assignmentRef: assignment.id, registrationRef: `registration:${name}`, baselineRuleKey: responseTarget.baselineRuleKey };
      const registration = createCentralResponseWindowDraft({ opportunity, unitId: `unit:${name}`,
        grantId: source.source.grantId, measurementIds: [`pair:${name}`], comparison }, responseTarget, protocol);
      if (registration.status !== "ready") assert.fail(registration.reason);
      append(registration.value);

      // The window is prospective of assignment, not just its later measurements.
      if (assignment !== undefined) append(assignment);
    }

    const name = `${id}:observed`;

    append({ id: `pair:${name}`, scope, kind: "feedback", algorithmVersion: "ws1-paired-measurement-v1",
      payloadJson: canonicalJson({ schemaVersion: 1, type: "ws1_paired_measurement", observationBinding: null,
        measurement: { id: `pair:${name}`, scope, experimentRef: protocol.experimentRef, experimentVersion: protocol.experimentVersion,
          conditionHash: condition, utilityUnit: target.utilityUnit, sourceRef: `checker:${name}`, kind: "measured",
          baselineUtility: 0, candidateUtility: history.value, fullStudyCost: 100 } }) });
  }

  const candidates = [candidate("A", "tool"), candidate("B", "skill")];
  candidates.forEach(focus);
  coordinate({ kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId: "budget:evidence",
    scope, unit: "total_model_tokens", limits: { tokens: 2000, calls: 4, steps: 4 }, authorizationRef: "host:explicit-root" } });

  return { schemaVersion: 1, board, basis: { scope, boardSequence: board.sequence, budgetId: "budget:evidence",
    utilityUnit: "qualified_objective_completions", valuationRef: "source:normal-entry" }, candidates, horizon: 2 };
}

function decide(input: CentralLearningEvidenceInput) {
  const result = decideCentralLearningWithEvidence(input);
  if (result.status !== "decided") assert.fail(result.reason);
  return result;
}

test("the normal empty-history entry pursues a bounded objective and produces an original funding application", () => {
  const input = fixture(), result = decide(input);

  assert.equal(result.mode, "stage_objective_pursuit");
  assert.equal(result.basis.utilityUnit, "qualified_objective_completions");

  if (result.nextStep.kind !== "fund_and_dispatch" || result.nextStep.application === null) assert.fail("normal_first_funding_required");

  const { evaluation, application } = result.nextStep, stage = evaluation.stage, offer = evaluation.candidate.opportunity.offer;
  if (stage.status !== "ready") assert.fail("original_ready_stage_required");

  const prepared = prepareAllocationApplication({ ...application, authorizationRef: "host:independent-source-authorization",
    bindingsJson: JSON.stringify([{ offerId: offer.offerId, offerHash: contentHashOf(offer), policyRef: offer.policyRef,
      sourceBindingRef: stage.sourceBindingRef, authorizedAllowance: { schemaVersion: 2, unit: "total_model_tokens",
        maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 }, issueId: stage.issueId,
      expectedIssueRevision: stage.expectedIssueRevision, grantId: stage.grantId, mode: stage.mode, chargedAtBasis: stage.chargedAtBasis }]) });
  if (!prepared.ok) assert.fail(JSON.stringify(prepared));

  const audited = reduce(input.board, allocationAuditCommand(prepared.prepared, date));
  if (!audited.ok) assert.fail(JSON.stringify(audited));
  let board: BoardState = audited.state;

  for (const draft of prepared.prepared.drafts) { const funded = reduce(board, { ...draft, issuedAt: date });
    if (!funded.ok) assert.fail(JSON.stringify(funded));
  board = funded.state; }

  assert.equal(board.centralLearningGrants?.[0]?.grantId, stage.grantId);
});

test("prospective whole-policy comparisons under a common target drive the actual economic selection", () => {
  const input = fixture([{ domain: "tool", value: -.5 }, { domain: "skill", value: .75 }]), result = decide(input);

  assert.equal(result.mode, "economic_response");

  if (result.mode !== "economic_response") assert.fail("economic_response_required");

  assert.equal(result.basis.utilityUnit, target.utilityUnit);
  assert.equal(result.discovery.groups.length, 1);
  assert.equal(result.valuation.forecast.queries.length, 2);
  assert.ok(result.valuation.forecast.queries.find(row => row.opportunityId === "opportunity:A")!.mean < 0);
  assert.ok(result.valuation.forecast.queries.find(row => row.opportunityId === "opportunity:B")!.mean > 0);
  assert.equal(result.nextStep.kind, "fund_and_dispatch");

  if (result.nextStep.kind !== "fund_and_dispatch") assert.fail("economic_funding_required");

  assert.equal(result.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:B");
  assert.ok(result.nextStep.application);
  assert.ok(result.sourceRefs.some(ref => ref.startsWith("response-registration:")));
});

test("an unknown domain may pursue its first result while a known negative investment stays excluded", () => {
  const result = decide(fixture([{ domain: "tool", value: -1 }]));

  assert.equal(result.mode, "stage_objective_pursuit");

  if (result.mode !== "stage_objective_pursuit") assert.fail("mixed_evidence_pursuit_required");

  assert.deepEqual(result.valuation.evaluations.map(row => row.candidate.opportunity.opportunityId), ["opportunity:B"]);
  assert.equal(result.economicConstraints.length, 1);
  assert.equal(result.economicConstraints[0]?.opportunityId, "opportunity:A");
  assert.ok(result.economicConstraints[0]!.netValue < 0);
  assert.equal(result.economicConstraints[0]?.utilityUnit, target.utilityUnit);
  assert.equal(result.economicConstraints[0]?.interpretation, "negative_current_model_expectation");
  assert.ok(result.economicConstraints[0]!.modelAssumptions.length > 0);

  if (result.nextStep.kind !== "fund_and_dispatch") assert.fail("unknown_domain_first_stage_required");

  assert.equal(result.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:B");
});

test("pending economic completions that cross zero do not erase a feasible bounded learning opportunity", () => {
  const result = decide(fixture([{ domain: "tool", value: -.5, pending: true }]));

  assert.equal(result.mode, "stage_objective_pursuit");

  if (result.mode !== "stage_objective_pursuit") assert.fail("bounded_learning_required");

  assert.deepEqual(result.economicConstraints, []);
  assert.ok(result.valuation.evaluations.some(row => row.candidate.opportunity.opportunityId === "opportunity:A"));
  assert.equal(result.nextStep.kind, "fund_and_dispatch");
  assert.ok(result.discovery.groups.some(group => group.registrations.length === 2));
});

test("legacy deployed gains and losses remain conditional diagnostics while first funding uses the separate objective unit", () => {
  for (const value of [-1, 1]) {
    const result = decide(fixture([{ domain: "tool", value, support: [value, value] }], deployedTarget));

    assert.equal(result.mode, "stage_objective_pursuit");

    if (result.mode !== "stage_objective_pursuit") assert.fail("deployed_response_must_not_authorize_economic_investment");

    assert.deepEqual(result.economicConstraints, []);
    assert.equal(result.conditionalResponses.length, 1);
    const diagnostic = result.conditionalResponses[0]!;

    assert.equal(diagnostic.reason, "deployment_response_not_learning_policy_response");
    assert.equal(diagnostic.forecast.queries[0]!.mean, value);
    assert.deepEqual(diagnostic.forecast.queries[0]!.updateUnitIds, ["unit:past-tool:observed"]);
    assert.equal(diagnostic.forecast.queries[0]!.grossSupport!.minimum, value);
    assert.equal(diagnostic.forecast.queries[0]!.grossSupport!.maximum, value);
    assert.equal(result.basis.utilityUnit, "qualified_objective_completions");
    assert.notEqual(result.basis.utilityUnit, diagnostic.target.utilityUnit);
    assert.equal(result.nextStep.kind, "fund_and_dispatch");
    assert.ok(result.valuation.evaluations.some(row => row.candidate.opportunity.opportunityId === "opportunity:A"));
    assert.ok(result.reasons.includes("deployment_response_not_learning_policy_response"));
  }
});
