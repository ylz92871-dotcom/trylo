import { createBoardReader,withBoardWriter } from '../../adapters/learning-store/file-event-store.js';
import type { RewardV2Draft,RewardV2Fact } from '../../learning/reward/v2-facts.js';
import { isReasonCode,type ReasonCode } from '../../learning/control/reasons.js';

export interface RewardV2BoardSnapshot { readonly revision: number; readonly facts: readonly RewardV2Fact[] }

export type RewardV2BoardWriteOutcome = 'not_started' | 'unknown';

export class RewardV2BoardError extends Error {
  constructor(readonly reason: ReasonCode, readonly writeOutcome: RewardV2BoardWriteOutcome = 'unknown') {
    super(reason);
    this.name='RewardV2BoardError';
  }
}

/** Closed diagnostic fields only. Never forward I/O detail or arbitrary exception text. */
export function readRewardV2BoardReason(value: unknown): ReasonCode | undefined {
  return value instanceof RewardV2BoardError && isReasonCode(value.reason) ? value.reason : undefined;
}

/** Only the original port can prove that its writer callback was never entered. */
export function readRewardV2BoardWriteOutcome(value: unknown): RewardV2BoardWriteOutcome {
  return value instanceof RewardV2BoardError && value.writeOutcome === 'not_started' ? 'not_started' : 'unknown';
}

type AppendResult = { readonly status: 'stale' } | { readonly status: 'written'; readonly revision: number; readonly idempotent: boolean };

export interface RewardV2BoardPort {
  read(): Promise<RewardV2BoardSnapshot>;
  append(expectedRevision: number, fact: RewardV2Draft, signal?: AbortSignal): Promise<AppendResult>;
  /** Optional for existing injected ports. One admission, original commands, manifest last. Not an atomic transaction. */
  appendBatch?(expectedRevision: number, facts: readonly RewardV2Draft[], signal?: AbortSignal): Promise<AppendResult>;
}

/** Uses the existing Board lock/reducer/log. Disabled calls perform no filesystem access. */
export function createRewardV2BoardPort(root: string,enabled: ()=>boolean): RewardV2BoardPort {
  async function appendFacts(expectedRevision: number, facts: readonly RewardV2Draft[], signal?: AbortSignal): Promise<AppendResult> {
    if (!enabled()) throw new RewardV2BoardError('collect_disabled', 'not_started');

    if (signal?.aborted) throw new RewardV2BoardError('learning_aborted', 'not_started');

    let entered = false;
    const canEnter = () => enabled() && signal?.aborted !== true;
    const outcome = await withBoardWriter(root, async store => {
      entered = true;
      const loaded = await store.load();
      if (!loaded.ok) return { status: 'rejected' as const, reason: loaded.reason };

      let state = loaded.state, revision = expectedRevision, idempotent = true;

      for (const fact of facts) {
        if (!canEnter()) return { status: 'rejected' as const, reason: signal?.aborted ? 'learning_aborted' as const : 'collect_disabled' as const };

        const existing = state.rewardV2Facts?.find(row => row.id === fact.id);
        // The reducer still checks exact command/fact identity on idempotent replay.
        const originalSequence = existing === undefined ? revision : existing.sequence - 1;
        const result = await store.apply({ type: 'record_reward_v2_fact', commandId: `rw2:${fact.id}`,
          issuedAt: fact.id, expectedSequence: originalSequence, fact });
        if (!result.ok) return result.reason === 'reward_v2_stale' ? { status: 'stale' as const }
          : { status: 'rejected' as const, reason: result.reason };

        state = result.state;
        revision = state.sequence;
        idempotent = idempotent && result.idempotent;
      }

      return { status: 'written' as const, revision, idempotent };
    }, { admission: { canEnter: enabled, ...(signal === undefined ? {} : { signal }) }, commandGuard: canEnter });
    const writeOutcome = entered ? 'unknown' : 'not_started';

    if ('ok' in outcome) throw new RewardV2BoardError(outcome.reason, writeOutcome);

    if (outcome.status === 'rejected') throw new RewardV2BoardError(outcome.reason, writeOutcome);

    return outcome;
  }
  return Object.freeze({
    async read(): Promise<RewardV2BoardSnapshot> {
      if(!enabled())throw new RewardV2BoardError('collect_disabled');
      const read=await createBoardReader(root).load();
      if(!read.ok)throw new RewardV2BoardError(read.reason);
      return {revision:read.state.sequence,facts:read.state.rewardV2Facts??[]};
    },

    append: (expectedRevision: number, fact: RewardV2Draft, signal?: AbortSignal) => appendFacts(expectedRevision, [fact], signal),
    appendBatch: appendFacts,
  });
}
