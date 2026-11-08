import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import type { ResidualReviewDraft } from "../../learning/central/content/process-contract.js";
import { contentRecordsForIssue } from "./issue-view.js";
import { unseenIssueUserFeedback } from "./admission-freshness.js";
import { contentDomainFeedbackFingerprint, readContentDomainFeedbackAbsence, readContentDomainFeedbackBasis, isContentDomainFeedback,
  type ContentDomainFeedback, type ContentDomainFeedbackReader } from "./sources/domain-feedback-basis.js";
import { fields } from "../../validation/json-shape.js";
import { readIssueUserSourceFreshness, type ContentAdmissionSessionSource } from "./admission-user-source.js";

/** Explicit absent distinguishes an enabled source that withdrew its prior frame
 * from legacy callers that never configured a domain feedback reader. */
export type ContentAdmissionDomainSource = ContentDomainFeedback | { readonly status: "absent" };

export interface ContentIssueAdmission {
  readonly status: "needs_content" | "ready" | "end_suggested" | "review_required";
  readonly issueId: string;
  readonly domain?: LearningDomain;
  readonly processId?: string;
  readonly sourceRefs: readonly string[];
  readonly reason: string;
  readonly assessmentBasis: "domain_model_assessment_not_external_result_qualification";
  readonly recommendation?: ResidualReviewDraft["recommendation"];
  /** Latest result only. It does not clear any prior question or create independent opportunities. */
  readonly remainingCount: number;
  readonly preparationCount: number;
  readonly priorRemainingCount: number;
}

const base = (issueId: string) => ({ issueId, sourceRefs: [] as readonly string[],
  assessmentBasis: "domain_model_assessment_not_external_result_qualification" as const,
  remainingCount: 0, preparationCount: 0, priorRemainingCount: 0 });

/** Read only completed, actually saved ContentRecords. Prepared/applied/reviewed stage
 * facts alone cannot admit a worker; neither no_new_topic nor task success is a qualification. */
export function contentAdmissionFromBoard(board: BoardState, scope: string, issueId: string, domain?: LearningDomain,
  currentDomainFeedback?: ContentAdmissionDomainSource, secrets: readonly string[] = []): ContentIssueAdmission {
  const issue = board.learningIssues?.find(row => row.issueId === issueId && row.scope === scope);
  if (issue === undefined) return { ...base(issueId), status: "review_required", reason: "content_issue_missing" };

  const matching = contentRecordsForIssue(board, scope, issueId).filter(row => domain === undefined || row.packet.domain === domain);
  const latest = matching.at(-1);
  if (latest === undefined) return { ...base(issueId), status: "needs_content", reason: "content_completed_result_required" };

  const recommendation = latest.output.review.recommendation;
  const common = { ...base(issueId), domain: latest.packet.domain, processId: latest.output.processId, sourceRefs: [latest.factId], recommendation,
    remainingCount: latest.output.remaining.length, preparationCount: latest.output.applied.preparations.length,
    priorRemainingCount: matching.slice(0, -1).reduce((count, record) => count + record.output.remaining.length, 0) };
  const seenReports = new Set(latest.packet.focus!.reports.map(report => report.reportId));
  const added = issue.reports.filter(report => !seenReports.has(report.reportId));
  if (added.length > 0) return { ...common, status: "needs_content", sourceRefs: [latest.factId, ...added.map(report => report.reportId)],
    reason: "content_new_issue_reports_require_review" };

  const unseenFeedback = unseenIssueUserFeedback(board, scope, issueId, latest, secrets);
  if (unseenFeedback.length > 0) return { ...common, status: "needs_content", sourceRefs: [latest.factId, ...unseenFeedback],
    reason: "content_new_targeted_user_feedback_requires_review" };

  if (currentDomainFeedback !== undefined) {
    try {
      const prior = readContentDomainFeedbackBasis(latest.packet, issueId);
      if (fields(currentDomainFeedback, ["status"]) && currentDomainFeedback.status === "absent") {
        const acknowledged = readContentDomainFeedbackAbsence(latest.packet, issueId).some(observation => observation.scope === scope);
        if (prior.length > 0 && !acknowledged) return { ...common, status: "needs_content", sourceRefs: [latest.factId, ...prior.map(basis => basis.sourceRef)],
          reason: "content_domain_feedback_source_withdrawn" };
      } else if (isContentDomainFeedback(currentDomainFeedback)) {
        const fingerprint = contentDomainFeedbackFingerprint(currentDomainFeedback);
        if (!prior.some(basis => basis.sourceRef === currentDomainFeedback.sourceRef && basis.fingerprint === fingerprint)) {
          return { ...common, status: "needs_content", sourceRefs: [latest.factId, currentDomainFeedback.sourceRef],
            reason: "content_domain_feedback_source_changed" };
        }
      } else return { ...common, status: "review_required", reason: "content_domain_feedback_basis_invalid" };
    } catch { return { ...common, status: "review_required", reason: "content_domain_feedback_basis_invalid" }; }
  }

  if (recommendation.kind === "end") return { ...common, status: "end_suggested", reason: "content_model_end_suggested_owner_review_required" };

  if (recommendation.kind === "undetermined") return { ...common, status: "review_required", reason: "content_model_assessment_undetermined" };

  return { ...common, status: "ready", reason: "content_current_focus_model_assessment_available" };
}

