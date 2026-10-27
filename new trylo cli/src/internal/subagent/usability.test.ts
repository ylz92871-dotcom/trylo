import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderMessage, type ProviderPort, type ProviderRequest } from "../ports/provider.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";
import type { TimerScheduler } from "./scheduler.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const permission = { request: async () => { throw new Error("unexpected approval"); },
  awaitDecision: async () => { throw new Error("unexpected approval"); } };
const tools: ToolPort = { snapshot: () => ["read_file", "search_text", "write_file"].map(name => ({ name, description: name,
  parameters: {}, sideEffect: "read_only" as const, needsApproval: false, timeoutMs: 1000,
  outputLimits: { maxBytes: 1000, maxLines: 10 } })),
  execute: async () => ({ outcome: "result", value: {}, output: "evidence", truncated: false }), cancel: async () => {} };

function clock() {
  let time = 0;
  const jobs = new Set<{ at: number; fire: () => void }>();
  const scheduler: TimerScheduler = (delay, fire) => { const job = { at: time + delay, fire }; jobs.add(job);
    return { cancel: () => { jobs.delete(job); } }; };
  return { scheduler, now: () => time, jobs,
    advance(ms: number) { time += ms; for (const job of [...jobs]) if (job.at <= time) { jobs.delete(job); job.fire(); } } };
}

function harness(parentMessages?: ReadonlyArray<ProviderMessage>, custom?: ProviderPort) {
  const timer = clock();
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = custom ?? { async *stream(request): AsyncIterable<ProviderEvent> {
    requests.push(request);
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: `answer-${requests.length}` };
    yield { type: "text_end", blockId: "a" };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  let seq = 0;
  const runtime = new SubagentRuntime({ tools, scheduler: timer.scheduler,
    governance: new SubagentGovernanceTracker({ ...timer }), idGenerator: () => `agent-${++seq}` });
  const control = createSubagentControlTool({ runtime, provider, permission, model: "test", scheduler: timer.scheduler,
    ...(parentMessages === undefined ? {} : { parentMessages }) });
  const call = (name: string, args: JsonObject, signal = new AbortController().signal) =>
    control.execute({ toolCallId: `call-${++seq}`, name, arguments: args }, signal);
  return { runtime, timer, requests, call, cleanup: async () => { await runtime.cancelAll(); await flush(); } };
}
function value(result: ToolOutcome): JsonObject { assert.equal(result.outcome, "result"); return result.outcome === "result" ? result.value : {}; }
function report(result: ToolOutcome, id: string): JsonObject { return (value(result)["results"] as JsonObject)[id] as JsonObject; }

test("spawn budgets are explicit, validated before admission, and visible with live usage", async t => {
  const h = harness(); t.after(h.cleanup);
  const invalid = await h.call("spawn_agent", { message: "go", token_budget: -1 });
  assert.equal(invalid.outcome, "error");
  assert.equal(h.runtime.getActiveInstances().length, 0);
  const spawned = value(await h.call("spawn_agent", { message: "go", token_budget: 1200, timeout_ms: 100, idle_timeout_ms: 1000 }));
  const id = String(spawned["agent_id"]);
  await flush();
  const budget = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0 }), id)["budget"] as JsonObject;
  assert.equal(budget["token_limit"], 1200);
  assert.equal(budget["tokens_used"], 30);
  assert.equal(budget["tokens_remaining"], 1170);
  assert.equal(budget["timeout_mode"], "active");
  h.timer.advance(200); await flush();
  assert.equal(h.runtime.status(id), "running", "waiting for parent input must not spend active execution time");
  await h.call("send_input", { target: id, message: "next" }); await flush();
  assert.equal(h.requests.length, 2);
});

test("production wiring inherits available parent tools and intersects role restrictions", async t => {
  const seen: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request): AsyncIterable<ProviderEvent> { seen.push(request);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const parent = { ...tools, snapshot: () => tools.snapshot().filter(b => b.name !== "write_file") };
  const built = buildSubagentPorts({ parentTools: parent, workspaceTools: tools, childProvider: provider, model: "test",
    permission, callerMessages: undefined, roles: [{ name: "searcher", description: "search", allowedTools: ["search_text", "write_file"] }] });
  t.after(async () => { await built.runtime.cancelAll(); });
  const result = value(await built.tools.execute({ name: "spawn_agent", toolCallId: "spawn", arguments: { message: "search", agent_type: "searcher" } }, new AbortController().signal));
  assert.deepEqual(result["allowed_tools"], ["search_text"]);
  await flush();
  // World access stays intersected. The additional local communication port
  // is not a permission to execute any parent tool.
  assert.deepEqual(seen[0]?.tools.map(b => b.name), ["search_text", "report_progress"]);
});

