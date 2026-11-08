import type { BoardState } from "../../../../control/state.js";
import { canonicalJson } from "../../../../control/hash.js";
import { identity } from "../../../../../validation/json-shape.js";
import { isCentralRuntimeReferences } from "../../../../central/runtime/validation.js";
import { methodResearchGrantId, methodResearchIssueId, readMethodResearch } from "./central-research-records.js";

export type CentralMethodResearchContinuation = {
  readonly kind: "continuable"; readonly cursorRef: string; readonly sourceRefs: readonly string[];
} | { readonly kind: "waiting" | "terminal" | "inspection"; readonly reason: string; readonly sourceRefs: readonly string[] };

type Input = { readonly board: BoardState; readonly scope: string; readonly issueId: string; readonly grantId: string;
  /** The host already verified this exact original frozen input. */
  readonly lastStageInputHash: string; readonly previousCursorRefs: readonly string[] };

/** Original domain facts can expose an unconsumed internal finding. This read
 * never prices its value, reopens a terminal source, or issues execution/funds. */
export function readCentralMethodResearchContinuation(input: Input): CentralMethodResearchContinuation {
  const refs = [input.issueId, input.grantId];
  const result = (kind: "waiting" | "terminal" | "inspection", reason: string, sourceRefs: readonly string[] = refs): CentralMethodResearchContinuation =>
    ({ kind, reason: `method_research_continuation_${reason}`, sourceRefs });

  if (![input.scope, input.issueId, input.grantId].every(identity) || !/^[a-f0-9]{64}$/.test(input.lastStageInputHash)
    || !isCentralRuntimeReferences(input.previousCursorRefs)) return result("inspection", "input_invalid", []);

  const issue = input.board.learningIssues?.find(item => item.scope === input.scope && item.issueId === input.issueId);
  const original = issue?.reports[0]?.source;
  if (issue === undefined || original === undefined || !("kind" in original) || original.kind !== "research_request" || original.domain !== "prompt") {
    return result("inspection", "original_source_missing");
  }

  if (issue.issueId !== methodResearchIssueId(original.requestRef) || input.grantId !== methodResearchGrantId(original.requestRef)
    || issue.reports.some(item => !("kind" in item.source) || item.source.kind !== "research_request" || item.source.domain !== "prompt"
      || item.source.requestRef !== original.requestRef || item.source.intentRef !== original.intentRef)) return result("inspection", "original_source_changed");

  let history: ReturnType<typeof readMethodResearch>;

  try { history = readMethodResearch(input.board, input.scope, original.requestRef); }
  catch { return result("inspection", "checkpoint_history_invalid"); }

  if (history === undefined || history.request.intentRef !== original.intentRef || history.request.intent.subject.plane !== "central"
    || history.request.intent.subject.questionRef !== original.intentRef) return result("inspection", "original_intent_changed");

  const sourceRefs = [...new Set([...refs, original.requestRef, original.intentRef, history.requestId, history.headRef])];
  const grant = input.board.centralLearningGrants?.find(item => item.grantId === input.grantId);
  const job = input.board.jobs.find(item => item.jobId === grant?.jobId);
  if (grant === undefined || job === undefined || grant.scope !== input.scope || grant.domain !== "prompt" || grant.issueId !== issue.issueId
    || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId || job.scope !== input.scope || job.domain !== "prompt"
    || job.coordination?.issueId !== issue.issueId || job.coordination.grantId !== grant.grantId || grant.budgetId === undefined
    || grant.authorizationRef === undefined || grant.planRef === undefined) return result("inspection", "original_owner_changed", sourceRefs);

  sourceRefs.push(job.jobId);

  if (grant.status === "closed" || issue.decision.kind === "resolved" || issue.decision.kind === "ordinary_execution") {
    return result("terminal", "original_source_closed", sourceRefs);
  }

  if (issue.decision.kind !== "focused_learning" || grant.focusRevision !== issue.decision.revision) return result("inspection", "original_focus_changed", sourceRefs);

  if (grant.claim !== undefined || job.state === "running") return result("waiting", "original_owner_running", sourceRefs);

  if (grant.reservations.some(item => item.state !== "settled" || item.usage?.kind !== "reported")) return result("inspection", "reservation_unconfirmed", sourceRefs);

  const checkpoints = new Set(history.checkpoints.map(item => item.step.reservationId));
  if (grant.reservations.some(item => !checkpoints.has(item.reservationId))
    || history.checkpoints.some(item => !grant.reservations.some(reservation => reservation.reservationId === item.step.reservationId))) {
    return result("inspection", "paid_checkpoint_missing", sourceRefs);
  }

  if (["succeeded", "failed", "cancelled", "expired"].includes(job.state)) return result("inspection", "original_job_state_changed", sourceRefs);

  if (job.state !== "queued" || job.breakerOpen) return result("waiting", "original_job_unavailable", sourceRefs);

  const boundary = history.checkpoints.at(-1);
  if (boundary?.step.type === "method_research_unsent" || boundary?.step.type === "method_research_rejected") {
    const cursorRefs = [...new Set([...sourceRefs, boundary.step.reservationId])];
    if (boundary.step.stageInputHash !== input.lastStageInputHash) return result("inspection", "stage_input_mismatch", cursorRefs);
    if (input.previousCursorRefs.includes(boundary.ref)) return result("waiting", "cursor_already_consumed", cursorRefs);
    return { kind: "continuable", cursorRef: boundary.ref, sourceRefs: cursorRefs };
  }

  const latest = history.steps.at(-1);
  if (latest === undefined) return result("waiting", "confirmed_finding_missing", sourceRefs);

  const cursorRefs = [...new Set([...sourceRefs, latest.step.reservationId])];

  if (latest.step.stageInputHash !== input.lastStageInputHash) return result("inspection", "stage_input_mismatch", cursorRefs);

  if (input.previousCursorRefs.includes(latest.ref)) return result("waiting", "cursor_already_consumed", cursorRefs);

  if (latest.step.finding.kind === "stopped") return result("terminal", "worker_stopped", cursorRefs);

  if (latest.step.finding.kind !== "finding") return result("waiting", latest.step.finding.kind === "candidate" ? "candidate_delivered" : "external_evidence_required", cursorRefs);

  if (history.steps.slice(0, -1).some(item => canonicalJson(item.step.finding) === canonicalJson(latest.step.finding))) {
    return result("waiting", "finding_repeated", cursorRefs);
  }

  return { kind: "continuable", cursorRef: latest.ref, sourceRefs: cursorRefs };
}
