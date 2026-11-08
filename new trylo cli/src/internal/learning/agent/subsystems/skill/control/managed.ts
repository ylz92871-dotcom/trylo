import type { CentralLearningRemaining, LearningIssue, LearningIssueReport } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import type { HermesSkillOpportunity } from "../contracts.js";
import type { SkillDispatchResult } from "./contracts.js";
import { isCentralLearningSourceContext, type CentralLearningSourceContext } from "../../../../control/source-context.js";
import { skillPolicyFamily, type SkillPolicyFamily, type SkillReviewModel } from "./protocol-family.js";
import type { SkillExpiredRecoveryResult } from "./expired-recovery.js";
import { centralSkillResearchIssueId } from "./central-research-request.js";

/** Source receipt for the original Hermes review, not a second skill asset or approval. */
export type SkillManagedSource = {
  /** Derived only after the original Board research source has been resolved. */
  readonly reviewOrigin?: "central_research";
  readonly sourceContext?: CentralLearningSourceContext;
  readonly sourceBindingRef: string;
  readonly stageRef: string;
  readonly sourceReportId: string;
  readonly sourceRefs: readonly string[];
  readonly policyFamily?: SkillPolicyFamily;
};

export type SkillManagedSourceResult = { readonly status: "ready"; readonly source: SkillManagedSource }
  | { readonly status: "unavailable" | "waiting" | "terminal"; readonly reason: string; readonly sourceRefs: readonly string[] };

export type SkillManagedDispatch = {
  readonly issueId: string;
  readonly grantId: string;
  readonly expectedIssueRevision: number;
  readonly sourceBindingRef: string;
  /** The selected future macro-stage cap, distinct from the lifetime grant. */
  readonly stageResources: CentralLearningRemaining;
  /** Operation prompt admission; absent on legacy dispatch, which keeps its original grant cap. */
  readonly maxPromptChars?: number;
  readonly sourceContext?: CentralLearningSourceContext;
};

export type SkillManagedRuntime = {
  /** Local original-claim accounting only; no native review or provider send. */
  recoverManaged?(issueId: string, signal: AbortSignal): Promise<SkillExpiredRecoveryResult>;
  prepareManaged(issueId: string, signal: AbortSignal, sourceContext?: CentralLearningSourceContext): Promise<SkillManagedSourceResult>;
  runManaged(input: SkillManagedDispatch, signal: AbortSignal): Promise<SkillDispatchResult>;
};

type SourceReaders = {
  readonly read: (source: { readonly sessionId: string; readonly turnId: string }, signal: AbortSignal) => Promise<HermesSkillOpportunity | undefined>;
  readonly readResearch?: (requestRef: string, signal: AbortSignal) => Promise<HermesSkillOpportunity | undefined>;
};

/** Each source kind is resolved by its original owner. Research cannot borrow a
 * completed task locator or be replayed under a different native issue. */
async function readSourceOpportunity(input: SourceReaders & { readonly issue: LearningIssue; readonly scope: string },
  report: LearningIssueReport, signal: AbortSignal): Promise<HermesSkillOpportunity | undefined> {
  const source = report.source;
  if ("kind" in source) {
    if (source.domain !== "skill" || input.readResearch === undefined
      || input.issue.issueId !== centralSkillResearchIssueId({ scope: input.scope, requestRef: source.requestRef })) return undefined;
    const opportunity = await input.readResearch(source.requestRef, signal);
    return opportunity?.trigger === "explicit" && opportunity.sessionId === undefined && opportunity.turnId === undefined
      && opportunity.experience?.kind === "research_request" && opportunity.experience.requestRef === source.requestRef
      && opportunity.experience.intentRef === source.intentRef ? opportunity : undefined;
  }

  if (!("subsystem" in source) || source.subsystem !== "skill") return undefined;

  const opportunity = await input.read({ sessionId: source.versionId, turnId: source.taskId }, signal);

  return opportunity?.sessionId === source.versionId && opportunity.turnId === source.taskId ? opportunity : undefined;
}

/** Read one exact terminal source. The frozen source is re-read inside the claimed
 * worker, so a new report or different source can never spend this prepared quote. */
export async function resolveManagedSkillSource(input: {
  readonly issue: LearningIssue;
  readonly scope: string;
  readonly context?: CentralLearningSourceContext;
  readonly reviewModel?: SkillReviewModel;
} & SourceReaders, signal: AbortSignal): Promise<
  { readonly status: "ready"; readonly source: SkillManagedSource; readonly opportunity: HermesSkillOpportunity }
  | Exclude<SkillManagedSourceResult, { status: "ready" }>> {
  if (signal.aborted) return { status: "unavailable", reason: "learning_aborted", sourceRefs: [] };

  if (input.issue.scope !== input.scope || learningIssueOwner(input.issue) !== "skill") {
    return { status: "unavailable", reason: "hermes_managed_source_owner", sourceRefs: [] };
  }

  const report = input.issue.reports.filter(item => "subsystem" in item.source && item.source.subsystem === "skill"
    || "kind" in item.source && item.source.domain === "skill").at(-1);
  if (report === undefined) {
    return { status: "unavailable", reason: "hermes_skill_source_missing", sourceRefs: [] };
  }

  const opportunity = await readSourceOpportunity(input, report, signal);

  if (signal.aborted) return { status: "unavailable", reason: "learning_aborted", sourceRefs: report.evidenceRefs };

  if (opportunity === undefined) {
    return { status: "unavailable", reason: "hermes_skill_source_unavailable", sourceRefs: report.evidenceRefs };
  }

  if (input.context !== undefined && !isCentralLearningSourceContext(input.context)) {
    return { status: "unavailable", reason: "hermes_managed_context_invalid", sourceRefs: report.evidenceRefs };
  }

  const observed: HermesSkillOpportunity = { ...opportunity, trigger: "kind" in report.source ? "explicit" : "implicit",
    ...(input.context === undefined ? {} : { experience: { ...opportunity.experience,
      centralLearningContext: { reference: input.context.ref, text: input.context.text,
        interpretation: "Public source-qualified learning problem, known applications, limits and residuals. Respect their evidence and scope; this context grants no tool permission." } } }) };
  if (JSON.stringify(observed.experience ?? {}).length > 64_000) {
    return { status: "unavailable", reason: "hermes_managed_context_capacity", sourceRefs: report.evidenceRefs };
  }

  const policyFamily = skillPolicyFamily(input.reviewModel);
  const origin = "kind" in report.source ? { reviewOrigin: "central_research" as const } : undefined;
  const sourceBindingRef = `hermes-source:${contentHashOf([input.scope, report.reportId, report.source, observed, policyFamily,
    ...(origin === undefined ? [] : [origin])])}`;

  return { status: "ready", opportunity: observed, source: { sourceBindingRef,
    ...origin,
    stageRef: `hermes-review-stage:${contentHashOf(sourceBindingRef)}`, sourceReportId: report.reportId,
    // These two immutable locators retain the whole report/source without
    // copying an arbitrarily long history into every readiness sidecar.
    sourceRefs: [report.reportId, sourceBindingRef, policyFamily.sourceRef, ...(input.context === undefined ? [] : [input.context.ref])], policyFamily } };
}