test("fork preserves completed tool pairs and image bytes while excluding unanswered parent calls", async t => {
  const history: ProviderMessage[] = [
    { role: "user", content: "inspect", attachments: [{ mediaType: "image/png", dataBase64: "AAAA", bytes: 3, detail: "original" }] },
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "read", name: "read_file", arguments: { path: "a.txt" } }] },
    { role: "tool", toolCallId: "read", content: "PARENT_EVIDENCE_8271" },
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "pending", name: "spawn_agent", arguments: { message: "go" } }] },
  ];
  const h = harness(history); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "use evidence", fork_context: true }))["agent_id"]);
  await flush();
  const messages = h.requests[0]?.messages ?? [];
  assert.ok(messages.some(m => m.role === "tool" && m.content === "PARENT_EVIDENCE_8271"));
  assert.ok(messages.some(m => m.toolCalls?.some(c => c.toolCallId === "read")));
  assert.ok(!messages.some(m => m.toolCalls?.some(c => c.toolCallId === "pending")));
  assert.deepEqual(messages.find(m => m.content === "inspect")?.attachments, history[0]?.attachments);
  await h.call("close_agent", { target: id }); await flush();
  const resumed = value(await h.call("resume_agent", { target: id, message: "finish the same inspection" }));
  assert.equal(resumed["task_id"], id);
  await flush();
  assert.ok(h.requests.at(-1)?.messages.some(m => m.content === "PARENT_EVIDENCE_8271"));
});

test("result cursors suppress repeat answers and release_on_ready frees the slot without losing follow-up", async t => {
  const h = harness(); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "go" }))["agent_id"]);
  await flush();
  const first = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0 }), id);
  const cursor = first["cursor"] ?? null;
  assert.equal(typeof cursor, "number");
  const repeated = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0, after: { [id]: cursor } }), id);
  assert.equal(repeated["changed"], false);
  assert.equal(repeated["output"], "");
  await h.call("wait_agent", { targets: [id], timeout_ms: 0, release_on_ready: true }); await flush();
  assert.equal(h.runtime.getActiveInstances().length, 0);
  const follow = value(await h.call("send_input", { target: id, message: "follow up" }));
  assert.equal(follow["task_id"], id);
  await flush();
  const answer = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0, after: { [id]: cursor } }), id);
  assert.equal(answer["output"], "answer-2");
  assert.ok(h.requests[1]?.messages.some(m => m.content === "answer-1"));
});

test("idle cleanup completes successfully and a later input continues the same task", async t => {
  const h = harness(); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "go", idle_timeout_ms: 50 }))["agent_id"]);
  await flush(); h.timer.advance(51); await flush();
  assert.equal(h.runtime.status(id), "completed");
  assert.equal(h.runtime.getActiveInstances().length, 0);
  const follow = value(await h.call("send_input", { target: id, message: "next" }));
  assert.equal(follow["task_id"], id);
  await flush(); assert.equal(h.requests.length, 2);
});

test("automatic continuation retains cumulative budget and explicit close prevents reopening", async t => {
  const h = harness(); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "go", token_budget: 100, idle_timeout_ms: 50 }))["agent_id"]);
  await flush(); h.timer.advance(51); await flush();
  await h.call("send_input", { target: id, message: "next" }); await flush();
  const budget = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0 }), id)["budget"] as JsonObject;
  assert.equal(budget["token_limit"], 100);
  assert.equal(budget["tokens_used"], 60);
  assert.equal(budget["tokens_remaining"], 40);
  h.timer.advance(51); await flush();
  await h.call("close_agent", { target: id });
  const closed = await h.call("send_input", { target: id, message: "must not reopen" });
  assert.equal(closed.outcome === "error" ? closed.code : "", "agent_closed");
  assert.equal(h.requests.length, 2);
});

test("malformed settings and unknown input modes have no execution side effects", async t => {
  const h = harness(); t.after(h.cleanup);
  for (const args of [{ timeout_ms: 0 }, { timeout_ms: 1.5 }, { idle_timeout_ms: -1 },
    { token_budget: 100001 }, { allowed_tools: "read_file" }, { allowed_tools: [false] }]) {
    const result = await h.call("spawn_agent", { message: "go", ...args });
    assert.equal(result.outcome === "error" ? result.code : "", "invalid_arguments");
  }
  assert.equal(h.runtime.getActiveInstances().length, 0);
  const id = String(value(await h.call("spawn_agent", { message: "go" }))["agent_id"]);
  await flush();
  const result = await h.call("send_input", { target: id, message: "do not execute", mode: "typo" });
  assert.equal(result.outcome === "error" ? result.code : "", "invalid_arguments");
  assert.equal(h.requests.length, 1);
});

