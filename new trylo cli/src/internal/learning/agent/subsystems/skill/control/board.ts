import { contentHashOf } from "../../../../control/hash.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import type { BoardState } from "../../../../control/state.js";
import type { SkillControlResult, SkillCoordinationOptions } from "./contracts.js";

/** Commands and replay remain owned by the canonical Board, never a local ledger. */
export function skillBoardAccess(options: SkillCoordinationOptions) {
  const enabled = () => options.enabled?.() !== false;
  return {
    enabled,
    async load(): Promise<SkillControlResult<{ readonly state: BoardState }>> {
      if (!enabled()) return { ok: false, reason: "collect_disabled" };
      try {
        const result = await options.board.load();
        if (!enabled()) return { ok: false, reason: "collect_disabled" };
        return result.ok ? { ok: true, state: result.state } : { ok: false, reason: result.reason };
      } catch { return { ok: false, reason: "board_unavailable" }; }
    },
    async send(action: CoordinationAction, accounting = false): Promise<SkillControlResult<{ readonly state: BoardState; readonly duplicate: boolean }>> {
      if (!accounting && !enabled()) return { ok: false, reason: "collect_disabled" };
      try {
        const result = await options.board.apply({ type: "coordinate_learning", commandId: `skill-control:${contentHashOf(action)}`,
          issuedAt: options.now(), action });
        return result.ok ? { ok: true, state: result.state, duplicate: result.idempotent } : { ok: false, reason: result.reason };
      } catch { return { ok: false, reason: "board_unavailable" }; }
    },
  };
}

export type SkillBoardAccess = ReturnType<typeof skillBoardAccess>;
