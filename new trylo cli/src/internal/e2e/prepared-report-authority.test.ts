import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

for (const prepared of [false, true]) {
  test(`${prepared ? "prepared" : "ordinary"} requests retain a valid server prompt measurement above the soft limit`, async () => {
    const requests: ProviderRequest[] = [];
    const provider: ProviderPort = {
      ...(prepared ? { async prepareRequest() {
        const host = { role: "system" as const, content: "STABLE_PREPARED_HOST_CONTEXT" };
        return { apply: (request: ProviderRequest) => ({ ...request, messages: [host, ...request.messages] }) };
      } } : {}),
      async *stream(request) {
        const first = requests.length === 0;

        requests.push(request);
        yield { type: "usage", usage: { mode: "snapshot", inputTokens: first ? 950 : 100,
          outputTokens: 10, totalTokens: first ? 960 : 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

        if (first) {
          yield { type: "tool_call", toolCallId: "inspect", name: "echo", arguments: {} };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        } else {
          yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        }
      },
    };
    const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      tools: createFakeTools([toolResult({}, "The latest inspection completed.")], [echoBinding({ needsApproval: false })]),
      compaction: compactionWiring({ nowMs: 0, summarize: () => "Older completed observations." }),
    }, { sessionId: "prepared-measurement", turnId: "turn", correlationId: "test", text: "Inspect the current record and continue.",
      budget: { contextTokenLimit: 1_000 }, resumedTranscript: [
        { kind: "user", sequence: 0, text: "An earlier completed task." },
        { kind: "assistant_text", sequence: 1, blockId: "old", text: "OLD_ASSISTANT_OBSERVATIONS " + "known observation ".repeat(45) },
      ] });

    assert.equal(result.state.terminalReason, "completed");
    assert.equal(requests.length, 2);
    assert.ok(result.compactions.length > 0,
      "the unchanged measured prefix already used 950/1000 tokens, so it must retain its server authority above the 90% trigger");
  });
}

for (const mode of ["stable_tail", "changed_host", "changed_tools"] as const) {
  test(`${mode} presentation ${mode === "stable_tail" ? "preserves" : "invalidates"} the previous server request basis`, async () => {
    const requests: ProviderRequest[] = [];
    let preparations = 0;
    const provider: ProviderPort = {
      async prepareRequest(request) {
        const preparation = ++preparations;
        const host = { role: "system" as const,
          content: mode === "changed_host" && preparation > 1 ? "CHANGED_HOST_CONTEXT" : "STABLE_TRAILING_HOST_CONTEXT" };
        const tools = request.tools.map(tool => mode === "changed_tools"
          ? { ...tool, description: preparation === 1 ? "Original tool presentation." : "Changed tool presentation." } : tool);
        return { apply: base => ({ ...base, tools, messages: [...base.messages, host] }) };
      },
      async *stream(request) {
        const first = requests.length === 0;

        requests.push(request);
        yield { type: "usage", usage: { mode: "snapshot", inputTokens: first ? 950 : 100,
          outputTokens: 10, totalTokens: first ? 960 : 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

        if (first) {
          yield { type: "tool_call", toolCallId: "inspect", name: "echo", arguments: {} };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        } else {
          yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        }
      },
    };
    const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      tools: createFakeTools([toolResult({}, "The latest inspection completed.")], [echoBinding({ needsApproval: false })]),
      compaction: compactionWiring({ nowMs: 0, summarize: () => "Older completed observations." }),
    }, { sessionId: "trailing-host-measurement", turnId: "turn", correlationId: "test", text: "Inspect the current record and continue.",
      budget: { contextTokenLimit: 1_000 }, resumedTranscript: [
        { kind: "user", sequence: 0, text: "An earlier completed task." },
        { kind: "assistant_text", sequence: 1, blockId: "old", text: "OLD_ASSISTANT_OBSERVATIONS " + "known observation ".repeat(45) },
      ] });

    assert.equal(result.state.terminalReason, "completed");
    assert.equal(requests.length, 2);
    assert.equal(preparations, 2, "compaction must not re-read the prepared host state");
    assert.equal(result.compactions.length > 0, mode === "stable_tail",
      "retained messages in order keep measured authority; changed host or actual schema cannot inherit that measurement");
  });
}
