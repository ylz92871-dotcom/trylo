import type { BoardState } from "../../learning/control/state.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimePrefix } from "../../learning/central/runtime/records.js";
import { activePurposeCatalogRef, activePurposeReadRef, createActivePurposeNavigation, createActivePurposeOriginal,
  ownsActivePurposeReadRef, parseActivePurposeReadRef } from "./active-purpose-delivery.js";

export type ActivePurposeSourceRead = { readonly status: "unhandled" } | { readonly status: "missing" }
  | { readonly status: "found"; readonly material: CentralRuntimeMaterial };

/** Addresses select immutable versions in the original scope's verified chain.
 * An archived material with a matching name is not proof of an original purpose;
 * historical readability also confers no right to revise the current purpose. */
export function createActivePurposeSourceReader(board: BoardState, scope: string): (ref: string) => ActivePurposeSourceRead {
  let snapshots: ReturnType<typeof readCentralRuntimePrefix> | undefined;
  return ref => {
    if (!ownsActivePurposeReadRef(ref)) return { status: "unhandled" };

    const address = parseActivePurposeReadRef(ref);
    if (address === undefined) return { status: "missing" };

    snapshots ??= readCentralRuntimePrefix(board.rewardV2Facts ?? [], scope, board.sequence).slice().reverse();

    for (const snapshot of snapshots) {
      if (address.kind === "body") {
        for (const intent of snapshot.state.intents) {
          if (intent.continuation.kind === "ended") continue;
          if (activePurposeReadRef(scope, intent) === ref) return { status: "found", material: createActivePurposeOriginal(scope, intent) };
        }
      } else if (activePurposeCatalogRef(scope, snapshot.state.intents, address.offset, address.pageSize) === ref) {
        return { status: "found", material: createActivePurposeNavigation(scope, snapshot.state.intents, address.offset, address.pageSize) };
      }
    }

    return { status: "missing" };
  };
}

/** Compatibility for callers that read one address instead of a source batch. */
export function readActivePurposeSource(board: BoardState, scope: string, ref: string): ActivePurposeSourceRead {
  return createActivePurposeSourceReader(board, scope)(ref);
}
