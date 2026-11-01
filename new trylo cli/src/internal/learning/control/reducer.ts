import { applyRetire, applyResume, applyRollback, applySuspend } from "./apply-activation.js";
import {
  applyActivate,
  applyApprovalDecision,
  applyCommitAsset,
  applyEnterShadow,
  applyRecordEvidence,
} from "./apply-asset.js";
import {
  applyCompleteJob,
  applyEnqueueJob,
  applyFailJob,
  applyStartJob,
  applyRequeueJob,
  applyTombstone,
} from "./apply-job.js";
import {
  applyRecordMethodFeedback,
  applyRecordMethodFielding,
} from "./apply-method-ledger.js";
import {
  applyFastLaneValidate,
  applyRequestApproval,
  applySimpleTransition,
  applySubmit,
} from "./apply-proposal.js";
import type { BoardCommand } from "./commands.js";
import type { BoardEvent } from "./events.js";
import type { ReduceResult } from "./result.js";
import { fail } from "./result.js";
import { wasApplied, type BoardState } from "./state.js";
import { methodPayloadHash, replayMethodCommand } from "./method-replay.js";
import { applySetMethodRetention } from "./apply-method-retention.js";
import { applyRewardExposure, applyRewardFeedback } from "./apply-reward.js";
import { applyToolTrial } from "./apply-tool-trial.js";
import { applyToolUse } from "./apply-tool-use.js";
import { applyRewardV2Fact } from './apply-reward-v2.js';

export function reduce(state: BoardState, command: BoardCommand): ReduceResult {
  if (wasApplied(state, command.commandId)) {
    return replayMethodCommand(state, command);
  }
  const result = reduceNew(state, command);
  const payloadHash = methodPayloadHash(command);
  if (!result.ok || payloadHash === undefined) return result;
  return { ...result, state: { ...result.state, appliedCommands: result.state.appliedCommands.map(item =>
    item.commandId === command.commandId ? { ...item, payloadHash } : item) } };
}

function reduceNew(state: BoardState, command: BoardCommand): ReduceResult {
  switch (command.type) {
    case "record_tool_use":
      return applyToolUse(state, command);
    case 'record_reward_v2_fact':
      return applyRewardV2Fact(state,command);
    case "record_tool_trial":
      return applyToolTrial(state, command);
    case "record_reward_exposure":
      return applyRewardExposure(state, command);
    case "record_reward_feedback":
      return applyRewardFeedback(state, command);
    case "submit_proposal":
      return applySubmit(state, command);
    case "quarantine":
    case "start_evaluation":
    case "reject":
      return applySimpleTransition(state, command);
    case "fast_lane_validate":
      return applyFastLaneValidate(state, command);
    case "request_approval":
      return applyRequestApproval(state, command);
    case "record_evidence":
      return applyRecordEvidence(state, command);
    case "commit_asset":
      return applyCommitAsset(state, command);
    case "enter_shadow":
      return applyEnterShadow(state, command);
    case "activate":
      return applyActivate(state, command);
    case "record_approval_decision":
      return applyApprovalDecision(state, command);
    case "suspend":
      return applySuspend(state, command);
    case "resume":
      return applyResume(state, command);
    case "rollback":
      return applyRollback(state, command);
    case "retire":
      return applyRetire(state, command);
    case "enqueue_job":
      return applyEnqueueJob(state, command);
    case "start_job":
      return applyStartJob(state, command);
    case "requeue_job":
      return applyRequeueJob(state, command);
    case "complete_job":
      return applyCompleteJob(state, command);
    case "fail_job":
      return applyFailJob(state, command);
    case "tombstone":
      return applyTombstone(state, command);
    case "record_method_fielding":
      return applyRecordMethodFielding(state, command);
    case "record_method_feedback":
      return applyRecordMethodFeedback(state, command);
    case "set_method_retention":
      return applySetMethodRetention(state, command);
    default: {
      const _never: never = command;
      return fail(state, "unknown_command", JSON.stringify(_never));
    }
  }
}

export function reduceAll(
  state: BoardState,
  commands: ReadonlyArray<BoardCommand>,
): ReduceResult {
  let current = state;
  const events: BoardEvent[] = [];
  for (const command of commands) {
    const result = reduce(current, command);
    if (!result.ok) {
      return result;
    }
    current = result.state;
    events.push(...result.events);
  }
  return { ok: true, state: current, events, idempotent: false };
}
