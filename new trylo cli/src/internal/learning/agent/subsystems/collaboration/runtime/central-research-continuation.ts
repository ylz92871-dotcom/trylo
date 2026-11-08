import type { BoardState } from "../../../../control/state.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { contentHashOf } from "../../../../control/hash.js";
import { collaborationQueryMatchesReservation, collaborationResourceResultMatches } from "../../../../control/collaboration-resource-relation.js";
import { collaborationRecoveryEvidence } from "../control/central.js";
import type { CollaborationResourceReceipt } from "../../../../../protocol/collaboration-resource.js";
import type { CentralResearchContinuation, CentralResearchContinuationInput } from "../../../../../integration/central-learning/research-intake-continuation.js";

type Cursor = { readonly cursorRef: string; readonly sourceRefs: readonly string[]; readonly resultSequence?: number;
  readonly dependencyId?: string; readonly repeatedResult?: boolean };

type Cursors = { readonly kind: "continuable"; readonly cursors: readonly Cursor[] }
  | Exclude<CentralResearchContinuation, { kind: "continuable" }>;

/** The same evidence gate as the original owner, with actual result/dependency
 * identities. It neither reclaims a lease nor interprets counters as progress. */
export function readCollaborationResearchCursors(board: BoardState, input: {
  readonly scope: string; readonly issueId: string; readonly grantId: string;
}): Cursors {
  const grant = board.centralLearningGrants?.find(item => item.grantId === input.grantId);
  const current = grant === undefined ? undefined : coordinationForJob(board, grant.jobId);
  const refs = [input.issueId, input.grantId];

  if (current === undefined || current.issue.scope !== input.scope || current.issue.issueId !== input.issueId
    || current.grant.scope !== input.scope || current.job.scope !== input.scope || current.job.domain !== "collaboration"
    || (current.grant.domain ?? "collaboration") !== "collaboration" || learningIssueOwner(current.issue) !== "collaboration"
    || current.issue.grantId !== input.grantId || current.issue.jobId !== current.job.jobId) {
    return { kind: "inspection", reason: "collaboration_continuation_source_changed", sourceRefs: refs };
  }

  if (current.grant.status !== "open" || current.issue.decision.kind !== "focused_learning"
    || current.grant.focusRevision !== current.issue.decision.revision || current.job.breakerOpen
    || ["succeeded", "failed", "cancelled", "expired"].includes(current.job.state)) {
    return { kind: "terminal", reason: "collaboration_continuation_original_terminal", sourceRefs: refs };
  }

  if (current.grant.claim !== undefined || current.job.state !== "queued") {
    return { kind: "waiting", reason: "collaboration_continuation_original_owner_or_dependency_pending", sourceRefs: refs };
  }

  const pending = current.grant.reservations.filter(item => item.state !== "settled");
  if (pending.length > 0) return { kind: "inspection", reason: "collaboration_continuation_reservation_pending",
    sourceRefs: [...refs, ...pending.map(item => item.reservationId)] };

  const evidence = collaborationRecoveryEvidence(board, current);
  if (evidence.kind === "inspection") return { kind: "inspection", reason: evidence.reason, sourceRefs: evidence.sourceRefs };

  if (evidence.kind === "result") return { kind: evidence.result.kind === "waiting_dependency" ? "waiting" : "terminal",
    reason: "collaboration_continuation_original_result_pending", sourceRefs: evidence.sourceRefs };

  if ("planVersionId" in evidence && evidence.planVersionId !== undefined && evidence.dependencyIds !== undefined) {
    const planVersionId = evidence.planVersionId, dependencyIds = evidence.dependencyIds;
    const dependencies = new Map((board.learningDependencies ?? []).map(item => [item.dependencyId, item]));
    const cursors = dependencyIds.flatMap(id => {
      const dependency = dependencies.get(id);
      return dependency?.grantId === input.grantId && (dependency.state.kind === "ready" || dependency.state.kind === "authorized")
        ? [{ cursorRef: `${id}:revision:${dependency.revision}`, dependencyId: id, sourceRefs: [planVersionId, id,
          ...(dependency.state.kind === "ready" ? [dependency.state.resultRef] : [dependency.state.authorizationRef])] }] : [];
    });

    return cursors.length > 0 ? { kind: "continuable", cursors }
      : { kind: "waiting", reason: "collaboration_continuation_external_dependency_required", sourceRefs: refs };
  }

  const resource = (board.collaborationRuntimeReceipts ?? []).filter((item): item is CollaborationResourceReceipt => "issueId" in item && item.scope === input.scope
    && item.issueId === input.issueId && item.jobId === current.job.jobId && item.grantId === input.grantId);
  const queries = resource.filter(item => item.phase === "resource_query"), positions = new Map(board.appliedCommands.map(item => [item.commandId, item.sequence]));
  const results = resource.flatMap(result => {
    if (result.phase !== "resource_result") return [];

    const query = queries.find(item => collaborationResourceResultMatches(item, result));
    if (query === undefined) return [];

    const paid = current.grant.reservations.some(reservation => collaborationQueryMatchesReservation(query, reservation));
    const sequence = positions.get(`collaboration-runtime:${result.receiptId}`);

    return !paid || sequence === undefined ? [] : [{ sequence, cursorRef: result.receiptId,
      originalContent: contentHashOf([result.owner, result.query, result.summary, [...new Set(result.resultRefs)].sort()]),
      sourceRefs: [query.receiptId, result.receiptId, ...result.resultRefs] }];
  }).sort((a, b) => b.sequence - a.sequence);
  const latest = results[0];
  const repeated = latest === undefined ? undefined : results.find(item => item.sequence < latest.sequence && item.originalContent === latest.originalContent);

  return latest === undefined ? { kind: "waiting", reason: "collaboration_continuation_no_confirmed_cursor", sourceRefs: refs }
    : { kind: "continuable", cursors: [{ cursorRef: latest.cursorRef,
      sourceRefs: [...latest.sourceRefs, ...(repeated === undefined ? [] : [repeated.cursorRef])],
      resultSequence: latest.sequence, repeatedResult: repeated !== undefined }] };
}

