import type { BoardState } from "../../learning/control/state.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { methodCentralFeedbackFromBoard } from "../../learning/agent/subsystems/method/adapters/index.js";
import { toolCentralFeedbackFromBoard } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { projectWorkflowCentralFeedback } from "../../learning/agent/subsystems/workflow/adapters/index.js";
import { projectCollaborationCentralFeedback } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { skillLifecycleProjection } from "../../learning/agent/subsystems/skill/index.js";
import { readSkillLifecycleFeedbackUnit } from "../../learning/agent/subsystems/skill/control/lifecycle.js";
import type { ContentDomainFeedback, ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import type { JsonValue } from "../../protocol/envelope.js";
import { canonicalJson } from "../../learning/control/hash.js";

export type OrganizationNativeFeedbackUnit = { readonly kind: "found"; readonly recordKind: string;
  readonly payload: JsonValue; readonly sourceRefs: readonly string[] } | { readonly kind: "missing" | "not_supported" };

function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  return typeof value === "object" && Object.values(value).every(item => jsonValue(item, depth + 1));
}

/** Select an already validated original owner's exact unit body. Frame wrapper
 * revisions, selectors and stage lessons are deliberately not unit content. */
export function readOrganizationNativeFeedbackUnit(frame: ContentDomainFeedback | undefined,
  change: ContentDomainFeedbackChange): OrganizationNativeFeedbackUnit {
  if (change.domain !== "tool" && change.domain !== "workflow" && change.domain !== "collaboration"
    && change.domain !== "prompt" && change.domain !== "skill") return { kind: "not_supported" };

  if (frame === undefined) return { kind: "missing" };

  if (change.domain === "skill") return readSkillLifecycleFeedbackUnit(frame, change);

  const rows = frame.records.filter(row => row.factRef === change.factRef && row.unitRef === change.unitRef && row.revisionRef === change.revisionRef);
  if (rows.length === 0) return { kind: "missing" };

  let selected: Extract<OrganizationNativeFeedbackUnit, { kind: "found" }> | undefined, serialized: string | undefined;
  const sourceRefs = new Set([change.factRef, change.unitRef, change.revisionRef]);

  for (const row of rows) {
    if (typeof row.kind !== "string") return { kind: "not_supported" };

    let payload: unknown;

    if (change.domain === "collaboration") payload = row.original;
    else {
      if (typeof row.payloadJson !== "string") return { kind: "not_supported" };
      try { payload = JSON.parse(row.payloadJson); } catch { return { kind: "missing" }; }
    }

    if (!jsonValue(payload)) return { kind: "missing" };

    const current = canonicalJson(payload);
    if (serialized !== undefined && current !== serialized) return { kind: "missing" };

    serialized = current;

    if (Array.isArray(row.sourceRefs)) for (const ref of row.sourceRefs) if (typeof ref === "string") sourceRefs.add(ref);

    if (selected === undefined || row.kind < selected.recordKind) selected = { kind: "found", recordKind: row.kind, payload, sourceRefs: [] };
  }

  return selected === undefined ? { kind: "missing" } : { ...selected, sourceRefs: [...sourceRefs].sort() };
}

/** Shared host composition: original domain owners interpret their own history. */
export function projectOrganizationDomainFeedback(board: BoardState, input: {
  readonly scope: string; readonly workspaceId: string; readonly issueId: string;
  readonly nativeChanges?: readonly ContentDomainFeedbackChange[];
}) {
  const issue = board.learningIssues?.find(row => row.issueId === input.issueId
    && (row.scope === input.scope || row.scope === input.workspaceId));
  if (issue === undefined) return undefined;

  const selected = { scope: issue.scope, issueId: input.issueId,
    ...(input.nativeChanges === undefined ? {} : { nativeChanges: input.nativeChanges.filter(row => row.issueId === issue.issueId) }) };
  const tool = { ...selected, scope: input.workspaceId, centralScope: issue.scope };

  switch (learningIssueOwner(issue)) {
    case "method": return methodCentralFeedbackFromBoard(board, selected);
    case "tool": return toolCentralFeedbackFromBoard(board, tool);
    case "workflow": return projectWorkflowCentralFeedback(board, selected);
    case "collaboration": return projectCollaborationCentralFeedback(board, selected);
    case "skill": return skillLifecycleProjection(board, issue.scope, input.issueId);
    default: return undefined;
  }
}
