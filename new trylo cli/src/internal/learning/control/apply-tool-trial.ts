import type { BoardCommand } from "./commands.js";
import type { BoardState } from "./state.js";
import { contentHashOf } from "./hash.js";
import { fail, nextSeq, succeed, replay, type ReduceResult } from "./result.js";
import { decodeToolTrialRecord, MAX_TOOL_TRIALS, toolTrialKey } from "../domains/tool/evolution/trial.js";
import { decodeToolEvolutionArtifact, isToolEvolutionVersionId } from "../domains/tool/evolution/artifact.js";
import { recordOf } from "../domains/tool/evolution/parse.js";

export function applyToolTrial(state: BoardState, command: Extract<BoardCommand, { type: "record_tool_trial" }>): ReduceResult {
  const record = decodeToolTrialRecord(command.record);
  if (record === undefined) return fail(state, "invalid_tool_trial", "trial payload is malformed");
  const existing = (state.toolTrials ?? []).find(item => toolTrialKey(item) === toolTrialKey(record));
  if (existing !== undefined) return contentHashOf(existing) === contentHashOf(record)
    ? replay(state) : fail(state, "tool_trial_conflict", record.trialId);
  if ((state.toolTrials?.length ?? 0) >= MAX_TOOL_TRIALS) return fail(state, "tool_trial_capacity", record.trialId);
  const asset = state.assets.find(item => item.versionId === record.versionId);
  if (asset === undefined) return fail(state, "asset_not_found", record.versionId);
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  if (proposal === undefined) return fail(state, "proposal_not_found", record.versionId);
  if (state.tombstones.some(item => item.entityId === record.versionId || item.entityId === proposal.proposalId)
    || ["rejected", "suspended", "rolled_back", "retired"].includes(proposal.lifecycle)) return fail(state, "invalid_tool_trial", "candidate is unavailable");
  const content = asset.content;
  if (asset.kind !== "tool_package" || !recordOf(content) || content.type !== "tool_evolution_candidate") return fail(state, "invalid_tool_trial", "trial subject is not an evolution candidate");
  const { type: _type, ...body } = content;
  const artifact = decodeToolEvolutionArtifact(body);
  if (artifact === undefined || !isToolEvolutionVersionId(record.versionId, artifact) || asset.contentHash !== contentHashOf(content)
    || record.scope !== asset.scope || record.scope !== artifact.request.scope
    || record.verification.candidateHash !== artifact.verification.candidateHash) return fail(state, "invalid_tool_trial", "trial does not bind the archived candidate");
  return succeed(state, command.commandId, [{ type: "tool_trial_recorded", commandId: command.commandId,
    sequence: nextSeq(state), occurredAt: command.issuedAt, record }], { toolTrials: [...(state.toolTrials ?? []), record] });
}
