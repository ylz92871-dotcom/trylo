import { systemTimerScheduler, type TimerHandle, type TimerScheduler } from "./scheduler.js";

export const OPTIONAL_OBSERVER_TIMEOUT_MS = 2_000;

export type OptionalObserverResult<T> = { readonly kind: "value"; readonly value: T }
  | { readonly kind: "failed" | "cancelled" };

/** Optional IO cannot withhold execution. Late settlement retains no execution authority. */
export async function observeOptional<T>(operation: () => Promise<T>,
  scheduler: TimerScheduler = systemTimerScheduler, signal?: AbortSignal): Promise<OptionalObserverResult<T>> {
  if (signal?.aborted) return { kind: "cancelled" };

  let timer: TimerHandle | undefined;
  let detach = () => {};

  try {
    const stopped = new Promise<OptionalObserverResult<T>>(resolve => {
      timer = scheduler(OPTIONAL_OBSERVER_TIMEOUT_MS, () => { resolve({ kind: "failed" }); });
      if (signal !== undefined) {
        const abort = () => { resolve({ kind: "cancelled" }); };
        signal.addEventListener("abort", abort, { once: true });
        detach = () => { signal.removeEventListener("abort", abort); };
        if (signal.aborted) abort();
      }
    });
    // Keep rejection handling attached after the deadline: late observer IO
    // may settle its own evidence, but cannot revive or reject this execution.
    const completed = Promise.resolve().then(operation).then<OptionalObserverResult<T>, OptionalObserverResult<T>>(
      value => ({ kind: "value", value }), () => ({ kind: "failed" }));

    return await Promise.race([completed, stopped]);
  } catch { return { kind: "failed" }; }
  finally {
    timer?.cancel();
    detach();
  }
}
