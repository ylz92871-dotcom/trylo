import { createBoardReader,withBoardWriter } from '../../adapters/learning-store/file-event-store.js';
import type { RewardV2Draft,RewardV2Fact } from '../../learning/reward/v2-facts.js';
export interface RewardV2BoardSnapshot { readonly revision: number; readonly facts: readonly RewardV2Fact[] }

/** Uses the existing Board lock/reducer/log. Disabled calls perform no filesystem access. */
export function createRewardV2BoardPort(root: string,enabled: ()=>boolean) {
  return Object.freeze({
    async read(): Promise<RewardV2BoardSnapshot> {
      if(!enabled())throw new Error('collect_disabled');
      const read=await createBoardReader(root).load();
      if(!read.ok)throw new Error(read.reason);
      return {revision:read.state.sequence,facts:read.state.rewardV2Facts??[]};
    },
    async append(expectedRevision: number,fact: RewardV2Draft) {
      if(!enabled())throw new Error('collect_disabled');
      const outcome=await withBoardWriter(root,async store=>{
        if(!enabled())throw new Error('collect_disabled');
        const loaded=await store.load();
        if(!loaded.ok)return {status:'rejected' as const,reason:loaded.reason};
        if(!enabled())return {status:'rejected' as const,reason:'collect_disabled'};
        const existing=loaded.state.rewardV2Facts?.find(row=>row.id===fact.id);
        // CAS is a first-write precondition. Reconstruct its original value on retry;
        // the reducer must still prove command identity and the complete fact payload.
        const originalSequence=existing===undefined?expectedRevision:existing.sequence-1;
        const result=await store.apply({type:'record_reward_v2_fact',commandId:`rw2:${fact.id}`,
          issuedAt:fact.id,expectedSequence:originalSequence,fact});
        if(!result.ok) {
          if(result.reason==='reward_v2_stale')return {status:'stale' as const};
          return {status:'rejected' as const,reason:result.reason};
        }
        return {status:'written' as const,revision:result.state.sequence,idempotent:result.idempotent};
      });
      // withBoardWriter returns typed I/O failures; unwrap once at this promise-style port boundary.
      if('ok' in outcome)throw new Error(outcome.reason);
      if(outcome.status==='rejected')throw new Error(outcome.reason);
      return outcome;
    },
  });
}
