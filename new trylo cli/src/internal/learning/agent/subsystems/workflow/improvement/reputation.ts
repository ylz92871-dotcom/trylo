import type { WorkflowImprovement, WorkflowImprovementFeedback, WorkflowImprovementReputation, WorkflowProcessTask } from "./contracts.js";
import { improvementApplies, workflowProcessEvidenceFits } from "./validation.js";
import { parseWorkflowImprovementFeedback } from "./parse.js";
import { workflowMatches, workflowConditionKey } from "../domain/family.js";

type ExecutionFeedback = {
  readonly records: readonly WorkflowImprovementFeedback[];
  readonly exposure: "reported_used" | "skipped";
  readonly quality: "passed" | "failed" | "unknown";
  readonly disputed: boolean;
  readonly evidenceRefs: readonly string[];
  readonly userAssessment?: WorkflowImprovementFeedback["userAssessment"];
};

/** Later external verdicts and explicit user feedback can complete unknown reports.
 * Aliases never become independent samples; conflicting final verdicts remain disputed. */
function executions(feedback: readonly WorkflowImprovementFeedback[]): readonly ExecutionFeedback[] {
  const grouped = new Map<string, WorkflowImprovementFeedback[]>();
  const useOwners = new Map<string, string>(), conflicted = new Set<string>();

  for (const item of feedback) {
    const owner = useOwners.get(item.useId);
    if (owner !== undefined && owner !== item.executionId) {
      conflicted.add(owner);
      conflicted.add(item.executionId);
    }
    useOwners.set(item.useId, item.executionId);
    const group = grouped.get(item.executionId) ?? [];
    if (!group.some(previous => previous.feedbackId === item.feedbackId && JSON.stringify(previous) === JSON.stringify(item))) group.push(item);
    grouped.set(item.executionId, group);
  }

  return [...grouped].map<ExecutionFeedback>(([executionId, records]) => {
    const known = records.filter(item => item.quality !== "unknown" && item.exposure === "reported_used");
    const qualities = new Set(known.map(item => item.quality));
    const disputed = conflicted.has(executionId) || qualities.size > 1;
    const quality = disputed || qualities.size === 0 ? "unknown" : known[0]!.quality;
    const userAssessment = records.filter(item => item.userAssessment !== undefined).at(-1)?.userAssessment;

    return { records, exposure: records.some(item => item.exposure === "reported_used") ? "reported_used" : "skipped",
      quality, disputed, evidenceRefs: [...new Set(known.flatMap(item => item.evidenceRefs))],
      ...(userAssessment === undefined ? {} : { userAssessment }) };
  });
}

function completeProcessRecords(artifact: WorkflowImprovement, records: readonly WorkflowImprovementFeedback[]) {
  return records.filter(item => item.processEvidence?.kind === "complete" && workflowProcessEvidenceFits(artifact, item.processEvidence));
}

function processObservation(artifact: WorkflowImprovement, records: readonly WorkflowImprovementFeedback[], credited: ReadonlySet<string>) {
  const observed = records.filter(item => item.processEvidence !== undefined && item.processEvidence.kind !== "unverified"
    && workflowProcessEvidenceFits(artifact, item.processEvidence)
    && item.processEvidence.evidenceRefs.every(ref => !credited.has(ref)));
  const complete = completeProcessRecords(artifact, observed);
  const kind = complete.length > 0 ? "complete" : observed.some(item => item.processEvidence?.kind === "partial") ? "partial" : "unverified";

  return { kind, complete, receipts: [...new Set(observed.flatMap(item => item.processEvidence !== undefined
    && item.processEvidence.kind !== "unverified" ? item.processEvidence.evidenceRefs : []))] };
}

function compareExecution(records: readonly WorkflowImprovementFeedback[], quality: "passed" | "failed") {
  const pairs = records.filter(item => item.quality === quality).flatMap(item => item.comparison === undefined ? [] : [item.comparison]);
  let improved = false, regressed = false;

  for (const pair of pairs) {
    if (pair.baselineQuality === "passed" && quality === "failed") regressed = true;
    else if (quality === "passed" && pair.baselineQuality === "failed") improved = true;
    else if (quality === "passed" && pair.baselineQuality === "passed") {
      improved ||= pair.candidateCost < pair.baselineCost;
      regressed ||= pair.candidateCost > pair.baselineCost;
    }
  }

  return { comparable: pairs.length > 0, improved: improved && !regressed, regressed };
}

