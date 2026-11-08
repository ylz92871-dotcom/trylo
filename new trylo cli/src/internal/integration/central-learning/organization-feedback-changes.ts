import type { BoardState } from "../../learning/control/state.js";
import type { ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { projectMethodCentralFeedbackChanges } from "../../learning/agent/subsystems/method/adapters/central-feedback-changes.js";
import { projectToolCentralFeedbackChanges } from "../../learning/agent/subsystems/tool/runtime/central-feedback-changes.js";
import { projectWorkflowCentralFeedbackChanges } from "../../learning/agent/subsystems/workflow/adapters/central-feedback-changes.js";
import { projectCollaborationCentralFeedbackChanges } from "../../learning/agent/subsystems/collaboration/runtime/central-feedback-changes.js";
import { projectSkillCentralFeedbackChanges } from "../../learning/agent/subsystems/skill/control/central-feedback-changes.js";

/** One Board prefix, five original owners. These entries discover native facts;
 * reading their bodies and deciding whether to reconsider remain separate. */
export function projectOrganizationNativeFeedbackChanges(board: BoardState, input: {
  readonly scope: string; readonly workspaceId: string;
}): readonly ContentDomainFeedbackChange[] {
  const rows = [...projectMethodCentralFeedbackChanges(board, input), ...projectToolCentralFeedbackChanges(board, input),
    ...projectWorkflowCentralFeedbackChanges(board, input), ...projectCollaborationCentralFeedbackChanges(board, input),
    ...projectSkillCentralFeedbackChanges(board, input)];
  const seen = new Set<string>();

  return rows.filter(row => {
    const key = JSON.stringify([row.domain, row.issueId, row.factRef, row.unitRef, row.revisionRef, row.kind]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
