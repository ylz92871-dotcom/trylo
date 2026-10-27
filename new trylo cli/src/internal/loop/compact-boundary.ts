import type {
  CompactionPort,
} from "../ports/compaction.js";
import type { ProviderMessage, SystemPromptDirective } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { EventKind } from "../protocol/kinds.js";
import type { Transcript, TranscriptItem } from "../protocol/transcript.js";
import type { CompactionLedger } from "./compact-ledger.js";
import { promptViewMessages } from "./prompt-view.js";

/**
 * The ledger half of the compaction vocabulary is defined in `compact-ledger.ts`
 * and re-exported here so the loop keeps a single import path for it: `runner.ts`
 * and the tests name these symbols, and moving a definition must not force every
 * call site to know which of the two files it landed in. The gap's decision
 * machine lives in `compaction-gap.ts` and is re-exported under the same rule.
 */
export {
  adoptResumedWindow,
  createCompactionLedger,
  windowOnJournal,
} from "./compact-ledger.js";
export type { CompactionEntry, CompactionLedger, ResumedCompaction } from "./compact-ledger.js";
export { currentPromptBasis, runCompactionFor } from "./compaction-gap.js";
export type { CompactionGapOutcome } from "./compaction-gap.js";

/**
 * The iteration gap, where compaction is allowed to happen.
 *
 * Contract (WP-HY4 §2.2, amended WP09.2), fixed here so the loop and its tests
 * cannot drift:
 *
 *  - **optional**. No wiring means the transcript is sent whole, byte for byte
 *    as before. Compaction is something a composition root opts into;
 *  - **one token basis**. The gap's estimate over the exact view the next
 *    request would carry — server-reported where the report still describes
 *    the view, local estimate elsewhere (WP09.1/C35) — compared against
 *    `budget.contextTokenLimit`. No wall clock, and no second switch on
 *    message count — two ways to trip one decision need a precedence rule
 *    nobody wrote down;
 *  - **one ceiling**. The limit is the budget's, not a second copy here. A port
 *    injected without a configured ceiling therefore never compacts, because
 *    there is nothing to be over;
 *  - **growth-driven probes, and a bounded rescue**. A hold leaves the probe
 *    available. A window that clears the ceiling rearms it for later growth;
 *    refused or ineffective authoring disables probes for this turn. The
 *    ceiling rescue (`budget-gate.ts`) may force up to two more windows when
 *    the provider's report proves the view over the ceiling;
 *  - **compaction never cancels the hard gate**. It exists to reach
 *    `context_limit` less often; if the view is still over the ceiling after a
 *    stored window, the turn ends at `context_limit`;
 *  - **fail closed**. A refused summary stores no window, replaces no history
 *    and is reported as a degradation — silently dropping the replaced text
 *    without a summary would invent a shorter past;
 *  - the loop **appends nothing to disk**. `compact` hands back a draft, the
 *    loop carries it out on the turn result, and the single writer of the
 *    journal stays the session store.
 */

export type CompactionWiring = {
  readonly port: CompactionPort;
  /** Pure estimate over the messages the next provider request would carry. */
  readonly estimatePromptTokens: (messages: ReadonlyArray<ProviderMessage>) => number;
  /**
   * Authors the summary text. The loop never invents one: `CompactionPort`
   * validates a summary, it does not write it, and a summary the loop made up
   * would be indistinguishable from one the caller asked for.
   *
   * May return a promise: authoring is where `--compact-summary=model` asks the
   * provider, and the gap is the one point in a turn that is already async and
   * holds no stream mid-flight. A synchronous wiring (the shipped extractive
   * default) stays exactly as fast as it was.
   */
  /** The optional full transcript supplies request provenance across windows;
   * it is not additional material to resend in an auxiliary provider request. */
  readonly summarize: (items: ReadonlyArray<TranscriptItem>, previousSummary?: string, signal?: AbortSignal,
    requestTranscript?: ReadonlyArray<TranscriptItem>) => string | Promise<string>;
  /**
   * The tokens the tool table adds to every request (`tools` on the wire).
   *
   * The gap's threshold comparison is against `budget.contextTokenLimit`, and
   * the limit describes the whole request — so the comparison has to include
   * the table beside the messages. Absent (callers that never heard of it,
   * including every existing test wiring) counts zero overhead, which is
   * exactly the old behaviour.
   */
  readonly estimateOverheadTokens?: (tools: ToolPort) => number;
  /** Stamps the durable draft. The loop owns no clock, so the host lends one. */
  readonly now: () => string;
};

