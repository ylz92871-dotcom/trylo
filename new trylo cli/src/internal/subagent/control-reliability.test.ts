import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import { emptyUsage } from "../ports/provider.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import { createSubagentInputChannel } from "./input-channel.js";
import { SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";
import type { SubagentRole } from "./role.js";
import type { TimerScheduler } from "./scheduler.js";

function clock() {
  const timers = new Set<() => void>();
  const scheduler: TimerScheduler = (_delay, fire) => {
    timers.add(fire);
    return { cancel: () => { timers.delete(fire); } };
  };
  return { scheduler, timers, fire: () => { for (const fire of [...timers]) { timers.delete(fire); fire(); } } };
}
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function harness(roles: ReadonlyArray<SubagentRole> = [], failing = false) {
  const timer = clock();
  const requests: ProviderRequest[] = [];
  const tools: ToolPort = {
    snapshot: () => [], execute: async () => ({ outcome: "result", value: {}, output: "ok", truncated: false }), cancel: async () => {},
  };
  const provider: ProviderPort = {
    async *stream(request, signal): AsyncIterable<ProviderEvent> {
      requests.push(request);
      if (request.messages.some(message => message.content === "slow")) {
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        return;
      }
      if (failing || request.messages.some(message => message.content === "fail")) { yield { type: "error", class: "invalid_request", retryable: false, phase: "before_headers", message: "fixture failure" }; return; }
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: `answer-${requests.length}` };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "usage", usage: emptyUsage() };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  let sequence = 0;
  const runtime = new SubagentRuntime({ tools, scheduler: timer.scheduler,
    governance: new SubagentGovernanceTracker({ timeoutMs: 0 }), idGenerator: () => `agent-${++sequence}` });
  const options = { runtime, provider, model: "parent-model", roles, scheduler: timer.scheduler,
    permission: { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } } };
  const control = createSubagentControlTool(options);
  const call = (name: string, args: JsonObject, signal = new AbortController().signal) => control.execute({ toolCallId: `call-${++sequence}`, name, arguments: args }, signal);
  const spawn = async (args: JsonObject): Promise<string> => {
    const result = await call("spawn_agent", args);
    assert.equal(result.outcome, "result");
    return result.outcome === "result" ? String(result.value["agent_id"]) : "";
  };
  const cleanup = async () => { for (const id of runtime.getActiveInstances()) await runtime.cancel(id); await flush(); };
  return { timer, runtime, control, requests, call, spawn, cleanup };
}
function value(result: ToolOutcome): JsonObject {
  assert.equal(result.outcome, "result");
  return result.outcome === "result" ? result.value : {};
}

test("a finished round is collected without closing the agent and without blocking on another agent", async t => {
  const h = harness(); t.after(h.cleanup);
  const slow = await h.spawn({ message: "slow" });
  const fast = await h.spawn({ message: "fast" });
  await flush();
  let observation: ToolOutcome | undefined;
  void h.call("wait_agent", { targets: [slow, fast], timeout_ms: 0 }).then(result => { observation = result; });
  await flush();
  assert.ok(observation, "zero-time observation must return without closing either agent");
  const response = value(observation);
  assert.equal(response["timed_out"], false);
  const reports = response["results"] as JsonObject;
  assert.equal((reports[fast] as JsonObject)["output"], "answer-2");
  assert.equal((reports[fast] as JsonObject)["phase"], "awaiting_input");
  assert.equal(h.runtime.status(fast), "running", "a round report is not a runtime terminal");
});

test("one wait deadline covers all targets rather than restarting for every agent", async t => {
  const h = harness(); t.after(h.cleanup);
  const first = await h.spawn({ message: "slow" });
  const second = await h.spawn({ message: "slow" });
  await flush();
  let answer: ToolOutcome | undefined;
  void h.call("wait_agent", { targets: [first, second], timeout_ms: 30 }).then(result => { answer = result; });
  await flush();
  h.timer.fire(); await flush();
  assert.ok(answer, "the entire wait must settle at the one deadline");
  assert.equal(value(answer)["timed_out"], true);
  assert.equal(h.timer.timers.size, 0, "completed observers must remove their timers");
});

test("cancelling a wait detaches the observer and leaves the child running", async t => {
  const h = harness(); t.after(h.cleanup);
  const child = await h.spawn({ message: "slow" });
  const abort = new AbortController();
  let answer: ToolOutcome | undefined;
  void h.call("wait_agent", { targets: [child], timeout_ms: 30 }, abort.signal).then(result => { answer = result; });
  await flush(); abort.abort(); await flush();
  assert.equal(answer?.outcome, "cancelled");
  assert.equal(h.runtime.status(child), "running");
  assert.equal(h.timer.timers.size, 0);
});

