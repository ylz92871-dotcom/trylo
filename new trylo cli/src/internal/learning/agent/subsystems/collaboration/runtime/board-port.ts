import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { readCollaborationV2Archive } from "../../../../../adapters/learning-store/collaboration-archive.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import type { BoardCommand } from "../../../../control/commands.js";

/** Withdrawing collection does not refund already-reserved model quota. */
function terminalAccounting(command: BoardCommand): boolean {
  if (command.type === "coordinate_learning") return command.action.kind === "settle"
    || command.action.kind === "finish" && command.action.result.kind === "cancelled";
  return command.type === "record_collaboration_v2" && command.fact.kind === "cycle"
    && (command.fact.phase === "cancelled" || command.fact.phase === "failed") && command.expectedCycleFactId !== undefined;
}

/** The existing Board owns locking, append, replay and snapshots for this domain too. */
export function createFileCollaborationBoard(root: string, enabled: () => boolean = () => true): CollaborationBoardPort {
  const disabled = () => ({ ok: false as const, reason: "collect_disabled" as const, detail: "Collaboration collection is disabled" });
  let writer = Promise.resolve();
  let pending = 0;

  return {
    async load() {
      return enabled() ? createBoardReader(root).load() : disabled();
    },
    async readArchive(query) {
      return enabled() ? readCollaborationV2Archive(root, query) : disabled();
    },
    async apply(command, signal) {
      // Final accounting retains its original cancellation/collection exception.
      const activeSignal = terminalAccounting(command) ? undefined : signal;
      const aborted = () => ({ ok: false as const, reason: "learning_aborted" as const, detail: "Collaboration write was cancelled before commit" });
      const admitted = () => enabled() || terminalAccounting(command);

      if (activeSignal?.aborted) return aborted();

      if (!admitted()) return disabled();

      if (pending >= 128) return { ok: false, reason: "board_unavailable", detail: "Collaboration write queue is full" };

      pending += 1;
      const previous = writer;
      let release!: () => void;

      writer = new Promise<void>(resolve => { release = resolve; });
      await previous;

      try {
        if (activeSignal?.aborted) return aborted();

        if (!admitted()) return disabled();

        const result = await withBoardWriter(root, async store => activeSignal?.aborted ? aborted()
          : admitted() ? store.apply(command) : disabled(), {
          admission: { canEnter: admitted, ...(activeSignal === undefined ? {} : { signal: activeSignal }) },
          commandGuard: () => admitted() && activeSignal?.aborted !== true,
        });

        return !result.ok && result.reason === "collect_disabled" && activeSignal?.aborted ? aborted() : result;
      } finally {
        pending -= 1;
        release();
      }
    },
  };
}
