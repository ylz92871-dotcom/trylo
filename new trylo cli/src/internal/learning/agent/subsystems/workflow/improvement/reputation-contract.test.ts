import assert from "node:assert/strict";
import test from "node:test";
import { hostCompleteSearchProcessEvidence, hostPartialSearchProcessEvidence, improvementFeedbackFixture,
  measuredSearchComparison, searchImprovementFixture, searchImprovementWithRecoveryFixture } from "../testing/improvement-fixtures.js";
import { buildWorkflowImprovement, compileWorkflowImprovement, parseWorkflowImprovementFeedback, workflowImprovementReputation } from "./index.js";
import type { WorkflowImprovement, WorkflowImprovementFeedback } from "./contracts.js";

function proposedSearch(): WorkflowImprovement {
  const result = buildWorkflowImprovement(searchImprovementFixture());
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.value;
}

function feedback(overrides: Partial<WorkflowImprovementFeedback> = {}, includeProcessEvidence = true): WorkflowImprovementFeedback {
  const { processEvidence, ...remaining } = improvementFeedbackFixture(overrides);
  const result = parseWorkflowImprovementFeedback({ ...remaining,
    ...(includeProcessEvidence && processEvidence !== undefined ? { processEvidence } : {}) });
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.value;
}

test("a cheaper execution that damages quality requires revision and blocks automatic reuse", () => {
  const artifact = proposedSearch();
  const harmful = feedback({ quality: "failed", comparison: measuredSearchComparison(),
    explanation: "The scoped search omitted a generated source; the current completeness check failed." });
  const standing = workflowImprovementReputation(artifact, [harmful], harmful.versionId);

  assert.equal(standing.improvements, 0);
  assert.equal(standing.qualityFailures, 1);
  assert.equal(standing.regressions, 1);
  assert.equal(standing.standing, "needs_revision");
  const dispatch = compileWorkflowImprovement(artifact, artifact.opportunity.task, 32_768, standing);

  assert.equal(dispatch.ok, false);

  if (!dispatch.ok) assert.equal(dispatch.code, "improvement_needs_revision");
});

test("retrieved but unused guidance and an unknown outcome earn no quality or benefit credit", () => {
  const artifact = proposedSearch();
  const skipped = feedback({ exposure: "skipped", quality: "unknown", followedStepIds: [], evidenceRefs: [], processEvidence: { kind: "unverified" },
    explanation: "The executor used ordinary planning and did not apply this procedure." });
  const unknown = feedback({ feedbackId: "feedback:unknown", useId: "use:unknown", executionId: "execution:unknown", quality: "unknown", evidenceRefs: [],
    explanation: "Work stopped before a current quality receipt was available." });
  const standing = workflowImprovementReputation(artifact, [skipped, unknown], skipped.versionId);

  assert.equal(standing.skipped, 1);
  assert.equal(standing.unknown, 1);
  assert.equal(standing.qualityPasses, 0);
  assert.equal(standing.improvements, 0);
  assert.equal(standing.comparableUses, 0);
  assert.equal(standing.qualityEstimate, 0.5);
  assert.notEqual(standing.standing, "supported");
  assert.equal(parseWorkflowImprovementFeedback(improvementFeedbackFixture({ exposure: "skipped" })).ok, false);
  assert.equal(parseWorkflowImprovementFeedback(improvementFeedbackFixture({ followedStepIds: [], processEvidence: { kind: "unverified" } })).ok, false);
});

test("replaying the same adoption cannot inflate reliability or comparative benefit", () => {
  const artifact = proposedSearch(), observation = feedback({ comparison: measuredSearchComparison() });
  const once = workflowImprovementReputation(artifact, [observation], observation.versionId);
  const replayed = workflowImprovementReputation(artifact, [observation, observation, observation], observation.versionId);

  assert.deepEqual(replayed, once);
  assert.equal(replayed.qualityPasses, 1);
  assert.equal(replayed.comparableUses, 1);
  assert.equal(replayed.improvements, 1);
  assert.notEqual(replayed.standing, "supported");
});

