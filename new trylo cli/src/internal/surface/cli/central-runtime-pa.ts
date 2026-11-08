import type { CentralRuntimeClient } from "../../adapters/central-learning-runtime/index.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";

/** PA requests/observes independent learning; its business tool call does not become a worker lifetime. */
export async function wakeCentralFromPersonalAgent(client: CentralRuntimeClient | undefined,
  input: { readonly reason: string; readonly sourceRefs: readonly string[] }, signal: AbortSignal): Promise<FocusedLearningDispatch & { readonly central?: unknown }> {
  if (client === undefined) return { ok: false, reason: "central_runtime_unavailable" };
  const result = await client.wake(input, undefined, signal);
  return result.ok ? { ok: true, status: "idle", central: result.snapshot }
    : { ok: false, reason: result.reason };
}
