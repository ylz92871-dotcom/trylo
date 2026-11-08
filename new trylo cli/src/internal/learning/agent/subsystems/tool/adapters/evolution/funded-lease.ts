import { systemTimerScheduler, type TimerHandle, type TimerScheduler } from "../../../../../../subagent/scheduler.js";
import type { createToolLearningFunding } from "../../runtime/learning-funding.js";

/** Heartbeats keep a live request's existing ownership lease alive, including
 * silent reasoning. They impose no execution deadline and never claim again. */
export async function maintainToolFundingLease(funding: ReturnType<typeof createToolLearningFunding>, signal: AbortSignal,
  schedule: TimerScheduler = systemTimerScheduler) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);

  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) abort();

  let stopped = false, timer: TimerHandle | undefined, failure: unknown;
  let pending: Promise<void> = Promise.resolve();
  const renew = async () => {
    if (controller.signal.aborted) return;
    const result = await funding.renew();
    if (!result.ok) throw new Error(`tool_learning_lease:${"code" in result ? result.code : result.reason}`);
  };
  const arm = () => {
    if (stopped || controller.signal.aborted) return;
    timer = schedule(120_000, () => {
      pending = renew().then(arm).catch(error => {
        // The stream observes this terminal failure and settles its original
        // reservation conservatively. No timer exception is left unobserved.
        failure = error;
        controller.abort(error);
      });
    });
  };

  try {
    await renew();
    arm();
  }
  catch (error) {
    signal.removeEventListener("abort", abort);
    throw error;
  }

  return {
    signal: controller.signal,
    assertActive() { if (failure !== undefined) throw failure; },
    async close() {
      stopped = true;
      timer?.cancel();
      signal.removeEventListener("abort", abort);
      await pending;
    },
  };
}
