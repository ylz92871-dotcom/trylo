import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { readRewardV2BoardWriteOutcome, type RewardV2BoardPort } from "../reward/v2-board-port.js";

/** One owner instance stops after an unproved write. Reading its original Board
 * can prove a complete lost acknowledgement; it cannot justify a second send. */
export function createCentralAdvisoryWriter(options: { readonly boardRoot: string; readonly board: RewardV2BoardPort;
  readonly check: (signal: AbortSignal) => void }) {
  let suspended = false;
  return {
    async load(signal: AbortSignal): Promise<BoardState> {
      options.check(signal);
      if (suspended) throw new Error("central_advisory_write_requires_inspection");
      const loaded = await createBoardReader(options.boardRoot).load();
      options.check(signal);
      if (!loaded.ok) throw new Error(loaded.reason);
      return loaded.state;
    },

    suspend(): never {
      suspended = true;
      throw new Error("central_advisory_write_requires_inspection");
    },

    async save(revision: number, drafts: readonly RewardV2Draft[], signal: AbortSignal): Promise<"written" | "stale"> {
      options.check(signal);

      if (suspended) throw new Error("central_advisory_write_requires_inspection");

      if (options.board.appendBatch === undefined) throw new Error("central_advisory_batch_required");

      try {
        const result = await options.board.appendBatch(revision, drafts, signal);
        return result.status;
      } catch (error) {
        if (readRewardV2BoardWriteOutcome(error) === "not_started") throw error;

        // Even cancellation cannot reinterpret an entered callback as unwritten.
        // Only an exact full readback permits normal operation after this send.
        try {
          const snapshot = await options.board.read();
          const loaded = await createBoardReader(options.boardRoot).load();
          const same = loaded.ok && loaded.state.sequence >= snapshot.revision
            && canonicalJson((loaded.state.rewardV2Facts ?? []).filter(row => row.sequence <= snapshot.revision)) === canonicalJson(snapshot.facts)
            && drafts.every(draft => {
              const a = snapshot.facts.find(row => row.id === draft.id);
              const b = loaded.state.rewardV2Facts?.find(row => row.id === draft.id);
              return a !== undefined && b !== undefined && a.sequence === b.sequence
                && [a, b].every(row => row.scope === draft.scope && row.algorithmVersion === draft.algorithmVersion
                  && row.kind === draft.kind && row.payloadJson === draft.payloadJson);
            });
          if (same) return "written";
        } catch { /* Read failure cannot prove the original write's outcome. */ }

        suspended = true;
        throw new Error("central_advisory_write_requires_inspection");
      }
    },
  };
}
