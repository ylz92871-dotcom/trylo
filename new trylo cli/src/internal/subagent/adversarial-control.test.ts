import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import { createSubagentToolPort } from "./subagent-tool.js";
import { SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }), cancel: async () => {} };
const permission = { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } };

for (const operation of ["spawn", "resume", "delegate"] as const) test(`capacity: ${operation} returns a typed refusal and leaves four admitted agents intact`, async t => {
  let requests = 0;
  const provider: ProviderPort = { async *stream(request, signal): AsyncIterable<ProviderEvent> {
    requests += 1;
    if (request.messages.some(message => message.content === "park")) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ tools, governance: new SubagentGovernanceTracker({ timeoutMs: 0 }) });
  t.after(async () => { await runtime.cancelAll(); await flush(); });
  const control = createSubagentControlTool({ runtime, provider, permission, model: "test" });
  const delegated = createSubagentToolPort({ runtime, provider, permission, model: "test" });
  let sequence = 0;
  const call = (name: string, args: JsonObject) => control.execute({ toolCallId: `call-${++sequence}`, name, arguments: args }, new AbortController().signal);
  const historical = await call("spawn_agent", { message: "fast" });
  assert.equal(historical.outcome, "result");
  if (historical.outcome !== "result") return;
  const historicalId = String(historical.value["agent_id"]);
  await flush(); await call("close_agent", { target: historicalId }); await flush();
  for (let index = 0; index < 4; index++) assert.equal((await call("spawn_agent", { message: "park" })).outcome, "result");
  await flush();
  const before = runtime.getActiveInstances();
  const beforeRequests = requests;
  const outcome = operation === "spawn" ? await call("spawn_agent", { message: "extra" })
    : operation === "resume" ? await call("resume_agent", { target: historicalId })
    : await delegated.execute({ toolCallId: "extra-delegate", name: "delegate_subagent", arguments: { taskName: "extra", prompt: "extra" } }, new AbortController().signal);
  assert.equal(outcome.outcome, "error");
  assert.equal(outcome.outcome === "error" ? outcome.code : "", "concurrency_limit_exceeded");
  assert.deepEqual(runtime.getActiveInstances(), before);
  assert.equal(requests, beforeRequests, "a refused child must never reach its provider");
  await call("close_agent", { target: before[0] ?? "", force: true }); await flush();
  assert.equal((await call("spawn_agent", { message: "replacement" })).outcome, "result", "capacity is usable after actual retirement");
});
