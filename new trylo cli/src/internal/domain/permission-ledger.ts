/**
 * The permission ledger's own three states (WP03.3 / F02).
 *
 * The loop already distinguishes "ran and reported", "ran and failed" and "we
 * never found out" for tool calls (`loop/tool-execution.ts`, and the `unknown`
 * there is load-bearing: an adapter that threw is not the same claim as a tool
 * that ran). A permission decision needs the same three, for the same reason and
 * with one extra edge: the interesting case is not the failure, it is the
 * *approval that may or may not have been spent*.
 *
 * A grant is spent before the work it authorises happens, because the work may
 * be a process that outlives this CLI. So the honest sequence for one authorised
 * call is:
 *
 *   issued    the decision was made and the grant (if any) is committed to store
 *   committed the work finished and the effect is a fact
 *   unknown   we issued, and then the world stopped answering
 *
 * `unknown` is not a failure code and must never be recorded as one. Recording it
 * as `failed` would tell a later reader that nothing happened, which is the one
 * claim nobody is entitled to make after a crash mid-flight: the process may well
 * be running. Recording it as `committed` is the opposite error, and the
 * expensive one — it manufactures permission. This is the same fail-closed
 * direction as the rest of the permission chain, applied to the record rather
 * than to the decision.
 *
 * What is deliberately not here: any storage. This module decides what may be
 * claimed and in what order; where the claims go belongs to whoever owns the
 * journal.
 */

import type { JsonObject } from "../protocol/envelope.js";
import { CALL_QUESTION, grantSatisfies, type GrantKind } from "./grant-lifetime.js";

/**
 * The three states, named for what is known rather than for what happened.
 *
 * `unknown` is a first-class outcome, not an error variant. A type that spelled
 * it `{ok: false}` would invite exactly the collapsing the comment above warns
 * about.
 */
export type LedgerState = "issued" | "committed" | "unknown";

export const LEDGER_STATES: ReadonlyArray<LedgerState> = ["issued", "committed", "unknown"];

/**
 * One authorised call, as the ledger sees it.
 *
 * `grantKind` is what makes a replay decidable: without it, a second identical
 * record is indistinguishable from a first, and "was this already spent" has no
 * answer. It is required rather than optional for the same reason the durable
 * ledger binds action, candidate, version and scope — an unbound authorisation
 * record cannot be checked against anything.
 */
export type LedgerEntry = {
  readonly toolCallId: string;
  readonly pattern: string;
  readonly grantKind: GrantKind;
  /** The state this entry is claiming. */
  readonly state: LedgerState;
  /** The authority that answered, so a reader can tell a person from a rule. */
  readonly source: string;
};

/**
 * The transition a caller may make, and the one it may not.
 *
 * `issued -> committed` and `issued -> unknown` are the two real endings.
 * `committed -> unknown` is refused: a recorded effect that later becomes
 * unknowable is a *new* fact about the world, not a retraction of a recorded
 * one, and letting it overwrite would let a late failure erase a real effect.
 * Everything else — restarting from `unknown`, going back to `issued`, jumping
 * straight to `committed` — is refused for the same overall reason: the sequence
 * is the evidence.
 */
export function canTransition(from: LedgerState, to: LedgerState): boolean {
  if (from === "committed" || from === "unknown") {
    return false;
  }
  return to === "committed" || to === "unknown";
}

/**
 * Fold one entry into a ledger, refusing anything that would rewrite it.
 *
 * Fail-closed by construction: an unaccepted entry is not "ignored", it is
 * `unknown`, because a ledger that silently drops a record it did not understand
 * is a ledger that under-reports what was authorised. The refusal is returned
 * too, so the caller can surface it rather than discover it later.
 */
export function recordEntry(
  ledger: ReadonlyMap<string, LedgerEntry>,
  entry: LedgerEntry,
): { readonly ledger: ReadonlyMap<string, LedgerEntry>; readonly accepted: boolean } {
  const existing = ledger.get(entry.toolCallId);
  if (existing === undefined) {
    if (entry.state !== "issued") {
      // A ledger may not open mid-story. A `committed` with no `issued` has
      // nobody to attribute the authorisation to.
      return { ledger, accepted: false };
    }
    return { ledger: new Map(ledger).set(entry.toolCallId, entry), accepted: true };
  }

  if (existing.state === entry.state) {
    // A duplicate delivery of the same fact is not a conflict; the event ids
    // differ, the claim does not. Treating that as a rejection would make a
    // retried delivery look like a tampered ledger.
    return { ledger, accepted: true };
  }

  if (!canTransition(existing.state, entry.state)) {
    return { ledger, accepted: false };
  }

  return { ledger: new Map(ledger).set(entry.toolCallId, entry), accepted: true };
}

/**
 * Whether this ledger entry may authorise the call it names.
 *
 * The only bridge from "a record exists" to "this may proceed", and it re-checks
 * the grant's kind against the question rather than trusting the entry. A ledger
 * written by an older version, or by a caller that guessed, cannot widen itself
 * by being present.
 */
export function entryAuthorises(entry: LedgerEntry): boolean {
  return grantSatisfies(entry.grantKind, CALL_QUESTION);
}

/**
 * What a reader is told about one entry.
 *
 * `unknown` entries are surfaced, not filtered: a ledger whose unknown states
 * are hidden is a ledger that has quietly become an allow-list.
 */
export function describeEntry(entry: LedgerEntry): JsonObject {
  return {
    toolCallId: entry.toolCallId,
    pattern: entry.pattern,
    grantKind: entry.grantKind,
    state: entry.state,
    source: entry.source,
    authorises: entryAuthorises(entry),
  };
}
