import type { BoardState } from "./state.js";
import type { RewardRecords } from "../reward/contracts.js";

/** One legacy-default adapter for both projection and persistence. */
export function rewardRecordsOf(state: BoardState): RewardRecords {
  return { exposures: state.rewardExposures ?? [], feedbacks: state.rewardFeedbacks ?? [] };
}
