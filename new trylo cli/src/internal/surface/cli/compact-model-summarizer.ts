import { preserveRequestObservations, summarizeTranscript, transcriptLines, validateSummary } from "../../compaction/summary.js";
import { estimateMessagesTokens } from "../../compaction/token-estimate.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { TranscriptItem } from "../../protocol/transcript.js";

/**
 * The `--compact-summary=model` author: one tool-free provider call whose text
 * becomes the compaction summary — and the reason the loop's `summarize` seam
 * may return a promise.
 *
 * Three load-bearing choices:
 *
 *  - **the fallback is the shipped default, not a failure.** If the provider
 *    errors, says nothing, overflows `SUMMARY_MAX_CHARS`, or authors text the
 *    disclosure scanner would refuse, the extractive digest is returned instead.
 *    A compaction's value is the *window* — losing the window over a bad summary
 *    would trade a real budget rescue for a hypothetical fluency gain, and the
 *    fallback path is not a downgrade below today's default behaviour;
 *  - **the request is inert.** No tools, one system instruction, the raw
 *    transcript lines as material. A summary request that could call a tool
 *    would be a second agent pretending to be a function;
 *  - **validation happens here *and* at the port.** Not double-checking the
 *    port — deciding the fallback while the choice is still open. By the time
 *    `compact` refuses, the window is already gone.
 */

/**
 * The `--compact-summary` closed set: who authors a compaction summary.
 * `extractive` is the shipped deterministic digest; `model` is this file. The
 * set lives with the author it selects, and `args-primitives.ts` borrows it
 * for parsing — one copy of the enumeration, same shape as `--ask`/`--learning`.
 */
export const COMPACT_SUMMARY_MODES = ["extractive", "model"] as const;
export type CompactSummaryMode = (typeof COMPACT_SUMMARY_MODES)[number];

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
  "Do not exceed a few short paragraphs.";

/** A 4000-character budget is roughly 1000 tokens; ask for no more than that. */
const MAX_SUMMARY_OUTPUT_TOKENS = 1024;

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
  requestTranscript?: ReadonlyArray<TranscriptItem>) => Promise<string> {
  return async (items, previousSummary, signal, requestTranscript) => {
    const authored = await requestSummary(input, items, previousSummary, signal);
    return validateSummary(authored).ok
      ? preserveRequestObservations(authored, requestTranscript ?? items, { hasPreviousSummary: previousSummary !== undefined })
      : summarizeTranscript(items, {
        ...(previousSummary === undefined ? {} : { previousSummary }),
        ...(requestTranscript === undefined ? {} : { requestTranscript }),
      });
  };
}

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
): Promise<string> {
  const request: ProviderRequest = {
    attemptId: SUMMARIZER_ATTEMPT_ID,
    model: input.model,
    messages: [
      { role: "system", content: SUMMARIZER_INSTRUCTION },
      { role: "user", content: [
        ...(previousSummary === undefined ? [] : [`Previous summary:\n${previousSummary}\n\nNew transcript:`]),
        ...transcriptLines(items),
      ].join("\n") },
    ],
    tools: [],
    maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
  };
  if (signal?.aborted) return "";
  // A rescue request cannot assume the overgrown history fits the model it
  // is rescuing. Preserve the existing extractive fallback without sending an
  // impossible auxiliary request or changing the main turn's ceiling.
  if (input.contextTokenLimit !== undefined &&
      estimateMessagesTokens(request.messages) + MAX_SUMMARY_OUTPUT_TOKENS > input.contextTokenLimit) return "";
  let text = "";
  for await (const event of input.provider.stream(request, signal ?? new AbortController().signal)) {
    if (signal?.aborted) return "";
    if (event.type === "text_delta") {
      text += event.text;
      continue;
    }
    if (event.type === "error" || event.type === "cancel_ack") return "";
    if (event.type === "finish") {
      return event.reason === "stop" && !event.requiresFollowUp ? text.trim() : "";
    }
  }
  return "";
}
