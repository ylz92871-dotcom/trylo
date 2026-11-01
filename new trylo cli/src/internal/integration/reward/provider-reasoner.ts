import type { ProviderPort } from "../../ports/provider.js";
import type { RewardReasonerPort } from "../../learning/reward/ports.js";

/** Explicit invocation only. Fork isolation prevents appraisal from consuming execution continuation state. */
export function createProviderRewardReasoner(provider: ProviderPort, model: string): RewardReasonerPort {
  return { interpret: async input => {
    if (provider.fork === undefined) throw new Error("reward_provider_isolation_unavailable");
    const isolated = provider.fork([]);
    if (isolated === provider) throw new Error("reward_provider_isolation_unavailable");
    let text = "";
    let completed = false;
    for await (const event of isolated.stream({ attemptId: input.requestId, model, tools: [],
      messages: [{ role: "system", content: input.prompt }], maxOutputTokens: input.maxOutputTokens }, input.signal)) {
      if (input.signal.aborted) throw new Error("learning_aborted");
      if (event.type === "text_delta") text += event.text;
      if (text.length > 8192) throw new Error("reward_reasoner_output_limit");
      if (event.type === "error") throw new Error("reward_reasoner_failed");
      if (event.type === "tool_call") throw new Error("reward_reasoner_tool_forbidden");
      if (event.type === "finish") {
        if (event.reason !== "stop") throw new Error("reward_reasoner_incomplete");
        completed = true;
      }
    }
    if (!completed || input.signal.aborted) throw new Error("reward_reasoner_incomplete");
    return text;
  } };
}
