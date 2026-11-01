import type { RecordRewardExposureCommand, RecordRewardFeedbackCommand } from "./commands.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";
import { predictionsFor, rewardView } from "../reward/algorithm.js";
import { isExposureDraft, isRewardFeedback } from "../reward/validate.js";
import { rewardRecordsOf } from "./reward-records.js";
import { indexRewardRecords } from "../reward/records.js";

export function applyRewardExposure(state: BoardState, command: RecordRewardExposureCommand): ReduceResult {
  const draft = command.exposure;
  if (!isExposureDraft(draft)) return fail(state, "invalid_reward", command.commandId);
  const records = rewardRecordsOf(state);
  const priorFeedbackCount = draft.priorFeedbackCount ?? records.feedbacks.length;
  if (priorFeedbackCount > records.feedbacks.length) return fail(state, "invalid_reward", draft.id);
  const index = indexRewardRecords(records);
  const failure = index === undefined ? "invalid_reward" : index.expose(draft);
  if (failure !== undefined) return fail(state, failure, draft.id);
  const basis = { ...records, feedbacks: records.feedbacks.slice(0, priorFeedbackCount) };
  const exposure = { ...draft, priorFeedbackCount, predictions: predictionsFor(rewardView(basis), draft.context, draft.targets) };
  return succeed(state, command.commandId, [{ type: "reward_exposure_recorded", exposure,
    sequence: nextSeq(state), commandId: command.commandId, occurredAt: command.issuedAt }],
  { rewardExposures: [...records.exposures, exposure] });
}

export function applyRewardFeedback(state: BoardState, command: RecordRewardFeedbackCommand): ReduceResult {
  const feedback = command.feedback;
  if (!isRewardFeedback(feedback)) return fail(state, "invalid_reward", command.commandId);
  const records = rewardRecordsOf(state);
  const index = indexRewardRecords(records);
  const failure = index === undefined ? "invalid_reward" : index.feedback(feedback);
  if (failure !== undefined) return fail(state, failure, feedback.id);
  return succeed(state, command.commandId, [{ type: "reward_feedback_recorded", feedback,
    sequence: nextSeq(state), commandId: command.commandId, occurredAt: command.issuedAt }],
  { rewardFeedbacks: [...records.feedbacks, feedback] });
}