test("active execution time accumulates across rounds while idle time is excluded", async t => {
  let spend: (ms: number) => void = () => {};
  let calls = 0;
  const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
    calls += 1;
    spend(calls === 1 ? 30 : 71);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const h = harness(undefined, provider); spend = ms => h.timer.advance(ms); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "go", timeout_ms: 100, idle_timeout_ms: 1000 }))["agent_id"]);
  await flush(); h.timer.advance(200); await flush();
  assert.equal(h.runtime.status(id), "running");
  await h.call("send_input", { target: id, message: "next" }); await flush();
  assert.equal(h.runtime.status(id), "timed_out");
  assert.equal(calls, 2);
  assert.equal(h.runtime.getActiveInstances().length, 0);
});

test("a pending cursor wait follows an automatically continued task", async t => {
  const h = harness(); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "go", idle_timeout_ms: 50 }))["agent_id"]);
  await flush(); h.timer.advance(51); await flush();
  const parked = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0 }), id);
  let answer: ToolOutcome | undefined;
  const waiting = h.call("wait_agent", { targets: [id], timeout_ms: 1000, after: { [id]: parked["cursor"] ?? null } }).then(result => { answer = result; });
  await h.call("send_input", { target: id, message: "next" }); await flush();
  h.timer.advance(1001); await waiting;
  assert.equal(value(answer!)["timed_out"], false);
  assert.equal(report(answer!, id)["output"], "answer-2");
  assert.equal(report(answer!, id)["round"], 2);
});

test("retired usage is charged before recovery even when reported after cancellation", async t => {
  let blocked!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { blocked = resolve; });
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
    requests += 1;
    if (requests === 2) { yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 80, totalTokens: 80 } }; blocked(); await cleanup; return; }
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10, totalTokens: 10 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const h = harness(undefined, provider); t.after(async () => { release(); await h.cleanup(); });
  const id = String(value(await h.call("spawn_agent", { message: "go", token_budget: 100 }))["agent_id"]);
  await flush(); await h.call("send_input", { target: id, message: "more" }); await started;
  const closing = h.call("close_agent", { target: id, force: true });
  release(); await closing;
  await h.call("resume_agent", { target: id }); await flush();
  const budget = report(await h.call("wait_agent", { targets: [id], timeout_ms: 0 }), id)["budget"] as JsonObject;
  assert.equal(budget["tokens_used"], 100);
  assert.equal(budget["tokens_remaining"], 0);
});

test("collecting a failed terminal with release_on_ready cannot silently resume it", async t => {
  const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: "error", class: "invalid_request", retryable: false, phase: "before_headers", message: "failure" };
  } };
  const h = harness(undefined, provider); t.after(h.cleanup);
  const id = String(value(await h.call("spawn_agent", { message: "go" }))["agent_id"]); await flush();
  await h.call("wait_agent", { targets: [id], timeout_ms: 0, release_on_ready: true });
  const sent = await h.call("send_input", { target: id, message: "do not retry" });
  assert.equal(sent.outcome === "error" ? sent.code : "", "agent_closed");
});

test("restart stops the active round, waits for cleanup, then uses the new instruction", async t => {
  let started!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { started = resolve; });
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const requests: ProviderRequest[] = [];
  let aborted = false;
  const provider: ProviderPort = { async *stream(request, signal): AsyncIterable<ProviderEvent> {
    requests.push(request);
    if (requests.length === 1) { started(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); await cleanup; return; }
    yield { type: "text_start", blockId: "a" }; yield { type: "text_delta", blockId: "a", text: "replacement complete" };
    yield { type: "text_end", blockId: "a" }; yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const h = harness(undefined, provider); t.after(async () => { release(); await h.cleanup(); });
  const id = String(value(await h.call("spawn_agent", { message: "old task" }))["agent_id"]);
  await blocked;
  const restarting = h.call("send_input", { target: id, message: "replacement task", mode: "restart" });
  await flush();
  assert.equal(aborted, true);
  assert.equal(requests.length, 1, "no replacement provider request until the old worker retires");
  release();
  const next = value(await restarting);
  assert.equal(next["delivery"], "restarted");
  assert.equal(next["task_id"], id);
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.messages.at(-1)?.content, "replacement task");
});
