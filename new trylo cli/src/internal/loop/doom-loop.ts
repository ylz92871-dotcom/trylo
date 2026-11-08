import type { PermissionAction } from "../ports/permission.js";

/**
 * Repeat detection.
 *
 * Repetition alone does not revoke a standing user approval. Embeddings may
 * explicitly request reapproval after a threshold; ordinary execution has no
 * implicit threshold. Progress/failure handling remains with the task owner.
 *
 * "Identical" is decided by the fingerprint: same tool, same arguments, same
 * order they were asked in.
 */

export type DoomLoopTracker = {
  /** True when this call must be approved again even if a decision was remembered. */
  observe(action: PermissionAction): boolean;
  consecutive(): number;
  reset(): void;
};

export function createDoomLoopTracker(threshold?: number): DoomLoopTracker {
  let previous: string | undefined;
  let count = 0;

  return {
    observe(action) {
      count = previous === action.pattern ? count + 1 : 1;
      previous = action.pattern;
      return threshold !== undefined && count >= threshold;
    },
    consecutive() {
      return count;
    },
    reset() {
      previous = undefined;
      count = 0;
    },
  };
}
