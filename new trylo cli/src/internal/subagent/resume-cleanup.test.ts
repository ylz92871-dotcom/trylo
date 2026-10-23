import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolPort } from "../ports/tools.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";

test("resume waits for cancelled worker cleanup and preserves its partial-work checkpoint", { timeout: 5000 }, async t => {
  let announceBlocked!: () => void;
  let releaseProvider!: () => void;
  const blocked = new Promise<void>(resolve => { announceBlocked = resolve; });
  const release = new Promise<void>(resolve => { releaseProvider = resolve; });
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request): AsyncIterable<ProviderEvent> {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "tool_input_start", toolCallId: "read-first", name: "read_file" };
      yield { type: "tool_input_delta", toolCallId: "read-first", argumentsText: '{"path":"progress.txt"}' };
      yield { type: "tool_input_end", toolCallId: "read-first" };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else if (requests.length === 2) {
      announceBlocked();
      // A real adapter may be unwinding a socket after cancellation. Control
      // must not infer that its checkpoint is ready merely from terminal status.
      await release;
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "resumed" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const tools: ToolPort = {
    snapshot: () => [{ name: "read_file", description: "read", parameters: {}, sideEffect: "read_only", needsApproval: false,
      timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } }],
    execute: async () => ({ outcome: "result", value: {}, output: "PARTIAL_PROGRESS_8291", truncated: false }), cancel: async () => {},
  };
  const runtime = new SubagentRuntime({ tools, governance: new SubagentGovernanceTracker({ timeoutMs: 0 }) });
  const control = createSubagentControlTool({ runtime, provider, model: "test", permission: {
    request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } } });
  t.after(async () => { releaseProvider(); await runtime.cancelAll(); });
  let sequence = 0;
  const call = (name: string, args: JsonObject) => control.execute({ toolCallId: `call-${++sequence}`, name, arguments: args }, new AbortController().signal);
  const spawned = await call("spawn_agent", { message: "read progress.txt then explain" });
  assert.equal(spawned.outcome, "result");
  if (spawned.outcome !== "result") return;
  const child = String(spawned.value["agent_id"]);
  await blocked;
  await call("close_agent", { target: child, force: true });
  let resumedEarly = false;
  const resuming = call("resume_agent", { target: child }).then(result => { resumedEarly = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumedEarly, false, "continuation waits for the old worker instead of asking the caller to retry");
  assert.equal(requests.length, 2, "waiting must not dispatch a second worker");
  releaseProvider();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!runtime.getActiveInstances().includes(child));
  const resumed = await resuming;
  assert.equal(resumed.outcome, "result");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.at(-1)?.messages.some(message => message.role === "tool" && message.content === "PARTIAL_PROGRESS_8291"),
    "the resumed provider must see the tool result obtained before cancellation");
});
