import { emptyUsage, mergeUsage, type ProviderPort } from "../ports/provider.js";
import type { SubagentContext } from "./types.js";
import { SubagentGovernanceError } from "./governance.js";

/** Charge each response before the loop can start another one in the same round. */
export function createGovernedChildProvider(provider: ProviderPort, context: SubagentContext): ProviderPort {
  return {
    ...(provider.continuation === undefined ? {} : { continuation: provider.continuation }),
    async *stream(request, signal) {
      if (context.remainingTokens?.() === 0) throw new SubagentGovernanceError("token_budget_exhausted", "Subagent has no remaining token allowance");
      let usage = emptyUsage();
      let recorded = false;
      const record = (): void => {
        recorded = true;
        context.recordUsage(usage.inputTokens, usage.outputTokens);
      };
      try {
        for await (const event of provider.stream(request, signal)) {
          if (event.type === "usage") usage = mergeUsage(usage, event.usage);
          if (event.type === "finish" || event.type === "error" || event.type === "cancel_ack") record();
          yield event;
        }
      } finally {
        // A disconnected or interrupted response still owes the usage already
        // observed. The loop may stop pulling immediately after a terminal.
        if (!recorded) record();
      }
    },
  };
}
