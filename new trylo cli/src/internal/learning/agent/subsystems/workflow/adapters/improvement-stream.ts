import type { ProviderEvent } from "../../../../../ports/provider.js";

/** A non-cooperative provider cannot hold the worker past cancellation.
 * The outstanding read has a rejection handler and loses all commit authority;
 * its budget is settled as unknown before the worker returns. */
export async function nextWorkflowImprovementEvent(iterator: AsyncIterator<ProviderEvent>, signal: AbortSignal): Promise<IteratorResult<ProviderEvent> | "aborted"> {
  if (signal.aborted) return "aborted";
  return new Promise((resolve, reject) => {
    let pending = true;
    const abort = () => {
      if (!pending) return;
      pending = false;
      signal.removeEventListener("abort", abort);
      resolve("aborted");
    };

    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(result => {
      if (!pending) return;
      pending = false;
      signal.removeEventListener("abort", abort);
      resolve(result);
    }, error => {
      if (!pending) return;
      pending = false;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
