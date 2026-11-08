import type { BoardState } from "../../../../control/state.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { workflowImprovementsFromBoard } from "./improvement-board.js";
import { workflowSourceGrants } from "../runtime/improvement-source-grants.js";
import { workflowResearchChain } from "../runtime/research-state.js";
import type { WorkflowResearchFinding } from "../improvement/research-contracts.js";

export type WorkflowResearchProgress = {
  readonly schema: "workflow-research-progress/v1";
  readonly issueId: string; readonly inputVersionId: string; readonly grantId: string;
  readonly purpose: string; readonly checkpointRef: string | null;
  readonly confirmedSteps: number; readonly sourceRefs: readonly string[];
  readonly findings: readonly { readonly checkpointRef: string; readonly finding: WorkflowResearchFinding }[];
  readonly handback: { readonly kind: "continue_internal" | "await_external_evidence" | "budget_boundary" | "stopped"
    | "proposal_delivered" | "inspection_required" | "in_flight"; readonly reason: string };
  readonly goalCompletion: "not_inferred_from_proposal";
};

/** Public original-source progress for the independent central driver. It is a
 * read projection, not a new operation log, success judgment or funds writer. */
export function workflowResearchProgressFromBoard(board: BoardState, input: {
  readonly scope: string; readonly centralScope: string; readonly issueId: string;
}): WorkflowResearchProgress | undefined {
  const issue = board.learningIssues?.find(item => item.issueId === input.issueId && item.scope === input.centralScope);
  if (issue === undefined) return undefined;

  const view = workflowImprovementsFromBoard(board, input.scope, input.centralScope);
  if (!view.ok) return undefined;

  const refs = issue.reports.flatMap(report => "subsystem" in report.source && report.source.subsystem === "workflow" ? [report.source.versionId] : []);
  const source = [...view.value.opportunities].reverse().find(item => refs.includes(item.versionId));
  if (source === undefined) return undefined;

  const grants = workflowSourceGrants(board, input.centralScope, source.versionId);
  if (grants.length !== 1) return undefined;

  const grant = grants[0]!, chain = workflowResearchChain(view.value.research ?? [], source.versionId, grant.grantId);
  if (!chain.ok) return undefined;

  const head = chain.value.at(-1), job = board.jobs.find(item => item.jobId === grant.jobId);
  const confirmed = new Set(chain.value.map(item => item.record.reservationId)), remaining = centralLearningRemaining(grant);
  let handback: WorkflowResearchProgress["handback"];

  if (grant.reservations.some(item => item.state === "reserved" || item.usage?.kind !== "reported" || !confirmed.has(item.reservationId))) {
    handback = { kind: "inspection_required", reason: "A sent step lacks a confirmed response checkpoint; it cannot be resent." };
  } else if (head?.record.status === "stopped") handback = { kind: "stopped", reason: head.record.reason };
  else if (head?.record.status === "waiting_evidence") handback = { kind: "await_external_evidence", reason: head.record.reason };
  else if (head?.record.status === "candidate" && job?.state === "succeeded") handback = { kind: "proposal_delivered",
    reason: "The original proposal is available for a later applicable handoff; the purpose and benefit remain unassessed." };
  else if (job?.state === "running") handback = { kind: "in_flight", reason: "The original owner must finish or safely recover its lease." };
  else if (remaining.calls < 1 || remaining.steps < 1 || remaining.tokens < 2048) handback = { kind: "budget_boundary",
    reason: "Confirmed internal progress remains; continuing requires an authorized segment of this same original grant." };
  else handback = { kind: "continue_internal", reason: "Confirmed material/comparison/validation progress permits the next internal action without a new business event." };

  return { schema: "workflow-research-progress/v1", issueId: issue.issueId, inputVersionId: source.versionId, grantId: grant.grantId,
    purpose: source.record.opportunity.desiredOutcome, checkpointRef: head?.versionId ?? null, confirmedSteps: chain.value.length,
    findings: chain.value.flatMap(item => item.record.status === "continue" && item.record.observation.kind === "finding_recorded"
      ? [{ checkpointRef: item.versionId, finding: item.record.observation.finding }] : []).slice(-8),
    sourceRefs: [source.versionId, grant.grantId, ...chain.value.slice(-8).map(item => item.versionId)], handback,
    goalCompletion: "not_inferred_from_proposal" };
}
