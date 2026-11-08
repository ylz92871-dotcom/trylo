import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { MAX_CENTRAL_LEARNING_RESOURCE } from "../../learning/control/central-learning-resources.js";
import { isContentDataSafe } from "./content-confidentiality.js";
import { contentRecordsForIssue } from "./issue-view.js";
import { mapBoardContentArtifacts, contentSubsystem } from "./sources/artifact.js";
import { boardUserFeedbackMaterialBatch } from "./sources/feedback-board.js";
import { selectContentFeedbackMaterial } from "./sources/feedback-paging.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS, readDomainFeedbackMaterial, type ContentDomainFeedbackReader } from "./sources/domain-feedback.js";
import { publicContentIssueReports } from "./issue-report-public-view.js";

/** Read-only material for the original domain model builder. Insert BEFORE its prompt reservation/size
 * calculation; wrapping an already billed provider would omit this material from its accounting. */
export async function contentContextForIssue(input: { readonly boardRoot: string; readonly scope: string; readonly issueId: string;
  readonly maximumChars: number; readonly enabled: () => boolean; readonly secrets?: readonly string[];
  readonly domainFeedback?: ContentDomainFeedbackReader }) {
  if (!input.enabled()) return { ok: false as const, reason: "collect_disabled" };

  // An explicit caller allowance is checked against the resource contract,
  // not the old default prompt size. The complete rendered input still fits it.
  if (!Number.isSafeInteger(input.maximumChars) || input.maximumChars < 1 || input.maximumChars > MAX_CENTRAL_LEARNING_RESOURCE) {
    return { ok: false as const, reason: "content_context_capacity" };
  }

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return { ok: false as const, reason: loaded.reason };

  if (!input.enabled()) return { ok: false as const, reason: "collect_disabled" };

  const issue = loaded.state.learningIssues?.find(row => row.issueId === input.issueId && row.scope === input.scope);
  if (issue === undefined) return { ok: false as const, reason: "content_issue_missing" };

  const records = contentRecordsForIssue(loaded.state, input.scope, issue.issueId);
  const owner = learningIssueOwner(issue);
  if (owner === "ambiguous") return { ok: false as const, reason: "content_issue_owner_ambiguous" };

  const domain = records.at(-1)?.packet.domain ?? (owner === "method" ? "prompt" : owner);
  const domainRead = input.domainFeedback === undefined ? undefined : await readDomainFeedbackMaterial({
    domainFeedback: input.domainFeedback, board: loaded.state, scope: input.scope, domain, issueIds: [issue.issueId],
    signal: new AbortController().signal, maximumChars: Math.max(1024, Math.min(MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS, Math.floor(input.maximumChars / 3))),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }) });
  if (domainRead !== undefined && !domainRead.ok) return { ok: false as const, reason: domainRead.reason };

  if (!input.enabled()) return { ok: false as const, reason: "collect_disabled" };

  const domainMaterial = domainRead?.ok ? domainRead.value : undefined;
  const feedback = selectContentFeedbackMaterial({ batches: [boardUserFeedbackMaterialBatch({ board: loaded.state, scope: input.scope,
    subsystem: contentSubsystem(domain), artifacts: mapBoardContentArtifacts(loaded.state, input.scope), issueId: issue.issueId })],
    scope: input.scope, issueId: issue.issueId, maximumChars: Math.max(2048, Math.min(12000, Math.floor(input.maximumChars / 3))) });
  const selected: unknown[] = [], sourceRefs: string[] = [];
  const publicReports = publicContentIssueReports(loaded.state, issue);
  const view = () => ({ schemaVersion: 1, role: "original_problem_content_and_public_model_results_not_verification_or_permissions",
    issueId: issue.issueId, currentFocusRevision: issue.decision.kind === "unreviewed" ? null : issue.decision.revision,
    currentDecision: issue.decision, currentReports: publicReports, records: selected,
    currentExplicitUserFeedback: feedback.batch, feedbackCoverage: feedback.coverage,
    ...(domainMaterial === undefined ? {} : { currentDomainFeedback: domainMaterial.batch, domainFeedbackCoverage: domainMaterial.coverage }),
    recordCoverage: { available: records.length, shown: selected.length, omitted: records.length - selected.length },
    interpretation: "A later no-new-topic does not clear an earlier residual; prior results and conditions require semantic comparison." });
  const render = () => canonicalJson(view());

  for (const row of [...records].reverse()) {
    const value = { factId: row.factId, processId: row.output.processId, knownAtBoardSequence: row.packet.boardSequence,
      originalFocus: row.packet.focus === undefined ? null : { issueId: row.packet.focus.issueId, revision: row.packet.focus.revision, decision: row.packet.focus.decision,
        reports: row.packet.focus.issueId === issue.issueId && row.packet.focus.scope === issue.scope
          ? publicContentIssueReports(loaded.state, { ...issue, reports: row.packet.focus.reports }) : row.packet.focus.reports }, originalRequirements: row.packet.requirements,
      applied: row.output.applied, review: row.output.review, remaining: row.output.remaining };

    selected.push(value);

    if (render().length > input.maximumChars) {
      selected.pop();
      if (selected.length === 0) return { ok: false as const, reason: "content_context_capacity" };
      break;
    }

    sourceRefs.push(row.factId);
  }

  const text = render();
  if (text.length > input.maximumChars) return { ok: false as const, reason: "content_context_capacity" };

  if (!isContentDataSafe(view(), input, input.secrets ?? [])) return { ok: false as const, reason: "topic_sensitive_content" };

  return { ok: true as const, value: { text, sourceRefs, issueId: issue.issueId, boardSequence: loaded.state.sequence,
    contextRef: `content-issue-context:${contentHashOf(text)}`, availableRecords: records.length, shownRecords: selected.length,
    availableFeedback: feedback.coverage.available + (domainMaterial?.coverage.frames.length ?? 0) } };
}

export class ContentIssueContextError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ContentIssueContextError";
  }
}

/** Exact callback shape for the original domain worker's pre-reservation prompt builder. */
export function createContentIssueContextReader(options: { readonly boardRoot: string; readonly scope: string; readonly maximumChars: number;
  readonly enabled: () => boolean; readonly secrets?: readonly string[]; readonly domainFeedback?: ContentDomainFeedbackReader }): CentralLearningContextReader {
  return async issueId => {
    if (!options.enabled()) return undefined;
    const result = await contentContextForIssue({ ...options, issueId });
    if (!result.ok) throw new ContentIssueContextError(result.reason);
    return result.value.shownRecords === 0 && result.value.availableFeedback === 0 ? undefined
      : { ref: result.value.contextRef, text: result.value.text };
  };
}