test("renaming an adoption while reusing the same execution receipts cannot manufacture reliability", () => {
  const artifact = proposedSearch(), observed = feedback({ comparison: measuredSearchComparison() });
  const relabeled = feedback({ ...observed, feedbackId: "feedback:relabeled", useId: "use:relabeled" });
  const result = workflowImprovementReputation(artifact, [observed, relabeled], observed.versionId);

  assert.equal(result.qualityPasses, 1);
  assert.equal(result.comparableUses, 1);
  assert.equal(result.improvements, 1);
  assert.notEqual(result.standing, "supported");
});

test("relabeling an execution cannot reuse one host process proof to manufacture independent process successes", () => {
  const artifact = proposedSearch(), processEvidence = hostCompleteSearchProcessEvidence();
  const first = feedback({ comparison: measuredSearchComparison(), processEvidence });
  const second = feedback({ feedbackId: "feedback:renamed-execution", useId: "use:renamed-execution", executionId: "execution:renamed-candidate",
    evidenceRefs: ["receipt:new-task-check"], processEvidence,
    comparison: { ...measuredSearchComparison(), candidateExecutionId: "execution:renamed-candidate",
      baselineExecutionId: "execution:another-baseline", evidenceRefs: ["receipt:new-baseline", "receipt:new-candidate"] } });
  const result = workflowImprovementReputation(artifact, [first, second], first.versionId);

  assert.equal(result.reportedUses, 2);
  assert.equal(result.qualityPasses, 2);
  assert.equal(result.completeProcessUses, 1);
  assert.equal(result.unverifiedProcessUses, 1);
  assert.equal(result.processQualityPasses, 1);
  assert.equal(result.comparableUses, 1);
  assert.equal(result.improvements, 1);
  assert.notEqual(result.standing, "supported");
});

test("independent measured execution pairs remain comparable on the same input and conditions", () => {
  const artifact = proposedSearch(), first = feedback({ comparison: measuredSearchComparison() });
  const second = feedback({ feedbackId: "feedback:second-pair", useId: "use:second-pair", executionId: "execution:candidate-b", evidenceRefs: ["receipt:second-check"],
    comparison: { ...measuredSearchComparison(), baselineExecutionId: "execution:baseline-b",
      candidateExecutionId: "execution:candidate-b", evidenceRefs: ["receipt:baseline-b", "receipt:candidate-b"] } });
  const result = workflowImprovementReputation(artifact, [first, second], first.versionId);

  assert.equal(result.comparableUses, 2);
  assert.equal(result.improvements, 2);
  assert.equal(result.qualityPasses, 2);
  assert.equal(result.completeProcessUses, 2);
  assert.equal(result.processQualityPasses, 2);
  assert.equal(result.standing, "supported");
});

test("partial or unverified use preserves task outcomes without supporting the whole procedure", () => {
  const artifact = proposedSearch();
  for (const processEvidence of [undefined, { kind: "unverified" } as const, hostPartialSearchProcessEvidence()]) {
    const first = feedback({ ...(processEvidence === undefined ? {} : { processEvidence }), comparison: measuredSearchComparison() },
      processEvidence !== undefined);
    // The second actual execution needs an independent synthetic host receipt.
    const secondProcessEvidence = processEvidence?.kind === "partial"
      ? { ...processEvidence, evidenceRefs: ["receipt:execution:candidate-b:observed-selected-fragment"] } : processEvidence;
    const second = feedback({ feedbackId: "feedback:second-outcome", useId: "use:second-outcome", executionId: "execution:candidate-b",
      ...(secondProcessEvidence === undefined ? {} : { processEvidence: secondProcessEvidence }), evidenceRefs: ["receipt:second-outcome-check"], comparison: { ...measuredSearchComparison(),
        baselineExecutionId: "execution:baseline-b", candidateExecutionId: "execution:candidate-b",
        evidenceRefs: ["receipt:baseline-b", "receipt:candidate-b"] } }, processEvidence !== undefined);
    const result = workflowImprovementReputation(artifact, [first, second], first.versionId);

    assert.equal(result.reportedUses, 2);
    assert.equal(result.qualityPasses, 2);
    assert.equal(result.completeProcessUses, 0);
    assert.equal(result.partialProcessUses, processEvidence?.kind === "partial" ? 2 : 0);
    assert.equal(result.unverifiedProcessUses, processEvidence?.kind === "partial" ? 0 : 2);
    assert.equal(result.processQualityPasses, 0);
    assert.equal(result.comparableUses, 0);
    assert.equal(result.improvements, 0);
    assert.notEqual(result.standing, "supported");
  }
});

