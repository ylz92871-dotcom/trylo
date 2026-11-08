import { createCompactionService } from "../../compaction/service.js";
import { summarizeTranscript } from "../../compaction/summary.js";
import {
  CHARS_PER_TOKEN,
  boundMessagesTextTokens,
  boundToolSpecsTextTokens,
  estimateMessagesTokens,
  estimateToolSpecsTokens,
} from "../../compaction/token-estimate.js";
import type { CompactionWiring } from "../../loop/compact-boundary.js";
import type { CompactRecordDraft } from "../../ports/compaction.js";
import type { ProviderMessage, ProviderToolSpec } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import type { RunTurnResult } from "../../loop/runner.js";

/**
 * The CLI's compaction assembly — the one place the shipping loops get wired.
 *
 * Three facts here are load-bearing:
 *
 *  - **the summarizer defaults to the shipped one.** `summarizeTranscript`
 *    scrubs as it builds, so a summary that reaches the `system` role has
 *    already been filtered. `--compact-summary=model` replaces the *author*,
 *    not the gate: whatever is authored still passes `validateSummary` at the
 *    port, so a composition root can never smuggle an unchecked string in;
 *  - **the estimator is pure.** It is a function of the messages alone: no
 *    clock, no disk, no second switch on message count. The single ceiling stays
 *    `budget.contextTokenLimit`, so this number is comparable to it;
 *  - **the loop stores nothing.** `runTurn` hands back drafts and the caller
 *    appends them. The `CompactionWiring` type is the loop's; this module only
 *    binds it to real implementations.
 */

/** Four characters per token: coarse, deterministic, and the same everywhere. */
export { CHARS_PER_TOKEN };

/**
 * A pure estimate of the textual part of the next request.
 *
 * Message text and tool-call argument JSON count locally. Image encoding
 * bytes are transport size, not a model's context-token formula: visual
 * usage remains unknown until a provider measures it. The
 * mechanical rule lives in `compaction/token-estimate.ts`; this re-export
 * keeps the wiring the one place the loop reads the estimate from.
 * This legacy display estimate is not a tokenizer. Admission uses the
 * separate byte-level text bound below, including for new text appended to
 * a measured server prefix.
 */
export function estimatePromptTokens(messages: ReadonlyArray<ProviderMessage>): number {
  return estimateMessagesTokens(messages);
}

/** Admission uses a byte-level text upper bound; display estimates keep their
 * existing compression heuristic. Neither value includes unknown image or
 * provider-template tokens. */
export { boundMessagesTextTokens };

/**
 * The token estimate for the tool table a request carries beside its messages
 * (`tools` on the wire). The wiring hands it to the loop as request overhead
 * so the gap's threshold comparison covers the whole request, not just the
 * conversation.
 */
export function estimateToolTableTokens(tools: ToolPort): number {
  return estimateToolSpecsTokens(toolTableText(tools));
}

export function boundToolTableTextTokens(tools: ToolPort): number {
  return boundToolSpecsTextTokens(toolTableText(tools));
}

function toolTableText(tools: ToolPort): ReadonlyArray<ProviderToolSpec> {
  let bindings;

  try {
    bindings = tools.snapshot();
  } catch {
    // An unreadable catalog sends no table either (`toolSpecs` in request.ts
    // fails closed the same way), so empty material is the consistent answer.
    return [];
  }

  return bindings.map((binding) => ({
    name: binding.name,
    description: binding.description,
    parameters: binding.parameters,
  }));
}

export type CompactionWiringInput = {
  readonly estimateAccuracy?: CompactionWiring["estimateAccuracy"];
  /**
   * The token basis. The shipped one is {@link boundMessagesTextTokens}: a pure
   * function of the messages the next request would carry. A test may pin a
   * constant to put the run on either side of the threshold.
   */
  readonly estimatePromptTokens?: (messages: ReadonlyArray<ProviderMessage>) => number;
  readonly estimateTextPromptTokens?: (messages: ReadonlyArray<ProviderMessage>) => number;
  /**
   * The tool table's token cost, on top of the messages. Defaults to the
   * shipped {@link boundToolTableTextTokens} so the gap's threshold covers the
   * whole request; a test may pin a constant.
   */
  readonly estimateOverheadTokens?: (tools: ToolPort) => number;
  /** Milliseconds since the epoch, from the host's clock. */
  readonly nowMs: number;
  /** Overridable only so a test can pin the stamped time. */
  readonly at?: string;
  /**
   * The summary author. Defaults to the shipped extractive summarizer; a test
   * may inject a hostile string to prove the refusal path. `--compact-summary
   * =model` passes the model author from `wiring.ts` — authoring may await the
   * provider there, which is why the seam accepts a promise.
   */
  readonly summarize?: CompactionWiring["summarize"];
};

/**
 * Binds the loop's `CompactionWiring` to the shipping service.
 *
 * The estimator defaults to the pure shipped one. It reads nothing but the
 * messages it is handed, so the number it produces is comparable with
 * `budget.contextTokenLimit` on the same run, and two runs over the same prompt
 * cannot disagree about it.
 */
export function compactionWiring(input: CompactionWiringInput): CompactionWiring {
  const estimateText = input.estimateTextPromptTokens ?? (input.estimatePromptTokens === undefined ? boundMessagesTextTokens : undefined);
  const estimateAccuracy = input.estimateAccuracy ?? (input.estimatePromptTokens === undefined ? "text_upper_bound" : undefined);

  return {
    port: createCompactionService(),
    ...(estimateAccuracy === undefined ? {} : { estimateAccuracy }),
    estimatePromptTokens: input.estimatePromptTokens ?? boundMessagesTextTokens,
    ...(estimateText === undefined ? {} : { estimateTextPromptTokens: estimateText }),
    estimateOverheadTokens: input.estimateOverheadTokens ?? boundToolTableTextTokens,
    estimateRequestOverheadTokens: request => boundToolSpecsTextTokens(request.tools),
    summarize: input.summarize ?? ((items, previousSummary, _signal, requestTranscript) => summarizeTranscript(items, {
      ...(previousSummary === undefined ? {} : { previousSummary }),
      ...(requestTranscript === undefined ? {} : { requestTranscript }),
    })),
    now: () => input.at ?? new Date(input.nowMs).toISOString(),
  };
}

/**
 * The drafts a run produced, in the order they were stored.
 *
 * The loop carries them out rather than writing them, so this is the handle a
 * caller needs to append them. Kept here so the CLI has one accessor for the
 * fact, not a field read scattered across the host.
 */
export function compactRecordsOf(result: RunTurnResult): readonly CompactRecordDraft[] {
  return result.compactions;
}
