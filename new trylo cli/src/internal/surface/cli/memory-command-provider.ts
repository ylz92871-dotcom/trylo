import { localMemoryPlan, memoryCommandReply, memoryRevisionSelection } from "./memory-local-plan.js";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import type { ToolOutcome } from "../../ports/tools.js";
import type { TurnHostInput } from "./host.js";
import type { Wiring, WiringFailure } from "./wiring.js";

/** Local command interpreter, explicitly identified as local rather than billed as model output.
 * It still uses the normal tool, permission, journal and cancellation path. No direct store writes.
 */
export function memoryCommandWiring(wiring: Wiring | WiringFailure, input: TurnHostInput): Wiring | WiringFailure {
  if ("code" in wiring) return wiring;

  const previous = input.resumeTranscript?.filter((item) => item.kind === "user").at(-1);
  const plan = localMemoryPlan(input.text, previous?.kind === "user" ? previous.text : undefined);
  if (plan === undefined) return wiring;

  let nextStep = 0, pendingCallId: string | undefined, outcome: ToolOutcome | undefined;
  const provider: ProviderPort = {
    async *stream(request, signal): AsyncIterable<ProviderEvent> {
      if (signal.aborted) {
        yield { type: "cancel_ack" };
        return;
      }

      yield { type: "stream_start", providerId: "trylo-memory-command", model: "local", warnings: [] };
      let step = plan.steps[nextStep];
      let refusal: string | undefined;
      const revision = plan.kind === "correct" || plan.kind === "retract";
      if (revision && nextStep === 1 && outcome?.outcome === "result") {
        const selected = memoryRevisionSelection(plan, outcome);
        if (selected.kind === "ready") step = selected.step;
        else refusal = selected.message;
      }

      const canContinue = nextStep === 0 || outcome?.outcome === "result";
      if (step !== undefined && canContinue && input.userLearning !== undefined && request.tools.some((tool) => tool.name === step.name)) {
        pendingCallId = `memory-command:${input.turnId}:${nextStep++}`;
        outcome = undefined;

        if (step.name !== "memory_search") {
          // Permission denial is terminal in the execution loop, so no later
          // provider call can manufacture a receipt for an unexecuted tool.
          yield { type: "text_start", blockId: "memory-permission" };
          const action = step.name === "memory_correct" ? "更正" : step.name === "memory_forget" ? "撤回" : "保存";
          yield { type: "text_delta", blockId: "memory-permission", text: `尚未${action}，正在核验本次正式记忆操作的权限。` };
          yield { type: "text_end", blockId: "memory-permission" };
        }

        yield { type: "tool_call", toolCallId: pendingCallId, name: step.name, arguments: step.arguments };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };

        return;
      }

      const saved = nextStep === (revision ? 2 : plan.steps.length) && outcome?.outcome === "result";
      const text = refusal ?? memoryCommandReply(plan, saved ? outcome : outcome?.outcome === "result" ? undefined : outcome, input.userLearning !== undefined);

      yield { type: "text_start", blockId: "memory-receipt" };
      yield { type: "text_delta", blockId: "memory-receipt", text };
      yield { type: "text_end", blockId: "memory-receipt" };
      yield { type: "usage", usage: emptyUsage() };

      if (!saved && input.userLearning !== undefined) {
        yield { type: "error", class: "invalid_request", retryable: false, phase: "after_stream_started", message: "memory_command_not_saved" };
      } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const tools = wiring.ports.tools;

  return { ...wiring, providerId: "trylo-memory-command", model: "local", ports: { ...wiring.ports, provider,
    tools: { ...tools, async execute(call, signal) {
      const result = await tools.execute(call, signal);
      if (call.toolCallId === pendingCallId) outcome = result;
      return result;
    } },
  } };
}
