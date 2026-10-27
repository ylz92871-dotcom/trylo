import type {
  CompactRecordDraft,
} from "../ports/compaction.js";
import type { Transcript } from "../protocol/transcript.js";
import { journalView, type CompactionEntry, type CompactionLedger } from "./compact-ledger.js";
import type { CompactionEvent, CompactionInput, CompactionWiring } from "./compact-boundary.js";
import { transcriptToMessages } from "./transcript-messages.js";
import { promptViewMessages } from "./prompt-view.js";
import { requestMessages } from "./request.js";
import { autoCompactTokenLimit } from "../compaction/policy.js";
export { promptViewMessages, summaryMessage, coveredExchangeTail } from "./prompt-view.js";

/**
 * The mechanics of one pass over the iteration gap (WP09).
 *
 * Split out of `compact-boundary.ts` along the seam the file itself names: the
 * boundary module owns the *vocabulary* — what a window means, what the model
 * sees, how the wiring is described — while this module owns the *decision
 * machine*: when the gap compacts, on which token basis, how a stored window
 * is proven, and what the caller learns about the view afterwards. The
 * dependency runs one way; nothing here is re-exported back.
 */

/**
 * What one pass over the gap produced.
 *
 * `projectedPromptTokens` is the basis the world would present *after* the
 * stored window: what the next request would carry if nothing more happened.
 * The runner reads it to decide whether a rescue actually cleared the ceiling
 * or only moved history around, so the answer cannot be inferred from the
 * stale server report of a request that no longer describes the view.
 */
export type CompactionGapOutcome = {
  readonly events: ReadonlyArray<CompactionEvent>;
  readonly storedWindow: boolean;
  readonly projectedPromptTokens: number | undefined;
};

/**
 * One pass over the iteration gap: tools have settled, the next request has
 * not been built.
 *
 * Two callers, one machine:
 *
 *  - the **probe** (default): recheck the threshold as the task grows. A hold
 *    consumes no attempt. A successful reduction below the ceiling rearms the
 *    probe; a refused or ineffective summary latches it for this turn. This
 *    permits long tasks without repeatedly summarising an irreducible view;
 *  - the **forced** pass (`force: true`, the ceiling rescue): the provider's
 *    own report already proved the view over the ceiling, so the threshold is
 *    not asked. The caller bounds how often this may happen per turn.
 *
 * Returns the envelopes to emit rather than emitting them, so this stays a
 * decision and can never reach the journal on its own. Async because authoring
 * a summary may mean asking the provider — the only await sits between the
 * decision to compact and the draft, and never between two envelopes.
 */
export async function runCompactionFor(
  input: CompactionInput,
  options?: { readonly force?: boolean; readonly onStart?: (tokens: number) => void; readonly signal?: AbortSignal },
): Promise<CompactionGapOutcome> {
  const { wiring, ledger, sessionId, contextTokenLimit } = input;
  if (wiring === undefined || (ledger.attempted && options?.force !== true)) {
    return { events: [], storedWindow: false, projectedPromptTokens: undefined };
  }
  // No journal identity to put on a record, or no ceiling to be over: there is
  // nothing to author and nothing to decide.
  if (sessionId === undefined || contextTokenLimit === undefined) {
    return { events: [], storedWindow: false, projectedPromptTokens: undefined };
  }
  const records = journalView(sessionId, input.transcript, ledger.entries, ledger.resumed);
  const projected = wiring.port.projectForPrompt({ records });
  if (!projected.ok) {
    ledger.attempted = true;
    return { events: [degradation(projected.code)], storedWindow: false, projectedPromptTokens: undefined };
  }
  const estimated = requestTokenBasis(input);
  if (options?.force !== true) {
    const decision = wiring.port.shouldCompact({
      view: projected.view,
      contextTokenLimit,
      estimatedPromptTokens: estimated,
    });
    if (decision.outcome !== "compact") {
      return { events: [], storedWindow: false, projectedPromptTokens: estimated };
    }
  }
  // The one await: the decision to compact has been made, the draft does not
  // exist yet. A wiring that returns a promise asks the provider here — at the
  // gap, where no stream is in flight and no envelope ordering can be broken.
  ledger.attempted = true;
  options?.onStart?.(estimated);
  const summary = await wiring.summarize(projected.view.items, projected.view.window?.summary, options?.signal, input.transcript);
  if (options?.signal?.aborted) return { events: [degradation("cancelled")], storedWindow: false, projectedPromptTokens: estimated };
  const drafted = wiring.port.compact({
    records,
    sessionId,
    at: wiring.now(),
    summary,
  });
  if (!drafted.ok) {
    // Fail closed: the latch stays on, so a refused authoring is reported once
    // instead of retried at every gap for the rest of the turn.
    return { events: [degradation(drafted.code)], storedWindow: false, projectedPromptTokens: estimated };
  }
  const stored = storeWindow(wiring, ledger, {
    sessionId,
    transcript: input.transcript,
    liveCount: projected.view.items.length,
    draft: drafted.record,
  });
  if (!stored.ok) {
    return { events: [degradation(stored.code)], storedWindow: false, projectedPromptTokens: estimated };
  }
  // The post-window basis is local on purpose: the server report describes the
  // request that carried the *old* view, and the whole point of the window is
  // that the next request no longer does.
  const projectedPromptTokens = localViewBasis(input);
  ledger.attempted = projectedPromptTokens >= autoCompactTokenLimit(contextTokenLimit);
  return {
    events: stored.events.map(event => ({ ...event, payload: { ...event.payload,
      tokensBefore: estimated, tokensAfter: projectedPromptTokens } })),
    storedWindow: true,
    projectedPromptTokens,
  };
}

