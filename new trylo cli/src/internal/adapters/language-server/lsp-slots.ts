/**
 * In-flight request bookkeeping — the part that decides what happens to a caller
 * when the server dies mid-answer.
 *
 * The failure this exists to prevent: a language server crashes, its connection
 * closes, and a `sendRequest` promise that nobody settled stays pending forever.
 * The tool call then sits until its own timeout, and the user sees a spinner
 * rather than a server that just died. Every tracked promise is therefore
 * registered here and settled here, so "the server exited" reaches every caller
 * in the same tick.
 */

type Pending = {
  readonly settle: (reason: Error) => void;
};

export class ConnectionSlots {
  private readonly pending = new Set<Pending>();
  private inFlight = 0;

  /** Current load, read by the caller before dispatching. */
  get load(): number {
    return this.inFlight;
  }

  get count(): number {
    return this.pending.size;
  }

  /**
   * Register a request so it can be settled from outside. The returned promise
   * is what the caller awaits; it never rejects on teardown with anything vaguer
   * than the failure passed in.
   */
  track<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    this.inFlight += 1;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { settle: (reason) => reject(reason) };

      this.pending.add(entry);
      const finish = (): void => {
        if (!this.pending.delete(entry)) {
          // Already settled by teardown; the caller's outcome is decided and
          // resolving again would be a no-op at best and a lie at worst.
          return;
        }
        this.inFlight -= 1;
      };

      promise.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );

      if (signal !== undefined) {
        if (signal.aborted) {
          entry.settle(abortError());
          finish();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            if (this.pending.delete(entry)) {
              this.inFlight -= 1;
              entry.settle(abortError());
            }
          },
          { once: true },
        );
      }
    });
  }

  /** Fail everything outstanding. Used on exit and on close. */
  settleAllPending(reason: Error): void {
    const entries = [...this.pending];
    this.pending.clear();
    this.inFlight = 0;
    for (const entry of entries) {
      entry.settle(reason);
    }
  }

  /**
   * Cancel everything outstanding without killing the connection — used when a
   * request times out, so one slow answer does not poison the next.
   */
  releaseAll(): void {
    this.settleAllPending(abortError());
  }
}

function abortError(): Error {
  const error = new Error("request cancelled");
  error.name = "LspCancelled";
  return error;
}
