import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage } from "../ports/provider.js";
import {
  createFakeCompaction,
  createFakePermission,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
} from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * WP09.3 / L06 — classified recovery from provider budget rejections.
 *
 * A provider that refuses the request itself — "prompt is too long", "image
 * too large" — used to fail the turn as an anonymous `provider_error`, even
 * though a compaction the loop already knows how to perform is exactly the
 * answer for the first case. The contract here:
 *
 *  - `prompt_too_long` before any output: one forced compaction, one retry of
 *    the same request under the stored window, still inside the same turn;
 *  - `media_too_large`: classified and reported, never "recovered" by
 *    silently dropping the user's attachment — the failure stays a failure;
 *  - another recovery requires measured prompt reduction and new history;
 *    a repeated rejection without progress remains an explicit failure.
 *
 * Written against the unfixed loop first (red evidence, WP09 交接记录): the
 * rejection failed the turn with no compaction and no retry.
 */

const ORIGINAL = "ORIGINAL-SEGMENT-MARKER";
const TOOL_OUTPUT = "TOOL-OUTPUT-MARKER";
const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "use the tool" };

function recordingProvider(script: ReadonlyArray<ReadonlyArray<import("../ports/provider.js").ProviderEvent>>): {
  readonly requests: import("../ports/provider.js").ProviderRequest[];
  readonly port: import("../ports/provider.js").ProviderPort;
} {
  const requests: import("../ports/provider.js").ProviderRequest[] = [];
  let index = 0;

  return {
    requests,
    port: {
      async *stream(request) {
        requests.push(request);
        const events = script[index] ?? [];
        index += 1;
        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

function portsOf(provider: ReturnType<typeof recordingProvider>["port"], compaction?: ReturnType<typeof createFakeCompaction>): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({ echo: "hi" }, TOOL_OUTPUT)], [
      echoBinding({ needsApproval: false }),
    ]),
    provider,
    ...(compaction === undefined ? {} : { compaction: compaction.wiring }),
  };
}

function messageText(request: import("../ports/provider.js").ProviderRequest | undefined): string {
  return (request?.messages ?? []).map((message) => message.content).join("\n");
}

function observationEnvelopes(result: Awaited<ReturnType<typeof runTurn>>) {
  return result.envelopes.filter((envelope) => envelope.kind === "observation");
}

const PROMPT_TOO_LONG = {
  type: "error",
  class: "invalid_request",
  retryable: false,
  phase: "before_headers",
  message: "This model's maximum context length is 8000 tokens; however, your prompt has 9000",
} as const;

function shrinkingCompaction() {
  const compaction = createFakeCompaction({ summary: "SUMMARY-MARKER" });
  return { ...compaction, wiring: { ...compaction.wiring,
    estimatePromptTokens: (messages: readonly import("../ports/provider.js").ProviderMessage[]) =>
      (messages.some(message => message.content.includes("SUMMARY-MARKER")) ? 500 : 1000)
      + messages.filter(message => message.role === "tool").length * 300,
  } };
}

test("a prompt-too-long rejection is answered by one forced compaction and one retry", async () => {
  const provider = recordingProvider([
    [PROMPT_TOO_LONG],
    [
      { type: "text_start", blockId: "b1" },
      { type: "text_delta", blockId: "b1", text: ORIGINAL },
      { type: "text_end", blockId: "b1" },
      { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
    ],
  ]);
  const compaction = shrinkingCompaction();
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  // Request 0 was refused; request 1 is the retry under the stored window.
  assert.equal(provider.requests.length, 2);
  assert.equal(result.compactions.length, 1);
  const retried = messageText(provider.requests[1]);

  assert.equal(retried.includes("SUMMARY-MARKER"), true, "the retry carries the summary");
  assert.equal(retried.includes(ORIGINAL), false, "the retry drops the replaced history");
});

test("a repeated rejection without a further reduction remains the provider's failure", async () => {
  const provider = recordingProvider([
    [PROMPT_TOO_LONG],
    [PROMPT_TOO_LONG],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const compaction = shrinkingCompaction();
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "failed");
  assert.equal(provider.requests.length, 2, "no smaller request can be made from the same unchanged history");
});

test("later prompt rejections can recover again after new work without a per-turn retry count", async () => {
  const toolRound = (id: string) => [
    { type: "tool_call", toolCallId: id, name: "echo", arguments: {} },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ] as const;
  // The newest tool exchange must remain live across compaction. Two new
  // exchanges provide older history that can actually shrink on each recovery.
  const provider = recordingProvider([[PROMPT_TOO_LONG], toolRound("first"), toolRound("second"), [PROMPT_TOO_LONG],
    toolRound("third"), toolRound("fourth"), [PROMPT_TOO_LONG], [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]]);
  const result = await runTurn(portsOf(provider.port, shrinkingCompaction()), {
    ...REQUEST, budget: { contextTokenLimit: 8000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(provider.requests.length, 8);
  assert.equal(result.compactions.length, 3);
});

test("a media-too-large rejection is reported by name and never retried", async () => {
  const provider = recordingProvider([
    [{
      type: "error",
      class: "invalid_request",
      retryable: false,
      phase: "before_headers",
      message: "image exceeds maximum allowed size: 12 MB",
    }],
  ]);
  const compaction = createFakeCompaction({ summary: "SUMMARY-MARKER" });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "failed");
  assert.equal(provider.requests.length, 1, "no compaction retry for media: dropping it would drop the user's words");
  assert.equal(result.compactions.length, 0);
  assert.equal(
    observationEnvelopes(result).some((envelope) => envelope.payload["reason"] === "media_too_large"),
    true,
    "the failure is classified as media_too_large, not an anonymous provider error",
  );
});

test("a spent dollar budget ends the turn with an explicit budget_usd_exhausted", async () => {
  // WP09.3/L07: priced usage is accumulated per stream, and a ceiling of one
  // cent is spent by the second stream's report. The failure names the money
  // ceiling — not an anonymous provider error — and the usage proves it.
  const provider = recordingProvider([
    [
      { type: "usage", usage: { ...emptyUsage("snapshot"), inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const compaction = createFakeCompaction({ summary: "SUMMARY-MARKER" });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, maxCostUsd: 0.01 },
    pricing: { inputPerMTok: 10, outputPerMTok: 10 },
  });

  assert.equal(result.state.terminalReason, "failed");
  const terminal = result.envelopes.filter((envelope) => envelope.kind === "terminal").at(-1);

  assert.equal(terminal?.payload["cause"], "budget_usd_exhausted");
  // One dollar of input at $10/MTok: the accumulated cost is visible.
  assert.equal(result.usage.inputTokens, 1_000_000);
});
