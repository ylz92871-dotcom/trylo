import type {
  CompactionDecision,
  CompactionProbe,
} from "../ports/compaction.js";

/**
 * When the context budget is spent.
 *
 * One basis, declared and used everywhere: estimated prompt tokens against a
 * configured limit. Message-count is deliberately *not* a second switch — two
 * ways to trip the same decision need a precedence rule nobody wrote down.
 *
 * The soft threshold is inclusive at 90% of the declared window. The loop
 * keeps the hard request ceiling separate and never guesses an unknown window.
 *
 * Nothing here reads a clock, a disk or a provider. The estimate arrives
 * already computed, so this stays a comparison a test can drive from both
 * sides of the boundary — including the trigger side.
 */

/** Same 90% window trigger as the reference model metadata. The remaining
 * headroom lets compaction run before the separately enforced hard ceiling.
 */
export function autoCompactTokenLimit(contextTokenLimit: number): number {
  return Math.floor(contextTokenLimit * 9 / 10);
}

export function shouldCompact(probe: CompactionProbe): CompactionDecision {
  if (probe.view.items.length === 0) {
    // Compressing emptiness would produce a window that replaces nothing, and
    // an empty window is indistinguishable from a corrupted one downstream.
    return { outcome: "hold", reason: "nothing_to_compact" };
  }

  if (probe.estimatedPromptTokens >= autoCompactTokenLimit(probe.contextTokenLimit)) {
    return { outcome: "compact", reason: "estimated_tokens_reached_limit" };
  }

  return { outcome: "hold", reason: "within_limit" };
}
