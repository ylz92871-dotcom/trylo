import type { Envelope, JsonObject } from "../protocol/envelope.js";
import { emptyUsage } from "../ports/provider.js";
import type { ProviderEvent } from "../ports/provider.js";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
} from "./fakes.js";
import { runTurn, type LoopPorts, type RunTurnRequest, type RunTurnResult } from "./runner.js";

export const SCENARIO_NAMES = [
  "ordinary-stream",
  "tool-approve",
  "approval-deny",
  "tool-fail-repair",
  "streaming-cancel",
  "transport-unknown",
  "retry-new-attempt",
  "completed-unverified",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export async function runScenario(name: ScenarioName): Promise<RunTurnResult> {
  const ports = portsFor(name);
  return runTurn(ports, requestFor(name));
}

export async function runScenarioEnvelopes(name: ScenarioName): Promise<readonly Envelope[]> {
  const result = await runScenario(name);
  return result.envelopes;
}

function requestFor(name: ScenarioName): RunTurnRequest {
  const base = {
    sessionId: "ses-1",
    turnId: "trn-1",
    correlationId: "cor-1",
    text: name,
  };
  switch (name) {
    case "streaming-cancel":
      return { ...base, cancelAfter: "streaming" };
    case "retry-new-attempt":
      return { ...base, retryOnce: true };
    case "completed-unverified":
      return { ...base, verifyAfter: "fail" };
    default:
      return base;
  }
}

function textBlock(blockId: string, text: string): readonly ProviderEvent[] {
  return [
    { type: "text_start", blockId },
    { type: "text_delta", blockId, text },
    { type: "text_end", blockId },
  ];
}

function stopEvent(): ProviderEvent {
  return { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
}

function usageEvent(): ProviderEvent {
  return {
    type: "usage",
    usage: { ...emptyUsage("snapshot"), inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

/**
 * A provider stream that asked for tools still has to declare why it stopped.
 * Leaving `finish` out would model a provider that violates the contract, and
 * the turn loop would rightly treat the stream as unterminated.
 */
function toolCallFinish(): ProviderEvent {
  return { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
}

function toolCallEvent(
  toolCallId: string,
  name: string,
  args: JsonObject,
): readonly ProviderEvent[] {
  return [
    { type: "tool_input_start", toolCallId, name },
    { type: "tool_call", toolCallId, name, arguments: args },
    toolCallFinish(),
  ];
}

function midStreamLoss(): ProviderEvent {
  return {
    type: "error",
    class: "network",
    retryable: false,
    phase: "after_stream_started",
    message: "ack_lost",
  };
}

function portsFor(name: ScenarioName): LoopPorts {
  const profile = emptyProfileLoader();
  switch (name) {
    case "ordinary-stream":
    case "completed-unverified":
      return {
        profile,
        provider: createFakeProvider([
          [...textBlock("b1", "hello"), usageEvent(), stopEvent()],
        ]),
        tools: createFakeTools([]),
        permission: createFakePermission("approved"),
      };
    case "tool-approve":
      return {
        profile,
        provider: createFakeProvider([
          [...toolCallEvent("call-1", "echo", { text: "hi" })],
          [...textBlock("b2", "done"), stopEvent()],
        ]),
        tools: createFakeTools([toolResult({ echo: "hi" })]),
        permission: createFakePermission("approved"),
      };
    case "approval-deny": {
      let requests = 0;
      return {
        profile,
        provider: {
          async *stream(request) {
            requests += 1;
            if (requests === 1) {
              yield* toolCallEvent("call-1", "echo", { text: "no" });
              return;
            }

            const denied = request.messages.filter(message => message.role === "tool" && message.toolCallId === "call-1");
            if (denied.length !== 1 || !denied[0]?.content.includes("permission_denied")) {
              throw new Error("approval_denial_feedback_missing");
            }
            yield* textBlock("denial", "The requested call was denied and did not run.");
            yield stopEvent();
          },
        },
        tools: { ...createFakeTools([]), async execute() { throw new Error("denied_scenario_tool_executed"); } },
        permission: createFakePermission("denied"),
      };
    }
    case "tool-fail-repair":
      return {
        profile,
        provider: createFakeProvider([
          [...toolCallEvent("call-1", "echo", { text: "x" })],
          [...textBlock("b3", "repaired"), stopEvent()],
        ]),
        tools: createFakeTools([{ outcome: "error", code: "tool_error", message: "boom" }], [
          echoBinding({ needsApproval: false }),
        ]),
        permission: createFakePermission("approved"),
      };
    case "streaming-cancel":
      return {
        profile,
        provider: createFakeProvider([
          [
            { type: "text_start", blockId: "b4" },
            { type: "text_delta", blockId: "b4", text: "partial" },
            { type: "text_delta", blockId: "b4", text: "more" },
            { type: "text_end", blockId: "b4" },
            stopEvent(),
          ],
        ]),
        tools: createFakeTools([]),
        permission: createFakePermission("approved"),
      };
    case "transport-unknown":
      return {
        profile,
        provider: createFakeProvider([
          [...textBlock("b5", "..."), midStreamLoss()],
        ]),
        tools: createFakeTools([]),
        permission: createFakePermission("approved"),
      };
    case "retry-new-attempt":
      return {
        profile,
        provider: createFakeProvider([
          [midStreamLoss()],
          [...textBlock("b6", "retried"), stopEvent()],
        ]),
        tools: createFakeTools([]),
        permission: createFakePermission("approved"),
      };
    default: {
      const _never: never = name;
      throw new Error(`unknown scenario ${_never}`);
    }
  }
}