test("role instructions are used by the actual child provider request", async t => {
  const h = harness([{ name: "reviewer", description: "reviews", prompt: "Review without changing files.", model: "review-model" }]);
  t.after(h.cleanup);
  await h.spawn({ message: "inspect", agent_type: "reviewer" }); await flush();
  assert.match(h.requests[0]?.messages.map(message => message.content).join(" ") ?? "", /Review without changing files/);
});

test("resuming retains the role model and its instructions", async t => {
  const h = harness([{ name: "reviewer", description: "reviews", prompt: "Stay a reviewer.", model: "review-model" }]);
  t.after(h.cleanup);
  const child = await h.spawn({ message: "inspect", agent_type: "reviewer" }); await flush();
  await h.call("close_agent", { target: child }); await flush();
  await h.call("resume_agent", { target: child }); await flush();
  assert.equal(h.requests.at(-1)?.model, "review-model");
});

test("the advertised model override reaches only the selected child", async t => {
  const h = harness(); t.after(h.cleanup);
  await h.spawn({ message: "inspect", model: "requested-child-model" }); await flush();
  assert.equal(h.requests[0]?.model, "requested-child-model");
});

test("a provider failure finishes the child as failed without waiting for a close", async t => {
  const h = harness([], true); t.after(h.cleanup);
  const child = await h.spawn({ message: "inspect" }); await flush();
  assert.equal(h.runtime.status(child), "failed");
  const sent = await h.call("send_input", { target: child, message: "more" });
  assert.equal(sent.outcome === "error" ? sent.code : "", "agent_closed");
});

test("an already-cancelled inbox read cannot park forever", async () => {
  const channel = createSubagentInputChannel();
  const abort = new AbortController(); abort.abort("cancelled-before-read");
  let rejected = false;
  void channel.next(abort.signal).catch(() => { rejected = true; });
  await flush(); channel.close();
  assert.equal(rejected, true);
});

test("the input mailbox refuses unbounded accumulation", () => {
  const channel = createSubagentInputChannel();
  let accepted = 0;
  for (let index = 0; index < 1000; index++) if (channel.deliver({ message: `message-${index}` })) accepted++;
  channel.close();
  assert.ok(accepted > 0 && accepted <= 64, `accepted ${accepted} queued instructions`);
});

test("a follow-up collects only its own answer rather than concatenating previous rounds", async t => {
  const h = harness(); t.after(h.cleanup);
  const child = await h.spawn({ message: "first" }); await flush();
  await h.call("send_input", { target: child, message: "second" });
  const pending = value(await h.call("wait_agent", { targets: [child], timeout_ms: 0 }));
  assert.equal(pending["timed_out"], true, "the previous answer cannot satisfy a new request");
  await flush();
  const reports = value(await h.call("wait_agent", { targets: [child], timeout_ms: 0 }))["results"] as JsonObject;
  assert.equal((reports[child] as JsonObject)["output"], "answer-2");
});

test("a failed follow-up never presents the previous answer as its output", async t => {
  const h = harness(); t.after(h.cleanup);
  const child = await h.spawn({ message: "first" }); await flush();
  await h.call("send_input", { target: child, message: "fail" }); await flush();
  const reports = value(await h.call("wait_agent", { targets: [child], timeout_ms: 0 }))["results"] as JsonObject;
  assert.equal((reports[child] as JsonObject)["status"], "failed");
  assert.equal((reports[child] as JsonObject)["output"], "");
});

test("cancelling an active follow-up cannot relabel the previous answer as the cancelled round", async t => {
  const h = harness(); t.after(h.cleanup);
  const child = await h.spawn({ message: "first" }); await flush();
  await h.call("send_input", { target: child, message: "slow" }); await flush();
  await h.call("close_agent", { target: child, force: true });
  const reports = value(await h.call("wait_agent", { targets: [child], timeout_ms: 0 }))["results"] as JsonObject;
  assert.equal((reports[child] as JsonObject)["status"], "cancelled");
  assert.equal((reports[child] as JsonObject)["output"], "");
});

test("control history evicts old terminal agents instead of retaining every transcript", async t => {
  const h = harness(); t.after(h.cleanup);
  const children: string[] = [];
  for (let index = 0; index < 70; index += 1) {
    const child = await h.spawn({ message: `task-${index}` });
    children.push(child);
    await flush();
    await h.call("close_agent", { target: child }); await flush();
  }
  const forgotten = await h.call("wait_agent", { targets: [children[0] ?? ""], timeout_ms: 0 });
  assert.equal(forgotten.outcome === "error" ? forgotten.code : "", "unknown_agent");
  const retained = value(await h.call("wait_agent", { targets: [children.at(-1) ?? ""], timeout_ms: 0 }));
  assert.equal(retained["timed_out"], false);
});
