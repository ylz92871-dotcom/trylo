import { createCompactionService } from "../compaction/service.js";
import { summarizeTranscript } from "../compaction/summary.js";
import { boundMessagesTextTokens, boundToolSpecsTextTokens } from "../compaction/token-estimate.js";
import type { CompactionWiring } from "../loop/compact-boundary.js";
import type { ProviderPort } from "../ports/provider.js";

// Child prompt estimates include provider continuation overhead and the current tool set.
export function childCompaction(provider: ProviderPort): CompactionWiring {
  return {
    port: createCompactionService(),
    estimateAccuracy: "text_upper_bound",
    estimatePromptTokens: messages => boundMessagesTextTokens(messages) + (provider.continuation?.estimateOverheadTokens?.(messages) ?? 0),
    estimateTextPromptTokens: boundMessagesTextTokens,
    estimateOverheadTokens: tools => boundToolSpecsTextTokens(tools.snapshot().map(binding => ({ name: binding.name,
      description: binding.description, parameters: binding.parameters }))),
    summarize: (items, previousSummary, _signal, requestTranscript) => summarizeTranscript(items, {
      ...(previousSummary === undefined ? {} : { previousSummary }),
      ...(requestTranscript === undefined ? {} : { requestTranscript }),
    }),
    now: () => "1970-01-01T00:00:00.000Z",
  };
}
