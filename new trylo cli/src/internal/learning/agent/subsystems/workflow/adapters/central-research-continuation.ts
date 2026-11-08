import type { BoardState } from "../../../../control/state.js";
import { identity } from "../../../../../validation/json-shape.js";
import { canonicalJson } from "../../../../control/hash.js";
import { isCentralRuntimeReferences } from "../../../../central/runtime/validation.js";
import { workflowImprovementsFromBoard } from "./improvement-board.js";
import { workflowResearchGrantBinding } from "./research-funding.js";
import { workflowResearchChain } from "../runtime/research-state.js";

export type WorkflowCentralResearchContinuation = {
  readonly kind: "continuable"; readonly cursorRef: string; readonly sourceRefs: readonly string[];
} | { readonly kind: "waiting" | "terminal" | "inspection"; readonly reason: string; readonly sourceRefs: readonly string[] };

type Input = { readonly board: BoardState; readonly scope: string; readonly issueId: string; readonly grantId: string;
  /** The host has verified the latest original frozen assignment and program. */
  readonly lastStageCommittedAtSequence: number; readonly previousCursorRefs: readonly string[] };

/** A confirmed original checkpoint can authorize consideration of the next
 * internal action. It never grants funds, changes focus, or sends a request. */
export function readWorkflowCentralResearchContinuation(input: Input): WorkflowCentralResearchContinuation {
  const refs = [input.issueId, input.grantId];
  const result = (kind: "waiting" | "terminal" | "inspection", reason: string,
    sourceRefs: readonly string[] = refs): WorkflowCentralResearchContinuation =>
    ({ kind, reason: `workflow_research_continuation_${reason}`, sourceRefs });

  if (![input.scope, input.issueId, input.grantId].every(identity) || !isCentralRuntimeReferences(input.previousCursorRefs)
    || !Number.isSafeInteger(input.lastStageCommittedAtSequence) || input.lastStageCommittedAtSequence < 0
    || input.lastStageCommittedAtSequence > input.board.sequence) return result("inspection", "input_invalid", []);

  const issue = input.board.learningIssues?.find(item => item.scope === input.scope && item.issueId === input.issueId);
  const report = [...(issue?.reports ?? [])].reverse().find(item => "subsystem" in item.source && item.source.subsystem === "workflow");
  if (issue === undefined || report === undefined || !("subsystem" in report.source)) return result("inspection", "original_source_missing");

  const inputVersionId = report.source.versionId;
  const asset = input.board.assets.find(item => item.versionId === inputVersionId && item.kind === "workflow");
  if (asset === undefined || !input.previousCursorRefs.includes(inputVersionId)) return result("inspection", "original_source_changed");

  const grant = input.board.centralLearningGrants?.find(item => item.grantId === input.grantId);
  if (grant === undefined || grant.domain !== "workflow" || grant.scope !== input.scope || grant.issueId !== issue.issueId
    || grant.budgetId === undefined || grant.authorizationRef === undefined || grant.planRef === undefined) {
    return result("inspection", "original_owner_changed");
  }

  const sourceRefs = [...new Set([...refs, inputVersionId, grant.jobId])];

  if (grant.status === "closed" || issue.decision.kind === "resolved" || issue.decision.kind === "ordinary_execution") {
    return result("terminal", "original_source_closed", sourceRefs);
  }

  const bound = workflowResearchGrantBinding(input.board, { grantId: grant.grantId, jobId: grant.jobId,
    inputVersionId, state: "queued", resultRefs: [] }, { scope: asset.scope, centralScope: input.scope,
    binding: { grantId: grant.grantId, inputVersionId } });
  if (!bound.ok) return result("inspection", "original_binding_changed", sourceRefs);

  const { job } = bound.value;

  if (job.coordination?.issueId !== issue.issueId || job.coordination.grantId !== grant.grantId) {
    return result("inspection", "original_job_changed", sourceRefs);
  }

  if (grant.claim !== undefined || job.state === "running") return result("waiting", "original_owner_running", sourceRefs);

  if (job.state !== "queued" || job.breakerOpen) return result("waiting", "original_job_unavailable", sourceRefs);

  const view = workflowImprovementsFromBoard(input.board, asset.scope, input.scope);
  if (!view.ok || !view.value.opportunities.some(item => item.versionId === inputVersionId)) {
    return result("inspection", "original_material_unavailable", sourceRefs);
  }

  const chain = workflowResearchChain(view.value.research ?? [], inputVersionId, grant.grantId);
  if (!chain.ok) return result("inspection", "checkpoint_history_invalid", sourceRefs);

  const checkpoints = new Set(chain.value.map(item => item.record.reservationId));
  if (grant.reservations.some(item => item.state !== "settled" || item.usage?.kind !== "reported" || !checkpoints.has(item.reservationId))
    || chain.value.some(item => !grant.reservations.some(reservation => reservation.reservationId === item.record.reservationId))) {
    return result("inspection", "paid_checkpoint_missing", sourceRefs);
  }

  const head = chain.value.at(-1);
  if (head === undefined) return result("waiting", "confirmed_checkpoint_missing", sourceRefs);

  sourceRefs.push(head.versionId, head.record.reservationId, head.record.contextRef);

  if (input.previousCursorRefs.includes(head.versionId)) return result("waiting", "cursor_already_consumed", sourceRefs);

  const committed = input.board.appliedCommands.find(item => item.commandId === `proposal:${head.versionId}:commit`);
  if (committed === undefined || committed.sequence <= input.lastStageCommittedAtSequence
    || !input.previousCursorRefs.includes(head.record.contextRef)) return result("inspection", "assignment_checkpoint_mismatch", sourceRefs);

  if (head.record.status === "stopped") return result("terminal", "worker_stopped", sourceRefs);

  if (head.record.status === "waiting_evidence") return result("waiting", "external_evidence_required", sourceRefs);

  if (head.record.status === "continue") {
    const observation = head.record.observation;
    if (observation.kind === "invalid_response") return result("waiting", "response_rejected", sourceRefs);

    // These are immutable evidence/version identities. A changed central
    // context does not make reading the same original material new work.
    const earlier = chain.value.slice(0, -1).flatMap(item => item.record.status === "continue" ? [item.record.observation] : []);

    if (observation.kind === "material_read") {
      const read = new Set(earlier.flatMap(item => item.kind === "material_read" ? item.evidenceRefs : []));
      if (!observation.evidenceRefs.some(ref => !read.has(ref))) return result("waiting", "material_already_read", sourceRefs);
    } else if (observation.kind === "versions_compared") {
      if (observation.versionIds.length < 2 || earlier.some(item => item.kind === "versions_compared"
        && canonicalJson([...item.versionIds].sort()) === canonicalJson([...observation.versionIds].sort()))) {
        return result("waiting", "comparison_already_observed", sourceRefs);
      }
    } else if (earlier.some(item => canonicalJson(item) === canonicalJson(observation))) {
      return result("waiting", "finding_repeated", sourceRefs);
    }
  }

  return { kind: "continuable", cursorRef: head.versionId, sourceRefs };
}