/** Routing owns program/exact frozen-assignment validation. This original owner
 * additionally binds its historical source and refuses an already assigned cursor. */
export function readCollaborationResearchContinuation(input: CentralResearchContinuationInput, signal: AbortSignal): CentralResearchContinuation {
  if (signal.aborted) return { kind: "waiting", reason: "learning_aborted", sourceRefs: [] };

  const { board, lastStage } = input, grant = board.centralLearningGrants?.find(item => item.grantId === input.grantId);
  const issue = board.learningIssues?.find(item => item.issueId === input.issueId && item.scope === input.scope);
  const report = issue?.reports.find(item => item.reportId === lastStage.candidate.source.domainStage.sourceReportId);
  if (lastStage.scope !== input.scope || lastStage.input.issueId !== input.issueId || lastStage.input.grantId !== input.grantId
    || lastStage.candidate.source.issueId !== input.issueId || lastStage.candidate.source.grantId !== input.grantId
    || grant?.budgetId !== lastStage.budgetId || report === undefined || contentHashOf(report) !== lastStage.sourceReportHash
    || lastStage.schemaVersion === 2 && lastStage.sourceSnapshot.originalFocus.decisionRevision !== grant.focusRevision) {
    return { kind: "inspection", reason: "collaboration_continuation_original_assignment_changed", sourceRefs: [input.issueId, input.grantId] };
  }

  const result = readCollaborationResearchCursors(board, input);
  if (result.kind !== "continuable") return result;

  const prior = new Set(lastStage.candidate.source.domainStage.readiness.evidenceRefs);
  const cursor = result.cursors.find(item => !item.repeatedResult && !prior.has(item.cursorRef)
    && (item.resultSequence === undefined || item.resultSequence > lastStage.committedAtSequence)
    && (item.dependencyId === undefined || !prior.has(item.dependencyId)
      || [...prior].some(ref => ref.startsWith(`${item.dependencyId}:revision:`))));

  return cursor === undefined ? { kind: "waiting", reason: result.cursors.some(item => item.repeatedResult)
    ? "collaboration_continuation_result_already_observed" : "collaboration_continuation_cursor_already_assigned", sourceRefs: result.cursors.flatMap(item => item.sourceRefs) }
    : { kind: "continuable", cursorRef: cursor.cursorRef, sourceRefs: cursor.sourceRefs };
}
