import type { CentralResearchContinuationReader } from "../../integration/central-learning/research-intake-continuation.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { readCentralMethodResearchContinuation } from "../../learning/agent/subsystems/method/adapters/central-research-continuation.js";
import { readWorkflowCentralResearchContinuation } from "../../learning/agent/subsystems/workflow/adapters/central-research-continuation.js";
import { readCollaborationResearchContinuation } from "../../learning/agent/subsystems/collaboration/runtime/central-research-continuation.js";
import { readToolCentralContinuation } from "../../learning/agent/subsystems/tool/runtime/central-research-continuation.js";

/** The host routes the verified original assignment to its native reader. The
 * original owner alone determines whether a new internal cursor exists. */
export function createCentralRuntimeResearchContinuation(workspaceId: string): CentralResearchContinuationReader {
  return (input, signal) => {
    const sourceRefs = [input.issueId, input.grantId, input.lastStage.unitId];

    if (signal.aborted) return { kind: "waiting", reason: "central_research_continuation_cancelled", sourceRefs };

    const issue = input.board.learningIssues?.find(row => row.scope === input.scope && row.issueId === input.issueId);
    if (issue === undefined) return { kind: "inspection", reason: "central_research_continuation_source_missing", sourceRefs };

    const previousCursorRefs = input.lastStage.candidate.source.domainStage.readiness.evidenceRefs;

    switch (learningIssueOwner(issue)) {
      case "method": return readCentralMethodResearchContinuation({ board: input.board, scope: input.scope,
        issueId: input.issueId, grantId: input.grantId, lastStageInputHash: contentHashOf(input.lastStage.input), previousCursorRefs });
      case "workflow": return readWorkflowCentralResearchContinuation({ board: input.board, scope: input.scope,
        issueId: input.issueId, grantId: input.grantId, lastStageCommittedAtSequence: input.lastStage.committedAtSequence, previousCursorRefs });
      case "collaboration": return readCollaborationResearchContinuation(input, signal);
      // This independent owner has the same background mode and no foreground
      // execution allowance as createCentralRuntimeTool.
      case "tool": return readToolCentralContinuation(input, { workspaceId, mode: "after_turn", executionAuthorized: false });
      case "skill": return { kind: "waiting", reason: "skill_research_requires_original_review_or_new_program", sourceRefs };
      default: return { kind: "inspection", reason: "central_research_original_continuation_reader_required", sourceRefs };
    }
  };
}
