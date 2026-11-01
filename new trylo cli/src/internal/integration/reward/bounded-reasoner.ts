import type { RewardReasonerPort } from "../../learning/reward/ports.js";

/** Even a faulty reasoner ignoring abort cannot hold the learning host open indefinitely. */
export async function interpretBounded(reasoner: RewardReasonerPort,
  input: Parameters<RewardReasonerPort["interpret"]>[0], timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error("reward_reasoner_stopped"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    timer = setTimeout(abort, timeoutMs);
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return await Promise.race([reasoner.interpret({ ...input, signal: controller.signal }), stopped]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    if (rejectAbort !== undefined) controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}
