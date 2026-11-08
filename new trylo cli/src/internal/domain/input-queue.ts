/**
 * Mid-run user input: the queue, the inbox that feeds it, and the safe boundary
 * (WP D 波 §5.2, WP08 §3).
 *
 * Two modes, because they answer different questions:
 *
 *  - **`steer`** — "stop what you are doing and take this into account". All
 *    leading steers are promoted together at the next safe boundary and the
 *    step budget is reset, so a person redirecting the run is not charged for
 *    the steps the run already spent going the wrong way.
 *  - **`queue`** — "say this when you are free". One message per gap, promoted
 *    only when the turn would otherwise have gone idle, so queued text can
 *    never preempt a tool result the model is still owed.
 *
 * The boundary is *not* decided here. This module says what may be promoted and
 * how much budget it costs; the loop decides when a boundary has been reached
 * and the reducer refuses the input outside one. Three owners, one rule.
 */

export type InputMode = "steer" | "queue";

export type PendingUserInput = {
  readonly text: string;
  readonly mode: InputMode;
};

/**
 * A message that knows which turn it was typed for.
 *
 * The turn id is what makes "a message typed for a turn that has already ended
 * cannot be delivered to the next one" a property of the data rather than of
 * whoever happens to be holding it (WP08.1). Absent means the message predates
 * identity — every hermetic caller that was written before this field — and the
 * loop treats it as belonging to whatever turn asks.
 */
export type AddressedUserInput = PendingUserInput & {
  readonly turnId?: string;
};

/**
 * The ceiling on how much may be waiting at once.
 *
 * Every queued message costs at least one iteration, so an unbounded queue is
 * an unbounded turn: a person who typed fifty corrections would be buying fifty
 * provider requests. Eight is more redirection than anyone types while a turn
 * is running; past it the honest answer is a refusal the surface can show, not
 * a queue that grows in silence.
 */
export const MAX_PENDING_INPUT = 8;

export type InputRejectReason =
  /** Nothing but whitespace: there is no message here to deliver. */
  | "blank"
  /** The ceiling is already standing; admitting would make the queue a lie. */
  | "full"
  /** The turn this message was typed for is over. */
  | "turn_closed"
  /** The message names a turn other than the one that owns the inbox. */
  | "turn_mismatch";

export type Admission =
  | { readonly kind: "accepted"; readonly inbox: UserInputInbox }
  | { readonly kind: "rejected"; readonly reason: InputRejectReason; readonly inbox: UserInputInbox };

/**
 * Everything typed during one turn that the turn has not taken yet.
 *
 * One turn, one inbox: the turn id is stamped on admission, which is what makes
 * a late message from the turn before structurally unable to reach this one
 * instead of merely unlikely to.
 */
export type UserInputInbox = {
  readonly turnId: string;
  readonly items: ReadonlyArray<AddressedUserInput>;
  readonly closed: boolean;
};

export function openInbox(turnId: string): UserInputInbox {
  return { turnId, items: [], closed: false };
}

/**
 * Offer one message to one turn.
 *
 * The verdict is returned rather than thrown away because the difference
 * between "accepted" and "refused because the turn ended" is exactly what a
 * surface has to be able to show: a person whose words were dropped without a
 * reason is a person who will type them again into a turn that cannot hear
 * them either (WP08.1 "接收/拒绝明确").
 */
export function admit(
  inbox: UserInputInbox,
  input: PendingUserInput & { readonly turnId: string },
): Admission {
  if (inbox.closed) {
    return { kind: "rejected", reason: "turn_closed", inbox };
  }

  if (input.turnId !== inbox.turnId) {
    return { kind: "rejected", reason: "turn_mismatch", inbox };
  }

  if (input.text.trim().length === 0) {
    return { kind: "rejected", reason: "blank", inbox };
  }

  if (inbox.items.length >= MAX_PENDING_INPUT) {
    return { kind: "rejected", reason: "full", inbox };
  }

  return {
    kind: "accepted",
    inbox: { ...inbox, items: [...inbox.items, { ...input, turnId: input.turnId }] },
  };
}

/**
 * Hand over what is waiting, once.
 *
 * Draining is the only way out of the inbox, so a message can be taken by its
 * turn exactly once; a second call finds nothing rather than delivering twice
 * (WP08.3).
 */
