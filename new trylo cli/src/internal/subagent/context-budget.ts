import { createCompactionService } from "../compaction/service.js";
import { summarizeTranscript } from "../compaction/summary.js";
import { estimateMessagesTokens, estimateToolSpecsTokens } from "../compaction/token-estimate.js";
import type { CompactionWiring } from "../loop/compact-boundary.js";
import type { ProviderPort } from "../ports/provider.js";

/** A finite fallback for embeddings without declared model metadata. Production
 * passes its resolved context ceiling; the cumulative task budget is separate.
 */
export const DEFAULT_CHILD_CONTEXT_TOKENS = 32_000;

export function childCompaction(provider: ProviderPort): CompactionWiring {
  return {
    port: createCompactionService(),
    estimatePromptTokens: messages => estimateMessagesTokens(messages) + (provider.continuation?.estimateOverheadTokens?.(messages) ?? 0),
    estimateOverheadTokens: tools => estimateToolSpecsTokens(tools.snapshot().map(binding => ({ name: binding.name,
      description: binding.description, parameters: binding.parameters }))),
    summarize: (items, previousSummary, _signal, requestTranscript) => summarizeTranscript(items, {
      ...(previousSummary === undefined ? {} : { previousSummary }),
      ...(requestTranscript === undefined ? {} : { requestTranscript }),
    }),
    now: () => "1970-01-01T00:00:00.000Z",
  };
}
