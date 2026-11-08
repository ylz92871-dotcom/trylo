import type { SubagentRuntime } from "../../../../../subagent/runtime.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";

export const TOOL_LEARNING_RETIREMENT_TIMEOUT_MS = 5_000;

type WorkerLifetime = Pick<SubagentRuntime, "getActiveInstances" | "cancelAll" | "waitForRetirement">;

/** Cancellation reports a terminal before the provider's finally has settled
 * its reservation. Observe actual governance-slot retirement before releasing
 * funding or writing the next learning outcome; never infer it from status. */
export async function retireToolLearningWorkers(runtime: WorkerLifetime, options: {
  readonly timeoutMs?: number; readonly deadline?: AbortSignal;
} = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? TOOL_LEARNING_RETIREMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TOOL_LEARNING_RETIREMENT_TIMEOUT_MS) {
    throw new ToolLearningServiceError("tool_session_retirement_options_invalid");
  }

  const before = runtime.getActiveInstances();
  if (before.length === 0) return;

  // A common deadline bounds the whole close, rather than N sequential waits.
  // The optional signal is the deterministic clock seam for controlled tests.
  const deadline = options.deadline ?? AbortSignal.timeout(timeoutMs);

  try {
    await runtime.cancelAll("tool_session_retirement");
    const ids = [...new Set([...before, ...runtime.getActiveInstances()])];
    const outcomes = await Promise.all(ids.map(id => runtime.waitForRetirement(id, timeoutMs, deadline)));
    if (outcomes.some(outcome => outcome !== "ready") || runtime.getActiveInstances().length !== 0) {
      throw new ToolLearningServiceError("tool_session_retirement_unconfirmed");
    }
  } catch (error) {
    if (error instanceof ToolLearningServiceError) throw error;
    throw new ToolLearningServiceError("tool_session_retirement_unconfirmed");
  }
}
