import type { BudgetVerdict } from "../domain/iteration.js";
import {
  admitInput,
  belongsToTurn,
  MAX_PENDING_INPUT,
  nextPromotion,
  pendingCount,
  type AddressedUserInput,
} from "../domain/input-queue.js";
import type { ReduceInput } from "../domain/input.js";
import type { PhaseName } from "../domain/state.js";

/**
 * The iteration gap (WP D 波 §5.2–§5.4): what a spent budget does to a turn,
 * and what a message typed while the turn was busy does to it.
 *
 * The gap is the one point in a turn where every tool has settled and the next
 * request has not been built — which makes it the only place where "the context
 * is full" can be answered by making the past shorter instead of by giving up,
 * and the only safe place to fold in something a person just said.
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *  - **`compact_then_continue`** — the ceiling is a *context* ceiling and a
 *    summary can still be authored, so the same logical turn keeps going. This is
 *    the behaviour the survey found in opencode's `TurnTransition` and codex's
 *    mid-turn compact; before this wave a full context ended the turn outright.
 *  - **`await_continuation`** — the turn stopped because it needs a person (an
 *    iteration or token budget ran out), not because it broke. The reducer marks
 *    that on the terminal envelope, so a projection can offer "continue" instead
 *    of reporting a failure the user cannot act on (反方 #22).
 *  - **`terminate`** — everything else.
 *
 * Pure, so the rule is one function with one owner rather than a second copy
 * inside `runner.ts` (which is frozen against growing).
 */

export type ExhaustionReason =
  | "iterations_exhausted"
  | "output_tokens_exhausted"
  | "budget_usd_exhausted"
  | "context_limit";

export type GapDecision =
  | { readonly kind: "within_budget" }
  | { readonly kind: "compact_then_continue" }
  | { readonly kind: "await_continuation"; readonly reason: ExhaustionReason }
  | { readonly kind: "terminate"; readonly reason: string };

/**
 * `compactionMayHelp` is the caller's answer to "has a compaction already been
 * attempted this turn, and is there a ceiling to be over at all?" — both facts
 * the ledger owns, neither of which this function may guess.
 */
export function decideGap(verdict: BudgetVerdict, compactionMayHelp: boolean): GapDecision {
  switch (verdict.kind) {
    case "within_budget":
      return { kind: "within_budget" };
    case "context_limit":
      return compactionMayHelp
        ? { kind: "compact_then_continue" }
        : { kind: "await_continuation", reason: "context_limit" };
    case "iterations_exhausted":
    case "output_tokens_exhausted":
    case "budget_usd_exhausted":
      return { kind: "await_continuation", reason: verdict.kind };
  }
}

/**
 * The reason a `waiting:` turn-failure carries — one prefix, one owner, so a
 * projection matches a string that no two call sites can spell differently.
 */
export function waitingReasonFor(reason: string): string {
  return `waiting:${reason}`;
}

/**
 * What the gap needs from the turn loop, and nothing else.
 *
 * The loop owns the engine; these helpers own the rule. Splitting them this way
 * is what lets `runner.ts` — frozen against growing — stay a wiring seam while
 * the gap still has one place that decides what may be promoted and when.
 */
export type GapHost = {
  /** Read fresh: a dispatch may have just changed the phase. */
  readonly phase: () => PhaseName;
  /** Messages the host hands over once; calling it again yields nothing. */
  readonly pending: () => ReadonlyArray<AddressedUserInput>;
  readonly queue: () => ReadonlyArray<AddressedUserInput>;
  readonly setQueue: (queue: ReadonlyArray<AddressedUserInput>) => void;
  /**
   * What the turn was handed but cannot hold. Not dropped: it is carried as
   * debt and reported with the result, so a refusal at the ceiling stays
   * visible instead of becoming a message nobody answers (WP08.1).
   */
  readonly setAside: (items: ReadonlyArray<AddressedUserInput>) => void;
  /**
   * A steer forgives the steps already spent; it never raises the ceiling.
   *
   * "Forgives" and "unbounds" are different things, and the host is the one
   * that keeps them apart: the refund is drawn from an allowance no larger than
   * one turn's own budget, so a person who keeps redirecting can buy at most
   * one more turn's worth of steps — past that the steering is still honoured
   * and the words still delivered, but the budget is no longer refunded and the
   * ceiling holds.
   */
  readonly forgiveBudget: () => void;
  readonly dispatch: (input: ReduceInput) => Promise<void>;
  readonly nextEventId: () => string;
  /** Makes promoted text visible to the next request, not just to the journal. */
  readonly appendUser: (text: string) => void;
};

/**
 * Hands over whatever arrived while the turn was busy and reports how many
 * messages are now waiting. Called once per gap, before the end-of-iteration
 * gate, so the gate counts the same messages the promotion will then take.
 *
 * Three things it will not do, none of them by losing a message:
 *
 *  - **A full queue is not asked for more.** Once the turn's own queue stands
 *    at the ceiling, `pending()` is not called at all, so what the host is
 *    still holding stays with the host instead of being taken and dropped.
 *  - **A partial hand-over is taken partially.** A host that offers more than
 *    the remaining room keeps the excess only in the sense that the turn will
 *    not hold it: it is set aside and reported with the result, not swallowed.
 *  - **A message addressed to another turn is not taken.** Identity is stamped
 *    by the inbox that admitted it; this is the consumer's own half of the same
 *    rule, and it is what keeps the guarantee from depending on every host
 *    behaving itself (WP08.1).
 */
export function drainPendingInput(host: GapHost, expectedTurnId: string | undefined): number {
  const room = MAX_PENDING_INPUT - pendingCount(host.queue());
  if (room <= 0) {
    // Not asked at all: what the host is still holding stays with the host
    // rather than being taken and then having nowhere to go.
    return pendingCount(host.queue());
  }

  const incoming = host.pending().filter((input) => belongsToTurn(input, expectedTurnId));
  const taken = incoming.slice(0, room);
  const overflow = incoming.slice(room);

  if (taken.length > 0) {
    let queue = host.queue();
    for (const input of taken) {
      queue = admitInput(queue, input);
    }
    host.setQueue(queue);
  }

  if (overflow.length > 0) {
    // Refused at the ceiling, and carried rather than dropped: the turn may
    // not hold them, but nobody may pretend they were never said.
    host.setAside(overflow);
  }

  return pendingCount(host.queue());
}

/**
 * Promoting what a person typed while the turn was busy.
 *
 * This is the loop's half of the steer rule: the reducer refuses `user_input`
 * outside `turning`, and the loop only sends it here — every tool settled, next
 * request not built. Neither half alone would be enough.
 */
export async function promoteGapInput(host: GapHost): Promise<void> {
  if (host.phase() !== "turning") {
    return;
  }

  const promotion = nextPromotion(host.queue());
  if (promotion.batch.length === 0) {
    return;
  }

  host.setQueue(promotion.rest);

  if (promotion.resetBudget) {
    host.forgiveBudget();
  }

  for (const item of promotion.batch) {
    await host.dispatch({
      type: "user_input",
      eventId: host.nextEventId(),
      text: item.text,
      mode: item.mode,
    });
    host.appendUser(item.text);
  }
}
