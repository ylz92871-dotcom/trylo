import type { JsonObject } from "../protocol/envelope.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import { cancelToolSafely, type ToolCancelResult } from "./tool-boundary.js";

export type ToolCancellation = {
  readonly signal: AbortSignal;
  readonly emit: (kind: string, payload: JsonObject) => void;
};

/** Ask the adapter to stop while it still owns the call, then keep its actual result. */
export async function executeWithCancellation(
  tools: ToolPort,
  toolCallId: string,
  execute: () => Promise<ToolOutcome>,
  cancellation: ToolCancellation | undefined,
): Promise<ToolOutcome> {
  if (cancellation === undefined) return execute();
  if (cancellation.signal.aborted) return { outcome: "cancelled" };

  let stopping = false;
  let cancellationReceipt: ToolCancelResult | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // Once execution returns its real outcome, a late Stop receipt has no
    // authority over it. Keep any already-known failure without blocking it.
    void cancelToolSafely(tools, toolCallId).then(receipt => { cancellationReceipt = receipt; });
  };

  // execute enters the adapter synchronously, so its call owner exists before
  // cancel is delivered. The atomic execution signal is deliberately untouched.
  const running = execute();
  cancellation.signal.addEventListener("abort", stop, { once: true });
  if (cancellation.signal.aborted) stop();

  try {
    return await running;
  } finally {
    cancellation.signal.removeEventListener("abort", stop);
    const receipt = cancellationReceipt;
    if (receipt !== undefined && !receipt.ok) {
      cancellation.emit("observation", { component: "tool_cancel", status: "failed", toolCallId, message: receipt.message });
    }
  }
}
