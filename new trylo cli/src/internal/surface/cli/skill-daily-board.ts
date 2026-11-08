import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { fail } from "../../learning/control/result.js";

/** Model/CLI trials never own the global writer lock. Each mutation re-enters Board. */
export function skillDailyBoard(root: string): BoardStore {
  return {
    load: () => createBoardReader(root).load(),

    async apply(command) {
      return withBoardWriter(root, async store => {
        if (command.type === "enter_shadow") {
          const loaded = await store.load();
          if (!loaded.ok) return loaded;

          const state = loaded.state;
          if (state.tombstones.some(item => item.entityId === command.proposalId || item.entityId === command.versionId)) {
            return fail(state, "tombstone_exists", command.versionId);
          }

          const asset = state.assets.find(item => item.versionId === command.versionId);
          const current = state.activations.find(item => item.scope === asset?.scope && item.assetKind === "skill");
          if (current !== undefined && current.versionId !== command.versionId && current.versionId !== asset?.parentVersionId) {
            return fail(state, "activation_cas_mismatch", command.versionId);
          }
        }
        return store.apply(command);
      });
    },

    snapshot: generation => withBoardWriter(root, store => store.snapshot(generation)),
    compact: generation => withBoardWriter(root, store => store.compact(generation)),
    close: async () => {},
  };
}
