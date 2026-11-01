import type { RecordRewardV2FactCommand } from './commands.js';
import type { BoardState } from './state.js';
import { fail,nextSeq,succeed,type ReduceResult } from './result.js';
import { isRewardV2Draft,validRewardV2Prefix } from '../reward/v2-facts.js';

export function applyRewardV2Fact(state: BoardState,command: RecordRewardV2FactCommand): ReduceResult {
  if(!Number.isSafeInteger(command.expectedSequence)||command.expectedSequence!==state.sequence) {
    return fail(state,'reward_v2_stale',command.commandId);
  }
  if(!isRewardV2Draft(command.fact))return fail(state,'invalid_reward',command.commandId);
  const fact={...command.fact,sequence:nextSeq(state)},facts=[...(state.rewardV2Facts??[]),fact];
  if(!validRewardV2Prefix(facts,fact.sequence))return fail(state,'reward_capacity',fact.id);
  return succeed(state,command.commandId,[{type:'reward_v2_fact_recorded',fact,sequence:fact.sequence,
    commandId:command.commandId,occurredAt:command.issuedAt}],{rewardV2Facts:facts});
}
