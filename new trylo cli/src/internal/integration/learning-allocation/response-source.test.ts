import test from "node:test";
import assert from "node:assert/strict";
import { buildCentralResponseHistoryFromBoard } from "./response-source.js";
import type { CentralResponseWindow } from "./response-source.js";
import type { BoardState } from "../../learning/control/state.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { EmpiricalTopicPolicy } from "../../learning/domains/shared/topics/empirical-model.js";
import { createCentralResponseWindowDraft, centralResponseWindowsOf } from "./response-registration.js";
import { decideRegisteredCentralLearning } from "./central-decision.js";
import { reduce } from "../../learning/control/reducer.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { createCentralPursuitObservationDraft } from "./pursuit-observations.js";
import { projectCentralEffectSupportFromBoard } from "./effect-source.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";

const policy: EmpiricalTopicPolicy = { scope: "project:source", experimentRef: "compare:one", experimentVersion: "v1",
  conditionHash: "c".repeat(64), utilityUnit: "source-window-utility", futureUses: 1, utilityScale: 1, experimentUnits: 1,
  deltaBounds: { minimum: -1, maximum: 1 }, priorStrength: 2, priorWeights: [.25, .25, .25, .25] };
const target = { key: "source-target", utilityUnit: policy.utilityUnit, referenceKey: "registered-use-window",
  baselineRuleKey: "frozen-policy-v1", windowRef: "one-registered-use-v1" };

function fact(id: string, sequence: number, candidateUtility: number, supersedes?: string): RewardV2Fact {
  const measurement = { id, scope: policy.scope, experimentRef: policy.experimentRef, experimentVersion: policy.experimentVersion,
    conditionHash: policy.conditionHash, utilityUnit: policy.utilityUnit, sourceRef: `checker:${id}`, kind: "measured",
    baselineUtility: 0, candidateUtility, fullStudyCost: 1024, ...(supersedes === undefined ? {} : { supersedes }) };
  return { id, scope: policy.scope, algorithmVersion: "ws1-paired-measurement-v1", kind: "feedback", sequence,
    payloadJson: JSON.stringify({ schemaVersion: 1, type: "ws1_paired_measurement", measurement, observationBinding: null }) };
}

function fixture(facts: readonly RewardV2Fact[], registeredAtSequence = 1) {
  const window: CentralResponseWindow = { unitId: "learning-window:one", grantId: "grant:one", registeredAtSequence,
    measurementIds: ["pair:one"], boundary: "complete", comparison: { kind: "deployed_learning_vs_frozen_baseline",
      resultRef: "result:one", adoptionRef: "adoption:one", registrationRef: "registered:one", baselineRuleKey: target.baselineRuleKey },
    opportunity: { opportunityId: "opportunity:one", scope: policy.scope, targetRef: target.key, instanceRef: "stage:one",
      sourceRef: "stage-source:one", stage: "initial", conditionRef: policy.conditionHash, baselineRef: "baseline:one", windowRef: target.windowRef,
      offer: { offerId: "offer:one", owner: { plane: "agent", domain: "tool" }, policyRef: "policy:research-v1",
        reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } } };
  const board: BoardState = { sequence: 20, appliedCommands: [], proposals: [], assets: [], activations: [], evidence: [], approvals: [],
    jobs: [], tombstones: [], fieldings: [], feedbacks: [], rewardV2Facts: facts, centralLearningGrants: [{ schemaVersion: 2,
      grantId: window.grantId, issueId: "issue:one", scope: policy.scope, jobId: "job:one", domain: "tool", focusRevision: 1,
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 },
      steps: 0, reservations: [], status: "closed", closedReason: "completed" }] };

  return { board, target, measurementPolicy: policy, windows: [window] };
}

