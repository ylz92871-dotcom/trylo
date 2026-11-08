/**
 * The subagent lifecycle's only clock.
 *
 * Two timers exist in this subsystem: the execution timeout the governance
 * tracker arms, and the observation timeout `SubagentRuntime.wait` arms. Both
 * are created here, so a test can hand the subsystem a scheduler it fires by
 * hand and no lifecycle test has to race real time to prove a timeout.
 *
 * `setTimeout` appears once, as this seam's default — the shape the
 * readability discipline allows for ambient sources (WP-CLI-N3: "ID、时钟和
 * 受控调度使用现有注入缝").
 */

export type TimerHandle = {
  /** Idempotent: cancelling an already-fired timer is not an error. */
  readonly cancel: () => void;
};

export type TimerScheduler = (delayMs: number, fire: () => void) => TimerHandle;

/**
 * The shipped scheduler: one `setTimeout`, deliberately *not* `unref`'d.
 *
 * The obvious alternative — unref, so a pending subagent timeout cannot hold a
 * headless process open — breaks the contract this seam exists to provide. Both
 * call sites promise "this resolves after `timeoutMs`", and a timer that cannot
 * keep the event loop alive cannot fire on its own: when the awaited work holds
 * no other handle (a provider stream whose `next()` never settles is exactly
 * that shape), the loop drains, the timer never fires, and the wait hangs
 * forever. That is the one situation the timeout exists for.
 *
 * Holding the process open is not the leak it looks like. Every timer this
 * scheduler hands out is cancelled when its subagent is released or reaches a
 * terminal (`governance.ts`), so a live subagent keeps the process alive — which
 * is correct, it *is* still running — and a finished one leaves nothing behind.
 */
export const systemTimerScheduler: TimerScheduler = (delayMs, fire) => {
  let remaining = delayMs;
  let handle: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const segment = Math.min(remaining, 2_147_483_647);
    remaining -= segment;
    handle = setTimeout(() => { if (remaining > 0) arm(); else fire(); }, segment);
  };

  arm();

  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};
