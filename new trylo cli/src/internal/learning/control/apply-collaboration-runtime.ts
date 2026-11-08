import type { CollaborationRuntimeReceipt } from "../../protocol/collaboration-resource.js";
import { isCollaborationExperienceContent } from "../agent/subsystems/collaboration/experience/parse.js";
import { experienceOwnerFingerprint } from "../agent/subsystems/collaboration/experience/policy.js";
import { experienceAssessmentExpectationsValid } from "../agent/subsystems/collaboration/experience/assessment.js";
import type { BoardCommand } from "./commands.js";
import { isCollaborationRuntimeReceipt } from "./collaboration-runtime-parse.js";
import { contentHashOf } from "./hash.js";
import { collaborationResourceResultMatches } from "./collaboration-resource-relation.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";

export const MAX_COLLABORATION_RUNTIME_RECEIPTS = 8192;

function referencesValid(state: BoardState, r: CollaborationRuntimeReceipt): boolean {
  if (r.phase === "use_feedback") return experienceAssessmentExpectationsValid(state, r) && state.collaborationRuntimeReceipts?.some(u => u.phase === "dispatched"
    && u.receiptId === r.usageReceiptId && u.scope === r.scope && contentHashOf(u.owner) === contentHashOf(r.owner)
    && contentHashOf([...u.versionIds].sort()) === contentHashOf([...r.versionIds].sort())) === true;

  if ("versionIds" in r) return r.versionIds.every(id => state.assets.some(a => a.versionId === id
    && a.scope === r.scope && isCollaborationExperienceContent(a.content)
    && experienceOwnerFingerprint(a.content.owner) === r.ownerFingerprint));

  if (!state.centralLearningGrants?.some(g => g.grantId === r.grantId && g.issueId === r.issueId && g.jobId === r.jobId && g.scope === r.scope)) return false;

  if (r.phase === "resource_query") return state.learningIssues?.some(i => i.issueId === r.issueId && i.scope === r.scope) === true;

  return state.collaborationRuntimeReceipts?.some(q => q.phase === "resource_query" && collaborationResourceResultMatches(q, r)) === true;
}

export function validCollaborationRuntimeReceipts(state: BoardState): boolean {
  const receipts = state.collaborationRuntimeReceipts === undefined ? [] : state.collaborationRuntimeReceipts;
  return Array.isArray(receipts) && receipts.length <= MAX_COLLABORATION_RUNTIME_RECEIPTS
    && receipts.every(isCollaborationRuntimeReceipt) && new Set(receipts.map(r => r.receiptId)).size === receipts.length
    && new Set(receipts.filter(r => r.phase === "use_feedback").map(r => r.usageReceiptId)).size === receipts.filter(r => r.phase === "use_feedback").length
    && receipts.every(r => referencesValid(state, r));
}

export function applyCollaborationRuntime(state: BoardState, command: Extract<BoardCommand, { type: "record_collaboration_runtime" }>): ReduceResult {
  const r = command.receipt, previous = state.collaborationRuntimeReceipts ?? [];
  if (!isCollaborationRuntimeReceipt(r) || command.commandId !== `collaboration-runtime:${r.receiptId}` || !referencesValid(state, r)) {
    return fail(state, "collaboration_reference_invalid", "runtime_receipt_invalid");
  }

  if (previous.length >= MAX_COLLABORATION_RUNTIME_RECEIPTS) return fail(state, "collaboration_reference_invalid", "runtime_receipt_capacity");

  if (r.phase === "use_feedback" && previous.some(p => p.phase === "use_feedback" && p.usageReceiptId === r.usageReceiptId)) {
    return fail(state, "feedback_conflict", r.usageReceiptId);
  }

  if (previous.some(p => p.receiptId === r.receiptId)) return fail(state, "command_payload_conflict", r.receiptId);

  return succeed(state, command.commandId, [{ type: "collaboration_runtime_recorded", sequence: nextSeq(state),
    commandId: command.commandId, occurredAt: r.recordedAt, receipt: r }], { collaborationRuntimeReceipts: [...previous, r] });
}