test("two independently checked fragments cannot be assembled into an unobserved complete process", () => {
  const artifact = proposedSearch();
  const first = feedback({ processEvidence: hostPartialSearchProcessEvidence(["confirm-owner"]), comparison: measuredSearchComparison() });
  const second = feedback({ feedbackId: "feedback:second-fragment", processEvidence: hostPartialSearchProcessEvidence(["scoped-search"]),
    evidenceRefs: ["receipt:second-fragment-quality"] });
  const result = workflowImprovementReputation(artifact, [first, second], first.versionId);

  assert.equal(result.reportedUses, 1);
  assert.equal(result.qualityPasses, 1);
  assert.equal(result.partialProcessUses, 1);
  assert.equal(result.completeProcessUses, 0);
  assert.equal(result.processQualityPasses, 0);
  assert.equal(result.comparableUses, 0);
  assert.equal(result.improvements, 0);
});

test("task quality from one report and complete adoption from another cannot manufacture process benefit", () => {
  const artifact = proposedSearch();
  const knownOutcome = feedback({ processEvidence: { kind: "unverified" }, comparison: measuredSearchComparison() });
  const completeButUnknown = feedback({ feedbackId: "feedback:process-only", quality: "unknown", evidenceRefs: [],
    processEvidence: hostCompleteSearchProcessEvidence() });
  const result = workflowImprovementReputation(artifact, [knownOutcome, completeButUnknown], knownOutcome.versionId);

  assert.equal(result.reportedUses, 1);
  assert.equal(result.qualityPasses, 1);
  assert.equal(result.processQualityPasses, 0);
  assert.equal(result.comparableUses, 0);
  assert.equal(result.improvements, 0);
  assert.deepEqual(workflowImprovementReputation(artifact, [completeButUnknown, knownOutcome], knownOutcome.versionId), result);
});

test("a checked normal path can be complete while an independently confirmed conditional recovery stays unexposed", () => {
  const built = buildWorkflowImprovement(searchImprovementWithRecoveryFixture());
  if (!built.ok) assert.fail(`${built.code}: ${built.message}`);

  const observed = feedback({ comparison: measuredSearchComparison(), processEvidence: {
    ...hostCompleteSearchProcessEvidence(), skippedStepIds: ["recover-moved-owner"],
    evidenceRefs: ["receipt:normal-path-observed", "receipt:owner-not-moved"] } });
  const result = workflowImprovementReputation(built.value, [observed], observed.versionId);

  assert.equal(result.completeProcessUses, 1);
  assert.equal(result.processQualityPasses, 1);
  assert.equal(result.qualityPasses, 1);
  assert.equal(result.comparableUses, 1);
  assert.equal(result.improvements, 1);
  assert.notEqual(result.standing, "supported");
});

test("a claimed complete process cannot earn support with missing, unknown or overlapping path nodes", () => {
  const artifact = proposedSearch(), complete = hostCompleteSearchProcessEvidence();
  const unsupported = [
    { ...complete, checkedStepIds: ["confirm-owner"] },
    { ...complete, checkedStepIds: ["confirm-owner", "scoped-search", "invented-step"] },
    { ...complete, skippedStepIds: ["scoped-search"] },
    { ...complete, checkedStepIds: [], skippedStepIds: ["confirm-owner", "scoped-search"] },
  ];

  for (const processEvidence of unsupported) {
    const raw = improvementFeedbackFixture({ processEvidence, comparison: measuredSearchComparison() });
    const result = workflowImprovementReputation(artifact, [raw], raw.versionId);

    assert.equal(result.completeProcessUses, 0);
    assert.equal(result.processQualityPasses, 0);
    assert.equal(result.comparableUses, 0);
    assert.equal(result.improvements, 0);
    assert.notEqual(result.standing, "supported");
  }
});

test("a failed task after partial use remains a revision risk without claiming the whole process was followed", () => {
  const artifact = proposedSearch();
  const observed = feedback({ quality: "failed", processEvidence: hostPartialSearchProcessEvidence(),
    explanation: "The task failed its completeness check after only the owner probe was independently observed." });
  const result = workflowImprovementReputation(artifact, [observed], observed.versionId);

  assert.equal(result.qualityFailures, 1);
  assert.equal(result.partialProcessUses, 1);
  assert.equal(result.completeProcessUses, 0);
  assert.equal(result.processQualityPasses, 0);
  assert.equal(result.standing, "needs_revision");
});

