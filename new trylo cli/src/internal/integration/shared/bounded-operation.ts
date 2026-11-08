/** Bounds observation time and propagates cancellation; it cannot prove the underlying work stopped. */
export async function boundedOperation<T>(signal: AbortSignal, timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>, stoppedReason: string): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort();

  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();

  let timer: ReturnType<typeof setTimeout> | undefined, rejectAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error(stoppedReason));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    timer = setTimeout(abort, timeoutMs);
    if (controller.signal.aborted) rejectAbort();
  });

  try {
    // The callback must not begin new work when the caller cancelled before admission.
    const work = controller.signal.aborted ? stopped : operation(controller.signal);
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (rejectAbort !== undefined) controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}
