import { createBoardReader } from "../adapters/learning-store/file-event-store.js";
import { emptyBoardState } from "../learning/control/state.js";
import {
  assembleDegraded,
  assembleFromState,
  type AssembledLearningContext,
  type TurnInput,
} from "../learning/profile/assemble.js";
import { loadLastKnownGood, saveLastKnownGood } from "./lkg.js";
import { boardFilesExist, ensureMigrated, type FragmentStore } from "./store.js";
import type { ProfilePort } from "../contract/profile.js";

export type LearningContextReader = {
  assemble(turnInput?: TurnInput): Promise<AssembledLearningContext>;
};

export function bindContextPort(store: FragmentStore): LearningContextReader {
  return {
    async assemble(turnInput: TurnInput = {}) {
      const messages = turnInput.messages ?? [];
      // Load the fallback first so migration or board failures retain a usable profile.
      const lkg = await loadLastKnownGood(store.rootDir);

      if (turnInput.signal?.aborted) {
        return assembleDegraded(
          { messages, signal: turnInput.signal },
          lkg,
          "learning_timeout",
          "assemble aborted",
        );
      }

      try {
        await ensureMigrated(store.rootDir);

        if (boardFilesExist(store.rootDir)) {
          const loaded = await createBoardReader(store.rootDir).load();
          if (!loaded.ok) {
            return assembleDegraded({ messages }, lkg, loaded.reason, loaded.detail);
          }

          const assembled = assembleFromState(loaded.state, { messages });

          try {
            await saveLastKnownGood(store.rootDir, assembled.profileSnapshot);
          } catch (err: unknown) {
            // Cleanup-only failure with a self-healing backstop: the LKG is a
            // cache, this assembly already produced its in-memory result, and
            // the next successful write replaces the file. void, on purpose.
            void err;
          }

          return assembled;
        }

        return assembleFromState(emptyBoardState(), { messages });
      } catch (err) {
        return assembleDegraded(
          { messages },
          lkg,
          "board_unavailable",
          err instanceof Error ? err.message : "assemble failed",
        );
      }
    },
  };
}

export function bindProfilePort(store: FragmentStore): ProfilePort {
  const context = bindContextPort(store);
  return {
    async load() {
      return (await context.assemble()).profileSnapshot;
    },
  };
}
