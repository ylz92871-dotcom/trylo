import { preserveRequestObservations, publicSummaryHistory, summaryAuthorCharacterAllowance, summarizeTranscript, transcriptLines, validateSummary } from "../../compaction/summary.js";
import { CHARS_PER_TOKEN, estimateMessagesTokens } from "../../compaction/token-estimate.js";
import { emptyUsage, mergeUsage, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import { SUMMARY_MAX_CHARS, type SummaryAuthorFallbackReason, type SummaryAuthorReporter,
  type SummaryAuthoringContext, type SummaryRequestUsage } from "../../ports/compaction.js";
import type { TranscriptItem } from "../../protocol/transcript.js";

/**
 * The `--compact-summary=model` author: one tool-free provider call whose text
 * becomes the compaction summary — and the reason the loop's `summarize` seam
 * may return a promise.
 *
 * Three load-bearing choices:
 *
 *  - **preserve a deterministic fallback for budget rescue.** If the provider
 *    errors, says nothing, overflows `SUMMARY_MAX_CHARS`, or authors text the
 *    disclosure scanner would refuse, the extractive digest is returned instead.
 *    Returning an extractive digest keeps budget rescue available when model
 *    authoring fails. It does not guarantee equivalent semantic fidelity to a
 *    successful model-authored summary;
 *  - **the request is inert.** No tools, one system instruction, the raw
 *    transcript lines as material. A summary request that could call a tool
 *    would be a second agent pretending to be a function;
 *  - **validation happens here *and* at the port.** Not double-checking the
 *    port — deciding the fallback while the choice is still open. By the time
 *    `compact` refuses, the window is already gone.
 */

/**
 * The `--compact-summary` closed set: who authors a compaction summary.
 * `extractive` is the deterministic fallback; `model` is the CLI default. The
 * set lives with the author it selects, and `args-primitives.ts` borrows it
 * for parsing — one copy of the enumeration, same shape as `--ask`/`--learning`.
 */
export const COMPACT_SUMMARY_MODES = ["extractive", "model"] as const;

export type CompactSummaryMode = (typeof COMPACT_SUMMARY_MODES)[number];

export const DEFAULT_COMPACT_SUMMARY_MODE: CompactSummaryMode = "model";

export function isCompactSummaryMode(value: string): value is CompactSummaryMode {
  return (COMPACT_SUMMARY_MODES as readonly string[]).includes(value);
}

/**
 * The instruction the summarizer call carries. It opens with a fixed marker so
 * a reader of the wire (the black-box test, or a person with a proxy log) can
 * tell a summary request from a turn request at a glance.
 */
export const SUMMARIZER_INSTRUCTION =
  "You are the trylo compaction summarizer. Summarize the coding-agent session " +
  "transcript that follows into one short plain-text passage: the user's goal, " +
  "what was decided, the file and tool facts that still matter, and any open " +
  "thread. Merge the previous summary with the new transcript; retain standing " +
  "constraints, unfinished steps, and verification results. Do not include absolute paths, credentials, or key=value secrets. " +
  `Do not exceed ${SUMMARY_MAX_CHARS} characters in total. Keep the summary concise while retaining the required facts.`;

/** At most three UTF-8 bytes per valid UTF-16 code unit, measured with the same
 * coarse estimator as the prompt. This reserves context for the persisted
 * character contract; it is not an accurate tokenizer bound or a generation cap. */
const SUMMARY_OUTPUT_RESERVATION_TOKENS = Math.ceil(SUMMARY_MAX_CHARS * 3 / CHARS_PER_TOKEN);

/** The request's correlation name; the summarizer is one call, not a turn. */
const SUMMARIZER_ATTEMPT_ID = "compact-summary";

export type ModelSummarizerInput = {
  readonly provider: ProviderPort;
  readonly model: string;
  /** The same resolved context ceiling as the main turn, including output reservation. */
  readonly contextTokenLimit?: number;
};

export function createModelSummarizer(
  input: ModelSummarizerInput,
): (items: ReadonlyArray<TranscriptItem>, previousSummary?: string, signal?: AbortSignal,
  requestTranscript?: ReadonlyArray<TranscriptItem>, report?: SummaryAuthorReporter, authoring?: SummaryAuthoringContext) => Promise<string> {
  return async (items, previousSummary, signal, requestTranscript, report, authoring) => {
    const authorChars = summaryAuthorCharacterAllowance(requestTranscript ?? items, { hasPreviousSummary: previousSummary !== undefined });
    const attempt = await requestSummary(input, items, previousSummary, signal, authoring, authorChars);
    let reason: SummaryAuthorFallbackReason;

    if (attempt.kind === "completed") {
      const validation = validateSummary(attempt.text);
      if (validation.ok && attempt.text.length <= authorChars) {
        const summary = preserveRequestObservations(attempt.text, requestTranscript ?? items, { hasPreviousSummary: previousSummary !== undefined });
        report?.({ author: "model" });
        return summary;
      }

      if (validation.ok) reason = "summary_too_long";
      else switch (validation.code) {
        case "summary_empty": reason = "empty_output"; break;
        case "summary_too_long":
        case "summary_unsafe": reason = validation.code; break;
        default: throw new Error(`unexpected_summary_validation:${validation.code}`);
      }
    } else reason = attempt.reason;

    const summary = summarizeTranscript(items, {
      ...(previousSummary === undefined ? {} : { previousSummary }),
      ...(requestTranscript === undefined ? {} : { requestTranscript }),
    });

    report?.({ author: "extractive", reason });

    return summary;
  };
}

type SummaryAttempt =
  | { readonly kind: "completed"; readonly text: string }
  | { readonly kind: "fallback"; readonly reason: SummaryAuthorFallbackReason };

/**
 * One stream, no tools. Only an explicit normal stop commits the accumulated
 * text. Errors, cancellation, truncated finishes and EOF discard it, because
 * syntactically valid partial text does not prove completed authoring.
 * Provider-port exceptions still propagate; they are not success or typed
 * provider failures to silently turn into a summary.
 */
async function requestSummary(
  input: ModelSummarizerInput,
  items: ReadonlyArray<TranscriptItem>,
  previousSummary: string | undefined,
  signal?: AbortSignal,
  authoring?: SummaryAuthoringContext,
  authorChars = SUMMARY_MAX_CHARS,
): Promise<SummaryAttempt> {
  const request: ProviderRequest = {
    attemptId: SUMMARIZER_ATTEMPT_ID,
    model: input.model,
    messages: [
      { role: "system", content: SUMMARIZER_INSTRUCTION },
      { role: "user", content: [
        ...(authorChars === SUMMARY_MAX_CHARS ? [] : [
          `Your passage must fit within ${authorChars} characters. The remaining space in the ${SUMMARY_MAX_CHARS}-character stored checkpoint is reserved for canonical request observations.`,
        ]),
        ...(previousSummary === undefined ? [] : [`Previous summary:\n${publicSummaryHistory(previousSummary)}\n\nNew transcript:`]),
        ...transcriptLines(items),
      ].join("\n") },
    ],
    tools: [],
    ...(authoring?.maxOutputTokens === undefined ? {} : { maxOutputTokens: authoring.maxOutputTokens }),
  };

  if (signal?.aborted) return { kind: "fallback", reason: "cancelled" };

  if (authoring?.maxOutputTokens !== undefined && authoring.maxOutputTokens <= 0) {
    return { kind: "fallback", reason: "caller_budget_exhausted" };
  }

  // A rescue request cannot assume the overgrown history fits the model it
  // is rescuing. Preserve the existing extractive fallback without sending an
  // impossible auxiliary request or changing the main turn's ceiling.
  if (input.contextTokenLimit !== undefined &&
      estimateMessagesTokens(request.messages) + SUMMARY_OUTPUT_RESERVATION_TOKENS > input.contextTokenLimit) {
    return { kind: "fallback", reason: "input_context_exceeded" };
  }

  let text = "", usage = emptyUsage(), sawUsage = false, terminal = false;
  let outcome: SummaryRequestUsage["outcome"] = "incomplete";

  try {
    for await (const event of input.provider.stream(request, signal ?? new AbortController().signal)) {
      // Account a bill already delivered with a cancellation before discarding
      // output; snapshots replace and deltas add through the existing owner.
      if (event.type === "usage") {
        usage = mergeUsage(usage, event.usage);
        sawUsage = true;
      }

      if (signal?.aborted) {
        outcome = "cancelled";
        return { kind: "fallback", reason: "cancelled" };
      }

      if (event.type === "text_delta") {
        text += event.text;
        continue;
      }

      if (event.type === "cancel_ack") {
        outcome = "cancelled";
        return { kind: "fallback", reason: "cancelled" };
      }

      if (event.type === "error") {
        outcome = event.class === "cancelled" ? "cancelled" : "failed";
        return { kind: "fallback", reason: event.class === "cancelled" ? "cancelled" : "provider_error" };
      }

      if (event.type === "finish") {
        terminal = true;
        if (event.reason === "length") {
          outcome = "truncated";
          return { kind: "fallback", reason: "output_truncated" };
        }
        if (event.reason === "stop" && !event.requiresFollowUp) {
          outcome = "completed";
          return { kind: "completed", text: text.trim() };
        }
        outcome = "failed";
        return { kind: "fallback", reason: "invalid_finish" };
      }
    }

    if (signal?.aborted) outcome = "cancelled";

    return { kind: "fallback", reason: signal?.aborted ? "cancelled" : "missing_finish" };
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    await authoring?.reportRequest({ purpose: "compaction_summary", outcome,
      usageStatus: sawUsage ? terminal ? "reported" : "partial" : "missing",
      ...(sawUsage ? { usage } : {}) });
  }
}