/**
 * The token basis of the request the current view would produce.
 *
 * With a server report that still describes this view, two floors are known
 * and the larger wins: the report is what the provider *measured* for the
 * request it answered (plus a local estimate of the items appended since —
 * the split Codex draws between `last_token_usage` and locally unreported
 * items), and the local estimate is what the request *carries* by the same
 * byte rule everywhere. A threshold whose failure mode is a provider refusal
 * must trigger on the larger, never trust either alone: a scripted or
 * under-reporting provider must not hide a full view behind a small number.
 * With a stale report or none at all, only the local estimate exists.
 */
function requestTokenBasis(
  input: CompactionInput,
): number {
  const wiring = input.wiring;
  if (wiring === undefined) {
    return 0;
  }
  const local = localViewBasis(input);
  const reported = input.reported;
  if (
    reported !== undefined &&
    // A zero report is no report: a provider that did not measure the request
    // (the fixture, a stream cut before usage) has nothing to take a max with.
    reported.promptTokens > 0 &&
    reported.windowId === (input.ledger.window === undefined ? undefined : input.ledger.window.windowId)
  ) {
    const liveTail = input.transcript.slice(
      Math.min(reported.transcriptLength, input.transcript.length),
    );
    return Math.max(local, reported.promptTokens + wiring.estimatePromptTokens(transcriptToMessages(liveTail)));
  }
  return local;
}

/**
 * The basis of the request the *current* view would produce, projected fresh.
 *
 * The ceiling gate reads this before it trusts a verdict computed from the
 * last stream's report: a window stored since that report — or any projection
 * failure — is the difference between "the provider said over" and "the next
 * request is over". Undefined means the basis could not be established (no
 * wiring, no journal identity, an unreadable projection), and the caller falls
 * back to the verdict it already holds.
 */
export function currentPromptBasis(input: CompactionInput): number | undefined {
  const { wiring, ledger, sessionId } = input;
  if (wiring === undefined || sessionId === undefined) {
    return undefined;
  }
  const records = journalView(sessionId, input.transcript, ledger.entries, ledger.resumed);
  const projected = wiring.port.projectForPrompt({ records });
  if (!projected.ok) {
    return undefined;
  }
  return requestTokenBasis(input);
}

/**
 * The local estimate of one view: seeds, the standing summary (which
 * `promptMessages` prepends just as this does), the live items, and the tool
 * table. This is the number a threshold can compare against a ceiling when no
 * server report describes the view.
 */
function localViewBasis(
  input: CompactionInput,
): number {
  const wiring = input.wiring;
  if (wiring === undefined) {
    return 0;
  }
  const overhead =
    input.tools !== undefined && wiring.estimateOverheadTokens !== undefined
      ? wiring.estimateOverheadTokens(input.tools)
      : 0;
  const messages = requestMessages(promptViewMessages({ ...input, toolResultProjection: "microcompact" }), input.seedMessages.length, {
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.systemPromptAppend === undefined ? {} : { systemPromptAppend: input.systemPromptAppend }),
  });
  return wiring.estimatePromptTokens(messages) + overhead;
}

/**
 * Storing a window only together with the projection that proves it.
 *
 * A window that cannot be projected is worse than no window: the text it claims
 * to have replaced would go back to the model, under a summary saying it is
 * gone. So the entry is pushed only after the re-projection succeeds.
 */
function storeWindow(
  wiring: CompactionWiring,
  ledger: CompactionLedger,
  stored: {
    readonly sessionId: string;
    readonly transcript: Transcript;
    readonly liveCount: number;
    readonly draft: CompactRecordDraft;
  },
): { readonly ok: true; readonly events: ReadonlyArray<CompactionEvent> } | { readonly ok: false; readonly code: string } {
  const entry: CompactionEntry = {
    draft: stored.draft,
    afterItemCount: stored.transcript.length,
  };
  const projected = wiring.port.projectForPrompt({
    records: journalView(
      stored.sessionId,
      stored.transcript,
      [...ledger.entries, entry],
      ledger.resumed,
    ),
  });
  if (!projected.ok) {
    return { ok: false, code: projected.code };
  }
  ledger.entries.push(entry);
  ledger.window = projected.view.window;
  // The live tail is what the projection kept; everything before it is what the
  // window now stands in for, expressed as a prefix of the runner's transcript.
  ledger.replacedPrefix = stored.transcript.length - projected.view.items.length;
  return {
    ok: true,
    events: [
      {
        kind: "compact",
        payload: {
          compactId: entry.draft.payload.windowId,
          droppedEvents: stored.liveCount - projected.view.items.length,
        },
      },
    ],
  };
}

/**
 * A compaction that did not happen, reported.
 *
 * The code travels, never the text that was refused: naming the offending
 * substring in a diagnosis is how a red-lined summary reaches the log anyway.
 */
function degradation(code: string): CompactionEvent {
  return {
    kind: "observation",
    payload: { degraded: true, component: "compaction", reason: code },
  };
}