export function drainInbox(inbox: UserInputInbox): {
  readonly inbox: UserInputInbox;
  readonly taken: ReadonlyArray<AddressedUserInput>;
} {
  return { inbox: { ...inbox, items: [] }, taken: inbox.items };
}

/**
 * End the inbox — because the turn ended, or because it was cancelled — and
 * hand back whatever was never taken.
 *
 * Closing is not discarding. A cancelled turn leaves the person's words in the
 * surface's hands, where they can be restored into the composer or offered to
 * the next turn, instead of evaporating with the engine that held them
 * (WP08.3, C82 draft recovery).
 */
export function closeInbox(inbox: UserInputInbox): {
  readonly inbox: UserInputInbox;
  readonly unconsumed: ReadonlyArray<AddressedUserInput>;
} {
  return { inbox: { ...inbox, items: [], closed: true }, unconsumed: inbox.items };
}

/** Whether a message may be delivered to this turn. */
export function belongsToTurn(input: AddressedUserInput, turnId: string | undefined): boolean {
  if (input.turnId === undefined || turnId === undefined) {
    return true;
  }
  return input.turnId === turnId;
}

export type Promotion = {
  readonly batch: ReadonlyArray<AddressedUserInput>;
  readonly rest: ReadonlyArray<AddressedUserInput>;
  /** True for a steer: the iteration budget is forgiven, not extended. */
  readonly resetBudget: boolean;
};

export const NO_PROMOTION: Promotion = { batch: [], rest: [], resetBudget: false };

/**
 * What the next safe boundary may take.
 *
 * An empty queue promotes nothing. A `steer` at the head takes every leading
 * steer (a person who typed three corrections meant all three); anything else
 * takes exactly one message, so a queue cannot starve the turn it is feeding.
 *
 * The ceiling that keeps this queue honest is applied before it is ever reached
 * — the loop stops taking input at `MAX_PENDING_INPUT` — so this function only
 * ever decides *what*, never *how much may accumulate*.
 */
export function nextPromotion(queue: ReadonlyArray<AddressedUserInput>): Promotion {
  const head = queue[0];
  if (head === undefined) {
    return NO_PROMOTION;
  }

  if (head.mode !== "steer") {
    return { batch: [head], rest: queue.slice(1), resetBudget: false };
  }

  let taken = 0;

  while (taken < queue.length && queue[taken]?.mode === "steer") {
    taken += 1;
  }

  return { batch: queue.slice(0, taken), rest: queue.slice(taken), resetBudget: true };
}

/** How many messages are still waiting; the number that keeps a turn open. */
export function pendingCount(queue: ReadonlyArray<AddressedUserInput>): number {
  return queue.length;
}

/**
 * Folding newly handed-over input into the queue the loop already owns.
 *
 * Kept separate from `admit` because the two answer different questions: the
 * inbox decides whether a message may be *offered to a turn at all*, and this
 * decides what the loop does with what a host has already handed it. Both are
 * bounded by `MAX_PENDING_INPUT`, and neither drops anything in silence — the
 * loop stops asking for input once its own queue is full, so what is not taken
 * is still sitting with the host.
 */
export function admitInput(
  queue: ReadonlyArray<AddressedUserInput>,
  input: AddressedUserInput,
): ReadonlyArray<AddressedUserInput> {
  if (input.text.trim().length === 0) {
    return queue;
  }
  return [...queue, input];
}

/**
 * The two ends of the hand-over, written once because both surfaces and the
 * host have to read the same sentence (WP08).
 *
 * **The lender the host is given is not a queue.** The surface that owns the
 * terminal owns the words; the loop asks for them once per safe boundary, and
 * calling it *takes* what it returns — a host that answered the same words twice
 * would have them delivered twice. Absent (`trylo run`, the line REPL, every
 * hermetic caller) means `LoopPorts.pendingInput` is never built and the turn is
 * byte for byte one that never heard of mid-run input. The id it is handed is
 * the turn that is asking, which is what keeps words typed for a turn that has
 * ended out of the next one's inbox.
 *
 * **What the loop took and never promoted is a debt, not a message.** A turn can
 * end — completed, cancelled, failed — with input still sitting in its queue
 * because no boundary that could take it ever arrived. The loop says so, and the
 * surface puts the words back where the person hears them answered. Dropping
 * them is the one thing this package exists to prevent: words accepted and then
 * discarded in silence are worse than words refused, because the person has no
 * reason to type them again.
 */