function assignedPolicyFixture(measurement: "after_assignment" | "before_assignment" | "without_assignment" | "missing",
  assignmentTreatment: "frozen_offer" | "legacy_missing" = "frozen_offer") {
  const input = fixture([]), original = input.windows[0]!;
  const policyTarget = { ...target, estimand: "learning_policy_response" as const };
  let board: BoardState = { ...input.board, sequence: 0, rewardV2Facts: [] };
  const append = (draft: RewardV2Draft) => {
    const written = reduce(board, { type: "record_reward_v2_fact", commandId: `policy-source:${board.sequence}`,
      issuedAt: "2026-11-05T00:00:00.000Z", expectedSequence: board.sequence, fact: draft });
    if (!written.ok) assert.fail(written.reason);
    board = written.state;
  };
  const assignment = { unitId: original.unitId, scope: policy.scope, conditionRef: policy.conditionHash,
    objective: { instanceId: "objective:assigned-stage", criterion: "checker_verified" as const, definitionRef: "criterion:original",
      familyRef: "family:policy", familySourceRef: "source:family" },
    grantId: original.grantId, stageRef: original.opportunity.instanceRef,
    sourceRef: "source:initial-assignment", revisionRef: "revision:initial-assignment", outcome: "pending" as const,
    ...(assignmentTreatment === "frozen_offer" ? { treatmentRef: centralPursuitTreatmentRef(original.opportunity.offer) } : {}) };
  const initial = createCentralPursuitObservationDraft(assignment);
  if (initial.status !== "ready") assert.fail(initial.reason);

  const registration = createCentralResponseWindowDraft({ opportunity: original.opportunity, unitId: original.unitId,
    grantId: original.grantId, measurementIds: original.measurementIds,
    comparison: { kind: "learning_policy_vs_frozen_baseline", assignmentRef: initial.value.id,
      registrationRef: "source:whole-policy-contrast", baselineRuleKey: target.baselineRuleKey } }, policyTarget);
  if (registration.status !== "ready") assert.fail(registration.reason);

  append(registration.value);

  if (measurement === "before_assignment") append(fact("pair:one", 1, -.4));

  const failed = createCentralPursuitObservationDraft({ ...assignment, outcome: "closed_no_result", sourceRef: "source:closed-original-criterion",
    revisionRef: "revision:no-result", supersedes: initial.value.id });
  if (failed.status !== "ready") assert.fail(failed.reason);

  if (measurement !== "without_assignment") {
    append(initial.value);
    append(failed.value);
  }

  if (measurement === "after_assignment" || measurement === "without_assignment") append(fact("pair:one", 1, -.4));

  const windows = centralResponseWindowsOf(board, policyTarget, policy.scope);
  if (windows.status !== "ready") assert.fail(windows.reason);

  return { board, target: policyTarget, measurementPolicy: policy, windows: windows.value, initial: initial.value, failed: failed.value };
}

test("whole-policy feedback uses prospective original assignments and retains unsuccessful or unmeasured units", () => {
  const measured = buildCentralResponseHistoryFromBoard(assignedPolicyFixture("after_assignment"));

  assert.equal(measured.status, "ready");
  assert.equal(measured.history.length, 1);
  assert.deepEqual(measured.history[0]!.outcome, { kind: "paired_window", candidateUtility: -.4, baselineUtility: 0 });
  const unmeasured = buildCentralResponseHistoryFromBoard(assignedPolicyFixture("missing"));

  assert.equal(unmeasured.status, "ready");
  assert.equal(unmeasured.history.length, 1);
  assert.deepEqual(unmeasured.history[0]!.outcome, { kind: "unknown", reason: "response_window_feedback_missing" });
});

test("whole-policy assignments require the original frozen policy and resource treatment", () => {
  const input = assignedPolicyFixture("after_assignment"), original = input.windows[0]!, offer = original.opportunity.offer;

  assert.equal(buildCentralResponseHistoryFromBoard(input).status, "ready");

  for (const changed of [{ ...offer, policyRef: "policy:research-v2" },
    { ...offer, reserve: { ...offer.reserve, tokens: offer.reserve.tokens + 1 } },
    { ...offer, reserve: { ...offer.reserve, calls: offer.reserve.calls + 1 } },
    { ...offer, reserve: { ...offer.reserve, steps: offer.reserve.steps + 1 } },
    { ...offer, maxPromptChars: offer.maxPromptChars + 1 }]) {
    const result = buildCentralResponseHistoryFromBoard({ ...input,
      windows: [{ ...original, opportunity: { ...original.opportunity, offer: changed } }] });
    assert.deepEqual(result, { status: "invalid", reason: "response_assignment_binding" });
  }

  assert.deepEqual(buildCentralResponseHistoryFromBoard(assignedPolicyFixture("after_assignment", "legacy_missing")),
    { status: "invalid", reason: "response_assignment_binding" });
});

