import type { RuntimeIntent } from "./files.js";

/** Restart retains the original unconsumed notification. Recovery is needed
 * only when there is no pending notification to drain. */
export function pendingRuntimeWake(intent: Pick<RuntimeIntent, "wakeSequence" | "consumedSequence" | "wakeReason" | "sourceRefs"> | undefined) {
  return intent !== undefined && intent.wakeSequence > intent.consumedSequence
    ? { wakeReason: intent.wakeReason, sourceRefs: [...intent.sourceRefs] } : undefined;
}
