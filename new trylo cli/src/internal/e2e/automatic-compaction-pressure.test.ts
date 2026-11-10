import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../loop/runner.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { emptyUsage, type ProviderEvent, type ProviderRequest } from "../ports/provider.js";
import { estimateMessagesTokens, estimateToolSpecsTokens } from "../compaction/token-estimate.js";
import type { CompactionWiring } from "../loop/compact-boundary.js";
import { wirePorts } from "../surface/cli/wiring.js";
import { createRunExecution } from "../surface/cli/run-execution-wiring.js";
import { testScratchPath } from "../testing/scratch.js";
import { mkdtempSync } from "node:fs";

async function changingHostRun(output: string, compaction?: CompactionWiring) {
  let authored = 0, preparations = 0, sends = 0;
  const measured: number[] = [];
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools(Array.from({ length: 30 }, () => toolResult({}, output)), [echoBinding({ needsApproval: false })]),
    compaction: compaction ?? compactionWiring({ nowMs: 0, summarize: () => {
      authored++;
      return "The prior checks finished. Continue remaining operations without repeating completed actions.";
    } }),
    provider: {
      async prepareRequest() {
        const context = { role: "system" as const, content: `Live host state: ${++preparations}\n` + "Stable host guidance. ".repeat(350) };
        return { apply: (request: ProviderRequest) => ({ ...request, messages: [...request.messages, context] }) };
      },
      async *stream(request): AsyncIterable<ProviderEvent> {
        sends++;
        // This fixture provider's declared tokenizer; not a claim about a real model.
        const tokens = estimateMessagesTokens(request.messages) + estimateToolSpecsTokens(request.tools);
        measured.push(tokens);
        yield { type: "usage", usage: { ...emptyUsage("snapshot"), inputTokens: tokens, totalTokens: tokens },
          inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens } };
        if (sends <= 30) {
          yield { type: "tool_call", toolCallId: `step-${sends}`, name: "echo", arguments: {} };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  }, { sessionId: "automatic-pressure", turnId: "task", correlationId: "c", model: "fixture",
    text: "Complete all thirty operations.", budget: { contextTokenLimit: 10_000 } });
  return { authored, preparations, sends, measured, result };
}

test("a changing host paragraph does not force paid summaries for an otherwise low-pressure task", async () => {
  const run = await changingHostRun("Step completed.");
  assert.equal(run.result.state.terminalReason, "completed");
  assert.equal(run.sends, 31);
  assert.ok(Math.max(...run.measured) < 4_000);
  assert.equal(run.authored, 0, "a byte upper bound and recharged host paragraph are not actual 90% context pressure");
  const decisions = run.result.envelopes.filter(event => event.payload.component === "prompt_budget");
  assert.ok(decisions.some(event => Number(event.payload.tokens) > 9_000), "the admission bound remains conservative");
  assert.ok(decisions.every(event => Number(event.payload.automaticTokens) < 9_000), "automatic maintenance records its separate estimate");
  assert.equal(run.preparations, run.sends, "preparation still occurs once per actual model request");
});

test("the actual CLI composition root enables the shipping automatic forecast", async () => {
  const workspaceRoot = mkdtempSync(testScratchPath("automatic-pressure-wire-"));
  const execution = createRunExecution(workspaceRoot, { shellIsolation: "host" });
  try {
    const wiring = wirePorts({ providerId: "fixture", model: "fixture", endpoint: "", apiKey: undefined,
      workspaceRoot, execution, permission: createFakePermission("approved"), compactSummary: "extractive" });
    if ("code" in wiring) assert.fail(wiring.code);
    const run = await changingHostRun("Step completed.", wiring.ports.compaction);
    assert.equal(run.sends, 31);
    assert.equal(run.result.state.terminalReason, "completed");
    assert.equal(run.result.envelopes.filter(event => event.payload.component === "compaction" && event.payload.status === "started").length, 0);
  } finally { await execution.close(); }
});

test("real growth still compacts repeatedly instead of staying locked after an earlier ineffective attempt", async () => {
  const run = await changingHostRun("Observed plain output. ".repeat(140));
  assert.equal(run.result.state.terminalReason, "completed");
  assert.equal(run.sends, 31);
  assert.ok(run.result.compactions.length >= 2, "new actual pressure must be able to reduce newly accumulated history");
  assert.ok(Math.max(...run.measured) < 10_000, "the fixture must compact before carrying its entire unbounded history forward");
  assert.equal(run.preparations, run.sends);
});