/** Contextual descriptive evidence. Transfer starts without inherited host-task quality credit. */
export function workflowImprovementReputation(
  artifact: WorkflowImprovement,
  feedback: readonly WorkflowImprovementFeedback[],
  versionId: string,
  task: WorkflowProcessTask = artifact.opportunity.task,
): WorkflowImprovementReputation {
  const validated = feedback.flatMap(item => {
    const parsed = parseWorkflowImprovementFeedback(item);
    return parsed.ok ? [parsed.value] : [];
  }).filter(item => item.versionId === versionId
    && improvementApplies(artifact, item.task)
    && workflowConditionKey(item.task.conditions) === workflowConditionKey(task.conditions)
    && item.followedStepIds.every(id => artifact.proposal.procedure.steps.some(step => step.id === id)));
  const relatedAdverseUses = executions(validated.filter(item => !workflowMatches(item.task, task)))
    .filter(item => item.userAssessment?.judgment === "harmed" || item.exposure === "reported_used"
      && (item.quality === "failed" || item.disputed
        || item.quality !== "unknown" && compareExecution(completeProcessRecords(artifact, item.records), item.quality).regressed)).length;
  let reportedUses = 0, qualityPasses = 0, qualityFailures = 0, unknown = 0, skipped = 0;
  let comparableUses = 0, improvements = 0, regressions = 0, recentFailures = 0;
  let userHelped = 0, userHarmed = 0, userNeutral = 0, disputed = 0;
  let completeProcessUses = 0, partialProcessUses = 0, unverifiedProcessUses = 0, processQualityPasses = 0;
  const creditedReceipts = new Set<string>(), creditedUserActions = new Set<string>(), creditedProcessReceipts = new Set<string>();

  for (const item of executions(validated.filter(record => workflowMatches(record.task, task)))) {
    const assessment = item.userAssessment;
    if (assessment !== undefined && !creditedUserActions.has(assessment.evidenceRef)) {
      creditedUserActions.add(assessment.evidenceRef);
      if (assessment.judgment === "helped" && item.exposure === "reported_used") userHelped += 1;
      else if (assessment.judgment === "harmed") userHarmed += 1;
      else if (assessment.judgment === "neutral") userNeutral += 1;
    }

    if (item.exposure === "skipped") {
      skipped += 1;
      continue;
    }

    reportedUses += 1;
    const process = processObservation(artifact, item.records, creditedProcessReceipts);

    for (const ref of process.receipts) creditedProcessReceipts.add(ref);

    if (process.kind === "complete") completeProcessUses += 1;
    else if (process.kind === "partial") partialProcessUses += 1;
    else unverifiedProcessUses += 1;

    if (item.disputed) disputed += 1;

    const quality = item.evidenceRefs.some(ref => creditedReceipts.has(ref)) ? "unknown" : item.quality;
    if (quality !== "unknown") for (const ref of item.evidenceRefs) creditedReceipts.add(ref);

    if (quality === "passed") {
      qualityPasses += 1;
      recentFailures = 0;
      if (process.complete.some(record => record.quality === "passed")) processQualityPasses += 1;
    }
    else if (quality === "failed") {
      qualityFailures += 1;
      recentFailures += 1;
    }
    else unknown += 1;

    if (quality === "unknown") continue;

    const compared = compareExecution(process.complete, quality);
    if (compared.comparable) comparableUses += 1;

    if (compared.improved) improvements += 1;

    if (compared.regressed) regressions += 1;
  }

  const standing = qualityFailures > 0 || regressions > 0 || userHarmed > 0 || disputed > 0 || relatedAdverseUses > 0 ? "needs_revision"
    : processQualityPasses >= 2 && improvements > 0 ? "supported" : userHelped > 0 ? "user_supported"
      : reportedUses > 0 ? "trial" : "untried";

  return { reportedUses, qualityPasses, qualityFailures, unknown, skipped, comparableUses, improvements, regressions,
    recentFailures, userHelped, userHarmed, userNeutral, disputed, relatedAdverseUses,
    completeProcessUses, partialProcessUses, unverifiedProcessUses, processQualityPasses,
    qualityEstimate: (qualityPasses + 1) / (qualityPasses + qualityFailures + 2), standing };
}
