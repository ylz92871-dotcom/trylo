import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { FileBoardStoreOptions } from "../../adapters/learning-store/file-event-store.js";
import { rewardRecordsOf } from "../../learning/control/reward-records.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { RewardLedgerPort, RewardWrite } from "../../learning/reward/ports.js";

/** Reuses the canonical Board lock, reducer and append log. No second reward ledger. */
export function createRewardBoardPort(root: string, options: FileBoardStoreOptions = {}): RewardLedgerPort {
  let pending: Promise<void> = Promise.resolve();
  async function apply(command: BoardCommand): Promise<RewardWrite> {
    const result = await withBoardWriter(root, async store => {
      const written = await store.apply(command);
      if (written.ok && !written.idempotent && written.state.sequence % 32 === 0) {
        const loaded = await store.load();
        const checkpoint = loaded.ok ? await store.snapshot(loaded.generation) : loaded;
        // The append may already be durable. Report the failure; same-command retries remain idempotent.
        if (!checkpoint.ok) return { ok: false as const, reason: checkpoint.reason };
      }
      return written.ok
        ? { ok: true as const, duplicate: written.idempotent, records: rewardRecordsOf(written.state) }
        : { ok: false as const, reason: written.reason };
    }, options);
    return result;
  }
  function enqueue(command: BoardCommand): Promise<RewardWrite> {
    const run = pending.then(() => apply(command));
    // Only release sequencing on rejection; the original run still delivers that failure to its caller.
    pending = run.then(() => undefined, () => undefined);
    return run;
  }
  return {
    expose: input => enqueue({ type: "record_reward_exposure", commandId: `reward-use:${input.id}`,
      issuedAt: String(input.occurredAt), exposure: input }),
    feedback: input => enqueue({ type: "record_reward_feedback", commandId: `reward-feedback:${input.id}`,
      issuedAt: String(input.observedAt), feedback: input }),
    read: async () => {
      await pending;
      const read = await createBoardReader(root).load();
      return read.ok ? { ok: true, records: rewardRecordsOf(read.state) } : { ok: false, reason: read.reason };
    },
  };
}