test("a registered unit with no recorded assignment stays unknown even when partial support can see a measurement", () => {
  const input = assignedPolicyFixture("without_assignment");
  const source = buildCentralResponseHistoryFromBoard(input);
  if (source.status !== "ready") assert.fail(source.reason);

  assert.equal(source.history.length, 1);
  assert.deepEqual(source.history[0]!.outcome, { kind: "unknown", reason: "response_assignment_pending" });
  const support = projectCentralEffectSupportFromBoard({ board: input.board, target: input.target, measurementPolicy: policy });
  if (support.status !== "ready") assert.fail(support.reason);

  assert.equal(support.effectSupport?.population, 1);
  assert.equal(support.effectSupport?.knownComparisons, 0);
  assert.equal(support.effectSupport?.unknownComparisons, 1);
  assert.deepEqual(support.effectSupport?.actualMeanSupport, [-1, 1]);
});

test("whole-policy assignments cannot be invented, rebound, revised or registered after outcomes", () => {
  const input = assignedPolicyFixture("after_assignment"), original = input.windows[0]!;
  const comparison = original.comparison;
  if (comparison.kind !== "learning_policy_vs_frozen_baseline") assert.fail("whole_policy_window_missing");

  const change = (assignmentRef: string) => buildCentralResponseHistoryFromBoard({ ...input,
    windows: [{ ...original, comparison: { ...comparison, assignmentRef } }] });
  const missing = change("assignment:not-recorded");
  if (missing.status !== "ready") assert.fail(missing.reason);

  assert.equal(missing.history.length, 1);
  assert.deepEqual(missing.history[0]!.outcome, { kind: "unknown", reason: "response_assignment_pending" });
  assert.deepEqual(change(input.failed.id), { status: "invalid", reason: "response_assignment_binding" });
  assert.deepEqual(buildCentralResponseHistoryFromBoard({ ...input,
    windows: [{ ...original, opportunity: { ...original.opportunity, instanceRef: "stage:other" } }] }),
  { status: "invalid", reason: "response_assignment_binding" });
  const late = { ...input.board, rewardV2Facts: input.board.rewardV2Facts!.map(row => row.id === input.initial.id ? { ...row, sequence: 1 } : row) };

  assert.deepEqual(buildCentralResponseHistoryFromBoard({ ...input, board: late }),
    { status: "invalid", reason: "response_assignment_binding" });
  assert.deepEqual(buildCentralResponseHistoryFromBoard({ ...input,
    windows: [{ ...original, registeredAtSequence: input.board.sequence }] }),
  { status: "invalid", reason: "response_assignment_binding" });
  assert.deepEqual(buildCentralResponseHistoryFromBoard(assignedPolicyFixture("before_assignment")),
    { status: "invalid", reason: "response_assignment_postselected" });
  const early = buildCentralResponseHistoryFromBoard({ ...input,
    board: { ...input.board, sequence: 1, rewardV2Facts: input.board.rewardV2Facts!.filter(row => row.sequence <= 1) } });
  if (early.status !== "ready") assert.fail(early.reason);

  assert.equal(early.history.length, 1);
  assert.deepEqual(early.history[0]!.outcome, { kind: "unknown", reason: "response_assignment_pending" });
});

test("existing Board paired feedback becomes a window response only with the registered deployment contrast", () => {
  const input = fixture([fact("pair:one", 5, .2), fact("pair:revised", 10, -.3, "pair:one")]);
  const result = buildCentralResponseHistoryFromBoard(input);

  assert.equal(result.status, "ready");

  if (result.status !== "ready") throw new Error("history_not_ready");

  assert.deepEqual(result.history[0]!.outcome, { kind: "paired_window", candidateUtility: -.3, baselineUtility: 0 });
  const unqualified = buildCentralResponseHistoryFromBoard({ ...input, windows: input.windows.map(window => ({ ...window,
    comparison: { kind: "unqualified", reason: "no-deployment-link" } })) });

  assert.equal(unqualified.status, "ready");

  if (unqualified.status === "ready") assert.equal(unqualified.history[0]!.outcome.kind, "unknown");
});