/** The conversation as it stands, from the side that builds a request. */
export type PromptContext = {
  readonly seedMessages: ReadonlyArray<ProviderMessage>;
  readonly transcript: Transcript;
  readonly ledger: CompactionLedger;
  readonly toolResultProjection?: "microcompact";
  readonly systemPrompt?: SystemPromptDirective;
  readonly systemPromptAppend?: string;
};

export type CompactionInput = PromptContext & {
  readonly wiring: CompactionWiring | undefined;
  /** A window is a journal record, so it needs the identity of that journal. */
  readonly sessionId: string | undefined;
  /** The budget's ceiling. The only one; see the contract above. */
  readonly contextTokenLimit: number | undefined;
  /** The mounted catalog, when the wiring knows how to price its table. */
  readonly tools: ToolPort | undefined;
  /**
   * The server-reported size of the last request and how much transcript it
   * covered (WP09.1/C35). Present, the gap's token basis is that report plus
   * a local estimate of the items appended since — the two halves Codex keeps
   * apart in `get_total_token_usage`, so a server answer is never silently
   * replaced by a guess about the request it already measured. Absent (no
   * stream has reported yet) the basis falls back to the full local estimate.
   */
  readonly reported: ReportedRequestBasis | undefined;
};

export type ReportedRequestBasis = {
  readonly promptTokens: number;
  readonly transcriptLength: number;
  /**
   * The window the reported request was built under. A window stored *after*
   * that request makes the report stale — it measured a view the projection
   * has since replaced — so the basis falls back to the local estimate of the
   * current view rather than adding new items to a measurement of an old one.
   */
  readonly windowId: string | undefined;
};

export type CompactionEvent = { readonly kind: EventKind; readonly payload: JsonObject };

/**
 * Assembles the one description of the conversation both readers share.
 *
 * Called from the request builder and from the gap decision, so the two can
 * never disagree about which transcript they mean. A resumed turn's journal is
 * not part of it: the window that journal stored is already re-expressed into
 * the ledger by `adoptResumedWindow`, and keeping the records here as well would
 * be a second path to the same fact — one of them unused.
 */
export function promptContextFor(
  source: {
    readonly seedMessages: ReadonlyArray<ProviderMessage>;
    readonly transcript: Transcript;
    readonly compaction: CompactionLedger;
    readonly state: { readonly sessionId?: string };
    readonly budget: { readonly contextTokenLimit?: number };
    /** The last request's server-reported size, when one has reported. */
    readonly promptReport?: ReportedRequestBasis;
    readonly systemPrompt?: SystemPromptDirective;
    readonly systemPromptAppend?: string;
  },
  wiring: CompactionWiring | undefined,
  tools?: ToolPort,
): CompactionInput {
  return {
    seedMessages: source.seedMessages,
    transcript: source.transcript,
    ledger: source.compaction,
    wiring,
    sessionId: source.state.sessionId,
    contextTokenLimit: source.budget.contextTokenLimit,
    tools,
    reported: source.promptReport,
    ...(source.systemPrompt === undefined ? {} : { systemPrompt: source.systemPrompt }),
    ...(source.systemPromptAppend === undefined ? {} : { systemPromptAppend: source.systemPromptAppend }),
    ...(wiring === undefined ? {} : { toolResultProjection: "microcompact" as const }),
  };
}

/**
 * What the next provider request carries.
 *
 * No stored window — which includes "no wiring at all" — is byte for byte the
 * old path. With one, the replaced prefix is gone and its summary stands in for
 * it, followed by the live transcript: keeping both would mean the read-time
 * filter never ran, and keeping neither would send the model an invented empty
 * past.
 */
export function promptMessages(context: PromptContext): ReadonlyArray<ProviderMessage> {
  return promptViewMessages(context);
}
