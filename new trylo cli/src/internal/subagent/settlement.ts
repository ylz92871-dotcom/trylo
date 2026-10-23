import type { TimerScheduler } from "./scheduler.js";

/** A bounded, cancellable observation; it never cancels the work being observed. */
export async function observeSettlement(
  subscribe: (listener: () => void) => () => void, timeoutMs: number, signal: AbortSignal, scheduler: TimerScheduler,
): Promise<"ready" | "timeout" | "cancelled"> {
  if (signal.aborted) return "cancelled";
  let cancel!: () => void;
  let expire!: () => void;
  let finish!: () => void;
  const ready = new Promise<"ready">(resolve => { finish = () => { resolve("ready"); }; });
  const detach = subscribe(finish);
  const cancelled = new Promise<"cancelled">(resolve => { cancel = () => { resolve("cancelled"); }; });
  const timeout = new Promise<"timeout">(resolve => { expire = () => { resolve("timeout"); }; });
  const timer = scheduler(timeoutMs, expire);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    return await Promise.race([ready, timeout, cancelled]);
  } finally {
    timer.cancel();
    signal.removeEventListener("abort", cancel);
    detach();
  }
}