test("late corrections retain episode birth order while advancing the label's as-of boundary", () => {
  const original = [fact("pair:one", 5, .2), fact("pair:one-b", 8, .1), fact("pair:two", 9, .4), fact("pair:three", 10, .6)];
  const input = fixture(original), base = input.windows[0]!;
  const windows = [["pair:one", "pair:one-b"], ["pair:two"], ["pair:three"]].map((measurementIds, index) => ({ ...base,
    unitId: `window:${index}`, measurementIds,
    opportunity: { ...base.opportunity, opportunityId: `opportunity:${index}`, instanceRef: `stage:${index}` } }));
  const before = buildCentralResponseHistoryFromBoard({ ...input, windows, board: { ...input.board, sequence: 12 } });
  const correctedFacts = [...original, fact("pair:one-corrected", 18, -.3, "pair:one")];
  const after = buildCentralResponseHistoryFromBoard({ ...input, windows, board: { ...input.board, rewardV2Facts: correctedFacts } });

  assert.equal(before.status, "ready");
  assert.equal(after.status, "ready");

  if (before.status !== "ready" || after.status !== "ready") throw new Error("history_not_ready");

  // An episode with several comparisons is born only once all its original rows exist.
  assert.deepEqual(before.history.map(row => row.episodeSequence), [8, 9, 10]);
  assert.deepEqual(after.history.map(row => row.episodeSequence), [8, 9, 10]);
  assert.deepEqual(before.history.map(row => row.sequence), [8, 9, 10]);
  assert.deepEqual(after.history.map(row => row.sequence), [18, 9, 10]);
  const ordered = [...after.history].sort((left, right) => (left.episodeSequence ?? left.sequence) - (right.episodeSequence ?? right.sequence));

  assert.deepEqual(ordered.map(row => row.unitId), ["window:0", "window:1", "window:2"]);
  assert.notDeepEqual(after.history[0]!.outcome, before.history[0]!.outcome);

  // Supplying a later Board fact cannot expose its revised value to an older prefix.
  const olderPrefix = buildCentralResponseHistoryFromBoard({ ...input, windows,
    board: { ...input.board, sequence: 12, rewardV2Facts: correctedFacts } });

  assert.equal(olderPrefix.status, "ready");

  if (olderPrefix.status !== "ready") throw new Error("history_not_ready");

  assert.equal(olderPrefix.history[0]!.sequence, 8);
  assert.equal(olderPrefix.history[0]!.episodeSequence, 8);
  assert.deepEqual(olderPrefix.history[0]!.outcome, before.history[0]!.outcome);
});

test("absent registered feedback and open windows remain unknown, never zero", () => {
  const input = fixture([]), result = buildCentralResponseHistoryFromBoard(input);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.history[0]!.outcome, { kind: "unknown", reason: "response_window_feedback_missing" });
  const open = buildCentralResponseHistoryFromBoard({ ...fixture([fact("pair:one", 5, .2)]),
    windows: input.windows.map(window => ({ ...window, boundary: "open" })) });
  if (open.status === "ready") assert.equal(open.history[0]!.outcome.kind, "unknown");
});

test("a late revision cannot make an already observed pair a prospectively registered learning window", () => {
  const result = buildCentralResponseHistoryFromBoard(fixture([fact("pair:one", 5, .2), fact("pair:revised", 10, -.3, "pair:one")], 8));
  assert.deepEqual(result, { status: "invalid", reason: "response_window_postselected" });
});

test("one pair cannot inflate two independent learning episodes", () => {
  const input = fixture([fact("pair:one", 5, .2)]), result = buildCentralResponseHistoryFromBoard({ ...input,
    windows: [input.windows[0]!, { ...input.windows[0]!, unitId: "another-window" }] });
  assert.deepEqual(result, { status: "invalid", reason: "response_window_reused_measurement" });
});