/** Public read at the original Board, with no ledger, worker claim, grant or issue mutation. */
export async function contentAdmissionForIssue(input: { readonly boardRoot: string; readonly scope: string; readonly issueId: string;
  readonly enabled: () => boolean; readonly domain?: LearningDomain; readonly domainFeedback?: ContentDomainFeedbackReader;
  readonly secrets?: readonly string[];
  readonly sessionSource?: ContentAdmissionSessionSource;
  readonly signal?: AbortSignal }): Promise<ContentIssueAdmission> {
  if (!input.enabled()) return { ...base(input.issueId), status: "review_required", reason: "collect_disabled" };

  if (input.signal?.aborted) return { ...base(input.issueId), status: "review_required", reason: "content_cancelled" };

  try {
    const loaded = await createBoardReader(input.boardRoot).load();

    if (!input.enabled()) return { ...base(input.issueId), status: "review_required", reason: "collect_disabled" };

    if (!loaded.ok) return { ...base(input.issueId), status: "review_required", reason: loaded.reason };

    const frame = await input.domainFeedback?.(loaded.state, input.issueId);

    if (!input.enabled()) return { ...base(input.issueId), status: "review_required", reason: "collect_disabled" };

    if (input.signal?.aborted) return { ...base(input.issueId), status: "review_required", reason: "content_cancelled" };

    const secrets = input.secrets ?? input.sessionSource?.secrets ?? [];
    const admission = contentAdmissionFromBoard(loaded.state, input.scope, input.issueId, input.domain,
      input.domainFeedback !== undefined && frame === undefined ? { status: "absent" } : frame,
      secrets);
    if (input.sessionSource === undefined || admission.processId === undefined || admission.status === "needs_content") return admission;

    const latest = contentRecordsForIssue(loaded.state, input.scope, input.issueId)
      .filter(record => input.domain === undefined || record.packet.domain === input.domain).at(-1)!;
    const userSources = await readIssueUserSourceFreshness({ board: loaded.state, scope: input.scope, issueId: input.issueId,
      latest, source: { ...input.sessionSource, secrets }, ...(input.signal === undefined ? {} : { signal: input.signal }) });

    if (!input.enabled()) return { ...base(input.issueId), status: "review_required", reason: "collect_disabled" };

    if (input.signal?.aborted) return { ...base(input.issueId), status: "review_required", reason: "content_cancelled" };

    if (userSources.status === "invalid") return { ...admission, status: "review_required", reason: userSources.reason };

    return userSources.status === "current" ? admission : { ...admission, status: "needs_content",
      sourceRefs: [...admission.sourceRefs, ...userSources.sourceRefs], reason: "content_new_issue_user_input_requires_review" };
  } catch { return { ...base(input.issueId), status: "review_required", reason: "content_admission_unavailable" }; }
}