test("the reputation boundary rejects quality claims without any observed intervention", () => {
  const artifact = proposedSearch();
  const unobserved = improvementFeedbackFixture({ followedStepIds: [], evidenceRefs: [], processEvidence: { kind: "unverified" },
    comparison: measuredSearchComparison() });
  const result = workflowImprovementReputation(artifact, [unobserved], unobserved.versionId);

  assert.equal(result.qualityPasses, 0);
  assert.equal(result.improvements, 0);
  assert.equal(result.comparableUses, 0);
  assert.notEqual(result.standing, "supported");
});

test("independent host process evidence can establish actual use without a model step list", () => {
  const artifact = proposedSearch();
  const observed = feedback({ followedStepIds: [], comparison: measuredSearchComparison() });
  const result = workflowImprovementReputation(artifact, [observed], observed.versionId);

  assert.equal(result.reportedUses, 1);
  assert.equal(result.qualityPasses, 1);
  assert.equal(result.completeProcessUses, 1);
  assert.equal(result.processQualityPasses, 1);
  assert.equal(result.comparableUses, 1);
  assert.equal(result.improvements, 1);
});

test("different uses, baselines or cost units cannot turn one real execution into independent successes", () => {
  const artifact = proposedSearch(), first = feedback({ comparison: measuredSearchComparison() });
  const remeasured = feedback({ ...first, feedbackId: "feedback:another-metric", useId: "use:another-phase",
    evidenceRefs: ["receipt:another-check-same-execution"], comparison: { ...measuredSearchComparison(),
      baselineExecutionId: "execution:another-baseline", unit: "wall_ms", baselineCost: 800, candidateCost: 300,
      evidenceRefs: ["receipt:another-baseline", "receipt:candidate-wall-time"] } });
  const result = workflowImprovementReputation(artifact, [first, remeasured], first.versionId);

  assert.equal(result.reportedUses, 1);
  assert.equal(result.qualityPasses, 1);
  assert.equal(result.comparableUses, 1);
  assert.equal(result.improvements, 1);
  assert.notEqual(result.standing, "supported");
});

test("feedback must identify its actual execution and bind the measured candidate to it", () => {
  const observed = improvementFeedbackFixture({ comparison: measuredSearchComparison() });
  const { executionId: omitted, ...withoutExecution } = observed;
  assert.ok(omitted);
  assert.equal(parseWorkflowImprovementFeedback(withoutExecution).ok, false);
  assert.equal(parseWorkflowImprovementFeedback({ ...observed,
    comparison: { ...measuredSearchComparison(), candidateExecutionId: "execution:unrelated-candidate" } }).ok, false);
});

test("a later objective result resolves an unknown report for the same use without counting it twice", () => {
  const artifact = proposedSearch();
  const early = feedback({ quality: "unknown", evidenceRefs: [],
    explanation: "Execution ended before a quality result was available." });
  const later = feedback({ feedbackId: "feedback:later-objective-result", evidenceRefs: ["receipt:later-objective-check"] });
  const result = workflowImprovementReputation(artifact, [early, later], early.versionId);

  assert.equal(result.reportedUses, 1);
  assert.equal(result.qualityPasses, 1);
  assert.equal(result.qualityFailures, 0);
  assert.equal(result.unknown, 0);
  assert.equal(result.improvements, 0);
  assert.deepEqual(workflowImprovementReputation(artifact, [later, early, later], early.versionId), result);
});

test("operator help assessment can supplement the same use without impersonating objective quality", () => {
  const artifact = proposedSearch(), report = feedback({ quality: "unknown", evidenceRefs: [],
    explanation: "The task has no independent checker for whether the search method helped." });
  const assessed = feedback({ ...report, feedbackId: "feedback:user-helped",
    userAssessment: { judgment: "helped", evidenceRef: "user:explicit-workflow-helped" },
    explanation: "The user explicitly reported that this workflow reduced repeated exploration." });
  const result = workflowImprovementReputation(artifact, [report, assessed, assessed], report.versionId);

  assert.equal(result.reportedUses, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.userHelped, 1);
  assert.equal(result.userHarmed, 0);
  assert.equal(result.userNeutral, 0);
  assert.equal(result.qualityPasses, 0);
  assert.equal(result.comparableUses, 0);
  assert.equal(result.improvements, 0);
  assert.equal(result.qualityEstimate, 0.5);
  assert.equal(result.standing, "user_supported");
});