test("window registration is retained by the original Board schema and uses its actual sequence", () => {
  const input = fixture([fact("pair:one", 5, .2)]), window = input.windows[0]!;
  const draft = createCentralResponseWindowDraft({ opportunity: window.opportunity, unitId: window.unitId,
    grantId: window.grantId, measurementIds: window.measurementIds, comparison: window.comparison }, target);

  assert.equal(draft.status, "ready");

  if (draft.status !== "ready") throw new Error("registration_not_ready");

  const written = reduce({ ...input.board, sequence: 1, rewardV2Facts: [] }, { type: "record_reward_v2_fact",
    commandId: "test:register-window", issuedAt: "2026-11-04T12:00:00.000Z", expectedSequence: 1, fact: draft.value });

  assert.equal(written.ok, true);

  if (!written.ok) throw new Error("registration_writer_rejected");

  const board = { ...written.state, sequence: input.board.sequence, rewardV2Facts: [...written.state.rewardV2Facts!, ...input.board.rewardV2Facts!] };
  const registered = centralResponseWindowsOf(board, target, policy.scope);

  assert.equal(registered.status, "ready");

  if (registered.status === "ready") {
    assert.equal(registered.value[0]!.registeredAtSequence, 2);
    assert.equal(buildCentralResponseHistoryFromBoard({ ...input, board, windows: registered.value }).status, "ready");
  }
});

test("legacy deployed-only feedback cannot authorize funding for the whole learning stage", () => {
  const input = fixture([fact("pair:one", 5, .2), fact("pair:two", 6, .4), fact("pair:three", 7, .9)]);
  const registrations = ["pair:one", "pair:two", "pair:three"].map((id, index) => {
    const window = input.windows[0]!;
    const draft = createCentralResponseWindowDraft({ opportunity: { ...window.opportunity, instanceRef: `historical-stage:${index}` },
      unitId: `history-unit:${index}`, grantId: `historical-grant:${index}`, measurementIds: [id], comparison: window.comparison }, target);
    if (draft.status !== "ready") throw new Error("invalid_test_registration");
    return { ...draft.value, sequence: index + 1 };
  });
  let board: BoardState = { ...input.board, rewardV2Facts: [...registrations, ...input.board.rewardV2Facts!],
    centralLearningGrants: registrations.map((_, index) => ({ ...input.board.centralLearningGrants![0]!, grantId: `historical-grant:${index}` })) };
  const act = (action: CoordinationAction) => {
    const next = reduce(board, { type: "coordinate_learning", commandId: `source-test:${board.sequence}`,
      issuedAt: "2026-11-04T12:00:00.000Z", action });
    assert.equal(next.ok, true);
    if (next.ok) board = next.state;
  };

  act({ kind: "report", scope: policy.scope, issueId: "issue:next", problemKey: "problem:source",
    report: { reportId: "report:source", source: { subsystem: "tool", taskId: "task:source", versionId: "v1" },
      facts: ["Synthetic actual-shaped deployment comparison contract"], evidenceRefs: ["source:one"] } });
  act({ kind: "decide", issueId: "issue:next", expectedRevision: 1, decision: "focused_learning", reason: "Compare registered stage",
    sourceRefs: ["source:one"] });
  act({ kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId: "budget:source", scope: policy.scope,
    unit: "total_model_tokens", limits: { tokens: 2000, calls: 4, steps: 4 }, authorizationRef: "test:root-authorization" } });
  const opportunity = input.windows[0]!.opportunity;
  const result = decideRegisteredCentralLearning({ schemaVersion: 1, board,
    prediction: { basis: { scope: policy.scope, boardSequence: board.sequence, budgetId: "budget:source", utilityUnit: target.utilityUnit,
      valuationRef: "source:test-prefix" }, target, opportunities: [opportunity],
      limits: { maxObservations: 16, maxLatentDimension: 8, maxQueries: 8, maxComponents: 1 } },
    measurementPolicies: [policy],
    candidates: [{ opportunityId: opportunity.opportunityId,
      source: { issueId: "issue:next", grantId: "grant:next", sourceBindingRef: "source-binding:next",
        domainStage: { stageRef: opportunity.instanceRef, kind: "initial", policyRef: opportunity.offer.policyRef,
          sourceReportId: "report:source", readiness: { kind: "ready", evidenceRefs: ["source:one"] } } },
      readiness: { kind: "ready", sourceRef: "business:boundary", now: 100, nextHandoff: null },
      target: { kind: "boundary-independent", sourceRef: "fixed-window:target" },
      fee: { kind: "hard-budget-only", sourceRef: "objective:physical-budget" } }] });

  assert.deepEqual(result, { status: "rejected", reason: "central_decision_learning_policy_estimand_required" });
});
