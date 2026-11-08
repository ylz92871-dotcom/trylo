import type { BoardState } from "../../learning/control/state.js";
import type { FrozenCentralStage } from "./stage-evidence.js";

/** The original owner must identify its confirmed, still unexecuted internal
 * cursor against the exact preceding assignment. No progress count implies it.
 */
export interface CentralResearchContinuationInput {
  readonly board: BoardState; readonly scope: string; readonly issueId: string;
  readonly grantId: string; readonly programRef: string; readonly lastStage: FrozenCentralStage;
}

export type CentralResearchContinuation = { readonly kind: "continuable"; readonly cursorRef: string; readonly sourceRefs: readonly string[] }
  | { readonly kind: "waiting" | "terminal" | "inspection"; readonly reason: string; readonly sourceRefs: readonly string[] };

export type CentralResearchContinuationReader = (input: CentralResearchContinuationInput, signal: AbortSignal) =>
  CentralResearchContinuation | Promise<CentralResearchContinuation>;
