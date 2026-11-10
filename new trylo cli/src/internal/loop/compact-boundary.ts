import type {
  CompactionPort,
  SummaryAuthorReporter,
  SummaryAuthoringContext,
} from "../ports/compaction.js";
import type { CompleteInputTokenObservation, ProviderMessage, ProviderRequest, ProviderToolSpec, SystemPromptDirective } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { EventKind } from "../protocol/kinds.js";
import type { Transcript, TranscriptItem } from "../protocol/transcript.js";
import type { CompactionLedger } from "./compact-ledger.js";
import { promptViewMessages } from "./prompt-view.js";
import type { PromptMeasurement } from "./prompt-measurement.js";

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
 *  - **one request view, distinct evidence**. Automatic maintenance uses a
 *    calibrated text forecast over the actual prepared view. Admission keeps
 *    its separate conservative bound/complete-measurement contract. A soft
 *    estimate cannot prove hard overflow or replace the hard gate's basis.
 *    Both use the caller's same `budget.contextTokenLimit`; no count/timer cap;
 *  - **one ceiling**. The limit is the budget's, not a second copy here. A port
 *    injected without a configured ceiling therefore never compacts, because
 *    there is nothing to be over;
 *  - **growth-driven probes, and a bounded rescue**. A hold leaves the probe
 *    available. A window that clears the ceiling rearms it for later growth;
 *    refused or ineffective authoring latches the current pressure episode. The
 *    ceiling rescue (`budget-gate.ts`) may force a new window whenever
 *    the provider's report proves the view over the ceiling;
 *  - **compaction never cancels the hard gate**. The post-cut admission basis
 *    remains distinct from the displayed forecast. Complete measured overflow
 *    and real provider rejection keep their existing refusal/recovery owners;
 *  - **fail closed**. A refused summary stores no window, replaces no history
 *    and is reported as a degradation — silently dropping the replaced text
 *    without a summary would invent a shorter past;
 *  - the loop **appends nothing to disk**. `compact` hands back a draft, the
 *    loop carries it out on the turn result, and the single writer of the
 *    journal stays the session store.
 */

export type CompactionWiring = {
  readonly port: CompactionPort;
  /** Automatic maintenance uses an estimate, not a worst-case byte bound.
   * This does not supply evidence for a hard context refusal. */
  readonly estimateAutomaticTokens?: (messages: readonly ProviderMessage[], tools: readonly ProviderToolSpec[]) => number;
  /** A text upper bound can trigger compaction, but exceeding it cannot prove
   * the actual request exceeds the model window. Absent retains the existing
   * caller-supplied estimator contract. */
  readonly estimateAccuracy?: "text_upper_bound";
  /** Pure estimate over the messages the next provider request would carry. */
  readonly estimatePromptTokens: (messages: ReadonlyArray<ProviderMessage>) => number;
  /** Text-only additions; native additions must be priced in the full lookup. */
  readonly estimateTextPromptTokens?: (messages: ReadonlyArray<ProviderMessage>) => number;
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
   * it is not additional material to resend in an auxiliary provider request.
   * The optional reporter carries author metadata, never summary content. */
  readonly summarize: (items: ReadonlyArray<TranscriptItem>, previousSummary?: string, signal?: AbortSignal,
    requestTranscript?: ReadonlyArray<TranscriptItem>, report?: SummaryAuthorReporter,
    authoring?: SummaryAuthoringContext) => string | Promise<string>;
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
  /** Actual prepared request table; absent retains the legacy forecast seam. */
  readonly estimateRequestOverheadTokens?: (request: ProviderRequest) => number;
  /** Stamps the durable draft. The loop owns no clock, so the host lends one. */
  readonly now: () => string;
};

/** The conversation as it stands, from the side that builds a request. */
export type PromptContext = {
  readonly seedMessages: ReadonlyArray<ProviderMessage>;
  readonly transcript: Transcript;
  readonly ledger: CompactionLedger;
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
  /** Optional validated compact identity restored from a completed stream. */
  readonly storedInputBasis?: import("../ports/prompt-input.js").StoredPromptInputBasisV1;
  readonly promptTokens: number;
  readonly inputTokenObservation?: CompleteInputTokenObservation;
  /** Transcript high-water at sampling; projection identity controls reuse. */
  readonly transcriptLength: number;
  /** The actual measured request, required before its usage can be reused. */
  readonly measurement?: PromptMeasurement;
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
