import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationBoardPort, CollaborationFailure } from "./contracts.js";
import type { CollaborationArchiveQueryV2 } from "./v2-contracts.js";
import type { BoardState } from "../../../../control/state.js";

/** Restore only already-applied canonical commands. This never replays their execution or authorizes a new fact. */
export async function hydrateCollaborationArchiveV2(input: { readonly board: CollaborationBoardPort; readonly now: () => string;
  readonly query: CollaborationArchiveQueryV2; readonly canContinue?: () => boolean }): Promise<{ readonly ok: true; readonly state: BoardState } | CollaborationFailure> {
  try {
    if (input.canContinue?.() === false) return { ok: false, reason: "collect_disabled" };

    const loaded = await input.board.load();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };

    if (input.canContinue?.() === false) return { ok: false, reason: "collect_disabled" };

    if (!loaded.state.collaborationV2Archives?.some(a => a.scope === input.query.scope)) return { ok: true, state: loaded.state };

    if (input.board.readArchive === undefined) return { ok: false, reason: "archive_lookup_unavailable" };

    const historical = await input.board.readArchive(input.query);
    if (!historical.ok) return historical;

    if (input.canContinue?.() === false) return { ok: false, reason: "collect_disabled" };

    const present = new Set(loaded.state.collaborationV2Facts?.map(f => f.factId) ?? []);
    if (historical.records.every(r => present.has(r.fact.factId))) return { ok: true, state: loaded.state };

    const commandId = `collaboration-hydrate:${contentHashOf({ scope: input.query.scope, records: historical.records })}`;
    const result = await input.board.apply({ type: "rehydrate_collaboration_v2", commandId, issuedAt: input.now(),
      scope: input.query.scope, records: historical.records });

    return result.ok ? { ok: true, state: result.state } : { ok: false, reason: result.reason };
  } catch { return { ok: false, reason: "archive_unavailable" }; }
}
