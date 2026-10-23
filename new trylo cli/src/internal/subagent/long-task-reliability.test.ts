import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import { createChildAttemptWorker } from "./child-attempt.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import { SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";

const tools: ToolPort = { snapshot: () => [],
  execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected tool" }), cancel: async () => {} };
const permission = { request: async () => { throw new Error("unexpected approval"); },
  awaitDecision: async () => { throw new Error("unexpected approval"); } };

function* responseUsage(): Generator<ProviderEvent> {
  yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 40, outputTokens: 5, totalTokens: 45 } };
  yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 70, outputTokens: 15, totalTokens: 85 } };
  yield { type: "usage", usage: { ...emptyUsage("delta"), inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
}

for (const kind of ["delegate", "interactive"] as const) {
  test(`${kind}: a multi-request child stops before another provider call after its token budget is exceeded`, async () => {
    let requests = 0;
    const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
      requests += 1;
      yield* responseUsage();
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: requests < 8 };
    } };
    const options = { provider, permission, model: "test", budget: { maxIterations: 10 } };
    const worker = kind === "delegate" ? createChildAttemptWorker({ ...options, prompt: "continue" })
      : createInteractiveChildWorker({ ...options, message: "continue" });
    const runtime = new SubagentRuntime({ tools, governance: new SubagentGovernanceTracker({ tokenBudget: 250, timeoutMs: 0 }) });
    const handle = runtime.spawn<unknown>({ name: kind, worker, permissions: { allowedTools: [] },
      lineage: { parentAgentId: "parent", rootAttemptId: "root" } });
    const result = await handle.wait();
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "token_budget_exhausted");
    assert.equal(requests, 3, "the third completed response crosses the budget; a fourth request must not start");
    assert.deepEqual(result.usage, { inputTokens: 240, outputTokens: 60 }, "snapshots replace and deltas add within each response, once");
    assert.equal(runtime.getActiveInstances().length, 0);
  });

  test(`${kind}: cancelling a long round retains usage from earlier completed responses`, async () => {
    let requests = 0;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { started = resolve; });
    const provider: ProviderPort = { async *stream(_request, signal): AsyncIterable<ProviderEvent> {
      requests += 1;
      if (requests === 2) {
        started();
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        return;
      }
      yield* responseUsage();
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: true };
    } };
    const options = { provider, permission, model: "test" };
    const worker = kind === "delegate" ? createChildAttemptWorker({ ...options, prompt: "continue" })
      : createInteractiveChildWorker({ ...options, message: "continue" });
    const runtime = new SubagentRuntime({ tools, governance: new SubagentGovernanceTracker({ tokenBudget: 1000, timeoutMs: 0 }) });
    const handle = runtime.spawn<unknown>({ name: kind, worker, permissions: { allowedTools: [] },
      lineage: { parentAgentId: "parent", rootAttemptId: "root" } });
    await blocked;
    await handle.cancel();
    const result = await handle.wait();
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.usage, { inputTokens: 80, outputTokens: 20 }, "the completed first request is charged before the round ends");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.getActiveInstances().length, 0);
  });
}
