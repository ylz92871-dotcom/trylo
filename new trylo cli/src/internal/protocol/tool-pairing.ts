import type { Transcript } from "./transcript.js";

/**
 * Which `tool_call` blocks still have no answer, and which results answered them.
 *
 * # Why this lives in `protocol/**`
 *
 * Two layers must agree on this and did not. `loop/transcript-append.ts` decided
 * it *by id* — one call per id, so a provider that repeats a `tool_call` id was
 * counted as asking once — while `adapters/session-store/transcript-purge.ts`
 * decided it *by position*, pairing each result with the nearest earlier
 * unanswered call. On `tool_call(x) / tool_result(x) / tool_call(x)` the first
 * reported "settled, no orphans" and the second reported "not settled".
 *
 * That disagreement was not academic. L04 exists for exactly one purpose — to
 * find calls nothing answers — and the id-based reading **hid the orphan in the
 * one case that produces one**. `adapters/session-store/durable-ordinals.test.ts:16`
 * already pins the positional rule ("a historical result cannot settle a later
 * repeated call id"), so that is the rule kept here.
 *
 * `loop/**` may not import `adapters/**` (`verify.mjs` step 4), so sharing by
 * importing the session-store helper was never available. `protocol/**` is the
 * layer both sides already depend on — `loop/compact-boundary.ts` and
 * `adapters/session-store/ndjson.ts` both import `protocol/transcript.js` — and
 * the boundary scan bans `adapters`/`knowledge`/`surface`/`desktop` by name only
 * (`verify.mjs:206`), so this is the one place both can reach.
 *
 * # The rule
 *
 * Results settle the **nearest earlier unanswered call of the same id**, and
 * nothing else. An unanswered call is torn regardless of what follows it, so a
 * call left hanging by a crash is found whether or not a later call reuses its
 * id.
 */

/** One call and the answer it received, in transcript order. */
export type ToolPairing = {
  /** Ids asked for, in the order they were first asked. */
  readonly asked: readonly string[];
  /** Ids that have at least one result. */
  readonly answered: readonly string[];
  /**
   * Ids asked for and never answered.
   *
   * Positional, not by id: asking twice and answering once leaves one orphan,
   * and reporting the id as settled would hide it.
   */
  readonly orphans: readonly string[];
};

/** Transcript indexes of the `tool_call` items nothing has answered. */
export function unansweredCallIndexes(transcript: Transcript): ReadonlySet<number> {
  return indexToolCalls(transcript).unanswered;
}

/** Result index to its nearest earlier unanswered call occurrence. Consumers
 * needing provenance use the same pairing as orphan detection, including when
 * a provider repeats an id. Neither tool names nor outcomes change pairing.
 */
export function toolCallIndexByResult(transcript: Transcript): ReadonlyMap<number, number> {
  return indexToolCalls(transcript).answered;
}

function indexToolCalls(transcript: Transcript): {
  readonly unanswered: ReadonlySet<number>;
  readonly answered: ReadonlyMap<number, number>;
} {
  const pending = new Map<string, number[]>();
  const torn = new Set<number>();
  const answered = new Map<number, number>();
  for (const [index, item] of transcript.entries()) {
    if (item.kind === "tool_call") {
      const calls = pending.get(item.toolCallId) ?? [];
      calls.push(index);
      pending.set(item.toolCallId, calls);
      torn.add(index);
    } else if (item.kind === "tool_result") {
      const settled = pending.get(item.toolCallId)?.pop();
      if (settled !== undefined) {
        torn.delete(settled);
        answered.set(index, settled);
      }
    }
  }
  return { unanswered: torn, answered };
}

/**
 * True when every `tool_call` has a result of some outcome.
 *
 * A result of *any* outcome settles its call: `cancelled`, `failed` and
 * `unknown` are things that really happened. Only a call with no result at all
 * is unsettled.
 */
export function allToolCallsSettled(transcript: Transcript): boolean {
  return unansweredCallIndexes(transcript).size === 0;
}

/**
 * The pairing, read off a transcript.
 *
 * A value, so a caller cannot hold a stale view of a transcript that has since
 * grown. `orphans` keeps transcript order and repeats an id that was asked
 * twice and answered once — the second ask is a distinct unanswered call even
 * though the id repeats, and a caller pairing them must not answer it once.
 */
export function toolPairingOf(transcript: Transcript): ToolPairing {
  // One pass, not one per item: the torn set is computed once and consulted.
  const torn = unansweredCallIndexes(transcript);
  const asked: string[] = [];
  const answered = new Set<string>();
  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const [index, item] of transcript.entries()) {
    if (item.kind === "tool_call") {
      if (!seen.has(item.toolCallId)) {
        seen.add(item.toolCallId);
        asked.push(item.toolCallId);
      }
      if (torn.has(index)) orphans.push(item.toolCallId);
    } else if (item.kind === "tool_result") {
      answered.add(item.toolCallId);
    }
  }
  return { asked, answered: [...answered], orphans };
}
