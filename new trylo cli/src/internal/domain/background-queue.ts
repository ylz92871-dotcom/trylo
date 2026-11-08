import {
  MAX_QUEUED_MESSAGES,
  type QueueFailureCode,
  type QueuePage,
  type QueueResult,
  type QueuedMessage,
} from "../ports/background-queue.js";

/**
 * What to do with a session's queue when the session goes idle.
 *
 * Codex's `dispatch_if_idle` decides this against a running thread, and its one
 * rule is that a message is removed only *after* the core has started a turn
 * from it. That order is the whole point, and it is what makes "at most once"
 * true across a crash: a message removed before the turn starts is a message
 * that can be lost, and a message removed after a start that never happened is a
 * message delivered to nothing.
 *
 * So this module produces the decision and nothing else. Deciding is pure;
 * starting a turn is not, and the caller owns that. What comes back is which
 * message to start from, or why no message may be started — never "start it and
 * then see".
 */

/** The verdict for one idle moment. */
export type DispatchDecision =
  /** Start exactly this message, and remove it only once the start succeeded. */
  | { readonly kind: "start"; readonly message: QueuedMessage }
  /** Nothing waiting. */
  | { readonly kind: "idle" }
  /** The queue could not be read; nothing is known, so nothing is claimed. */
  | { readonly kind: "unknown"; readonly code: QueueFailureCode };

/**
 * Whether a queue is one whose first message may start a turn.
 *
 * Takes the port's own `QueuePage` rather than a loose shape, so the decision is
 * made from exactly what the adapter read — including `total`, which this
 * function deliberately ignores. The first message is the one that goes first
 * whether or not nine more are behind it; that is the ordering the person saw
 * when they queued them.
 *
 * Empty is `idle`, and unreadable is `unknown` — the two are kept apart on
 * purpose. A caller that maps both to "nothing to do" reports a queue it could
 * not read as an empty one, and the person concludes their message was never
 * queued. Codex keeps them apart too: `dispatch_if_idle` returns on
 * `NotSubmitted` and on error without deleting anything, so a message survives
 * a dispatch that could not happen.
 *
 * A message with blank text is also `unknown`-shaped rather than startable: it
 * reached durable storage by some path this process did not validate, and
 * starting a turn from nothing would spend a provider request to say nothing.
 * It is *not* removed here — dropping another writer's message on the grounds
 * that it looks wrong is not this module's call.
 */
export function dispatchDecision(page: QueueResult<QueuePage>): DispatchDecision {
  if (!page.ok) {
    return { kind: "unknown", code: page.code };
  }

  const head = page.value.items[0];
  if (head === undefined) {
    return { kind: "idle" };
  }

  if (head.text.trim().length === 0) {
    return { kind: "unknown", code: "queue_unreadable" };
  }

  return { kind: "start", message: head };
}

/**
 * Why one message may or may not be queued.
 *
 * Refused rather than truncated, for the reason `MAX_PENDING_INPUT` gives for
 * the in-turn queue: a queue that accepted a message it had to shorten is a
 * queue whose contents nobody can trust to be what was typed.
 */
export type EnqueueVerdict =
  | { readonly kind: "accepted"; readonly text: string }
  | { readonly kind: "refused"; readonly code: "blank" | "full" };

/**
 * Whether one more message may join a queue of `current` messages.
 *
 * The ceiling is checked against what is *stored*, not against what has been
 * dispatched, because a dispatched message that was started but not yet
 * removed is still in the file and still occupies its place. Checking the other
 * way would let two processes each admit the hundred-and-first.
 */
export function enqueueVerdict(
  text: string,
  current: number,
): EnqueueVerdict {
  if (text.trim().length === 0) {
    return { kind: "refused", code: "blank" };
  }

  if (current >= MAX_QUEUED_MESSAGES) {
    return { kind: "refused", code: "full" };
  }

  return { kind: "accepted", text };
}

/**
 * Whether a proposed order is a permutation of the queue.
 *
 * Exact, and checked as a set rather than as a list: Codex's SQLite store sorts
 * both sides before comparing (`state/src/runtime/queued_items.rs:173-177`) and
 * rejects anything that is not every id exactly once. Accepting a prefix would
 * make `reorder` a way to delete messages without saying so.
 */
export function isPermutation(
  currentIds: ReadonlyArray<string>,
  orderedIds: ReadonlyArray<string>,
): boolean {
  if (currentIds.length !== orderedIds.length) {
    return false;
  }
  const current = [...currentIds].sort();
  const next = [...orderedIds].sort();
  return current.every((id, index) => id === next[index]);
}