test("subjective harm is visible and neutral feedback cannot manufacture support", () => {
  const artifact = proposedSearch(), report = feedback({ quality: "unknown", evidenceRefs: [] });
  const neutral = feedback({ ...report, userAssessment: { judgment: "neutral", evidenceRef: "user:neutral" } });
  const neutralReputation = workflowImprovementReputation(artifact, [neutral], neutral.versionId);

  assert.equal(neutralReputation.userNeutral, 1);
  assert.equal(neutralReputation.userHelped, 0);
  assert.equal(neutralReputation.qualityPasses, 0);
  assert.notEqual(neutralReputation.standing, "user_supported");
  const harmed = feedback({ ...report, userAssessment: { judgment: "harmed", evidenceRef: "user:harmed" } });
  const harmfulReputation = workflowImprovementReputation(artifact, [harmed], harmed.versionId);

  assert.equal(harmfulReputation.userHarmed, 1);
  assert.equal(harmfulReputation.qualityFailures, 0);
  assert.equal(harmfulReputation.standing, "needs_revision");
});

test("a process used by another business family does not inherit this family's quality or benefit reputation", () => {
  const artifact = proposedSearch(), observation = feedback({ comparison: measuredSearchComparison() });
  const otherFamily = feedback({ ...observation, task: { ...observation.task,
    taskFamily: { id: "api-change", intentClass: "change_api", checkKind: "unit_test", language: "typescript" } } });
  const result = workflowImprovementReputation(artifact, [otherFamily], observation.versionId);

  assert.equal(result.qualityPasses, 0);
  assert.equal(result.comparableUses, 0);
  assert.equal(result.improvements, 0);
  assert.notEqual(result.standing, "supported");
});

test("contradictory reports for one adoption remain unknown instead of choosing the favorable result", () => {
  const artifact = proposedSearch(), passed = feedback({ comparison: measuredSearchComparison() });
  const failed = feedback({ ...passed, quality: "failed", evidenceRefs: ["receipt:conflicting-check"],
    explanation: "A conflicting snapshot reports that the same adoption failed its check." });
  const standing = workflowImprovementReputation(artifact, [passed, failed], passed.versionId);

  assert.equal(standing.reportedUses, 1);
  assert.equal(standing.qualityPasses, 0);
  assert.equal(standing.unknown, 1);
  assert.equal(standing.improvements, 0);
  assert.notEqual(standing.standing, "supported");
});

test("successes from another version or inapplicable context do not establish this version's reputation", () => {
  const artifact = proposedSearch(), observation = feedback({ comparison: measuredSearchComparison() });
  const differentVersion = feedback({ ...observation, versionId: "workflow:parent-version" });
  const differentCondition = feedback({ ...observation, task: { ...observation.task,
    conditions: { ...observation.task.conditions, repoLayout: "moved-layout-v2" } } });
  const result = workflowImprovementReputation(artifact, [differentVersion, differentCondition], observation.versionId);

  assert.equal(result.reportedUses, 0);
  assert.equal(result.qualityPasses, 0);
  assert.equal(result.improvements, 0);
  assert.equal(result.standing, "untried");
});

test("quality successes without comparable measured executions do not prove an efficiency improvement", () => {
  const artifact = proposedSearch(), first = feedback();
  const second = feedback({ feedbackId: "feedback:use-2", useId: "use:2", executionId: "execution:quality-b", evidenceRefs: ["receipt:current-check-2"] });
  const result = workflowImprovementReputation(artifact, [first, second], first.versionId);

  assert.equal(result.qualityPasses, 2);
  assert.equal(result.comparableUses, 0);
  assert.equal(result.improvements, 0);
  assert.notEqual(result.standing, "supported");
  assert.equal(parseWorkflowImprovementFeedback(improvementFeedbackFixture({ comparison: {
    ...measuredSearchComparison(), candidateExecutionId: measuredSearchComparison().baselineExecutionId,
  } })).ok, false);
});
