/**
 * The admission gate for a batch of tool calls (WP22.1 / C05, L03).
 *
 * Source: Codex `codex-rs/core/src/tools/parallel.rs:107-111`. A tool that
 * declares itself parallel-safe takes a **read** lock — several of them hold it
 * at once and genuinely run together. A tool that does not takes a **write**
 * lock, which excludes everything else. One lock therefore expresses both halves
 * of the contract: "independent reads actually run in parallel" and "a write to
 * a shared path is exclusive".
 *
 * Three properties are load-bearing and each is pinned by a test:
 *
 *  - **Fair, i.e. write-preferring.** Waiters are served in arrival order, so a
 *    writer that arrived is never overtaken by a reader that came later. A
 *    reader-friendly lock would let a stream of reads starve one write forever,
 *    and the write is the call whose ordering actually matters.
 *  - **Reads behind a waiting write do not jump the queue.** A read may enter
 *    only while no writer is waiting ahead of it — this is the same rule as
 *    above, seen from the reader's side.
 *  - **Release is idempotent.** A worker that releases twice (a `finally` plus
 *    an explicit call, say) must not hand the lock to a second caller.
 */

/** Frees one acquired lock. Calling it more than once frees it only once. */
export type GateRelease = () => void;

export type ParallelGate = {
  /** Shared: several readers hold it at once. */
  read(): Promise<GateRelease>;
  /** Exclusive: held alone, and waits for every reader to let go. */
  write(): Promise<GateRelease>;
};

type Waiter = {
  readonly kind: "read" | "write";
  readonly admit: () => void;
};

/**
 * One gate per batch of calls, not one per process: what needs arbitrating is
 * the overlap between calls the same response asked for, and a lock that
 * outlived the turn would silently serialise work in later turns too.
 */
export function createParallelGate(): ParallelGate {
  const waiting: Waiter[] = [];
  let readers = 0;
  let writing = false;

  /**
   * Admits whoever the lock can hold right now, in arrival order.
   *
   * A writer is admitted only into an empty lock; readers are admitted in a run
   * and stop at the first waiting writer, which is what makes the lock
   * write-preferring without a separate priority rule.
   */
  function pump(): void {
    // Only a held *write* stops admission outright. A held read does not: the
    // next waiter may be another reader, and turning it away here would make
    // the shared lock serial — which is the bug this shape exists to avoid.
    if (writing) {
      return;
    }
    while (waiting.length > 0) {
      const next = waiting[0];
      if (next === undefined) {
        return;
      }

      if (next.kind === "write") {
        // A writer needs the lock to itself, so it waits for the readers that
        // are already inside; because the queue is arrival-ordered, every
        // reader behind it waits too, which is what keeps it from starving.
        if (readers > 0) {
          return;
        }

        waiting.shift();
        writing = true;
        next.admit();

        return;
      }

      waiting.shift();
      readers += 1;
      next.admit();
    }
  }

  function acquire(kind: Waiter["kind"]): Promise<GateRelease> {
    return new Promise<void>((resolve) => {
      waiting.push({ kind, admit: resolve });
      pump();
    }).then(() => {
      let spent = false;
      return () => {
        if (spent) {
          return;
        }

        spent = true;

        if (kind === "write") {
          writing = false;
        } else {
          readers -= 1;
        }

        pump();
      };
    });
  }

  return {
    read: () => acquire("read"),
    write: () => acquire("write"),
  };
}
