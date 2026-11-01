import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { SessionRecord } from "../ports/session.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { createSubagentCheckpointJournal } from "../adapters/subagent-checkpoints/journal.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import type { SubagentControlOptions } from "./control-session.js";
import type { ToolBinding } from "../ports/tools.js";
import { inspectTeamRepresentation } from "../protocol/team-representation.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const permission = { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } };

function harness(records: SessionRecord[], generation: string, extra: Partial<SubagentControlOptions> = {}) {
  let sequence = records.length; let calls = 0; let ids = 0;
  const requests: ProviderRequest[] = [];
  const checkpoints = createSubagentCheckpointJournal(records, "session", async payload => {
    records.push({ formatVersion: "1", sequence: ++sequence, sessionId: "session", type: "envelope", at: "2026-10-28T00:00:00Z",
      payload: { envelope: { kind: "observation", payload } } });
  });
  const provider: ProviderPort = { async *stream(request, signal) {
    requests.push(request);
    if (request.messages.some(message => message.content === "wait until crash")) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    yield { type: "text_start", blockId: "answer" }; yield { type: "text_delta", blockId: "answer", text: `checkpoint answer ${generation}` };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ idGenerator: () => `${generation}-${++ids}`,
    tools: { snapshot: (): ToolBinding[] => ["read_file", "write_file"].map(name => ({ name, description: name, parameters: { type: "object" },
      sideEffect: "read_only", needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 1024, maxLines: 10 } })),
      execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const tools = createSubagentControlTool({ runtime, provider, permission, checkpoints, ...extra });
  const call = (name: string, args: JsonObject = {}) => tools.execute({ name, arguments: args, toolCallId: `call-${generation}-${++calls}` }, new AbortController().signal);
  return { runtime, requests, checkpoints, tools, call };
}

async function ready(h: ReturnType<typeof harness>, message = "original assignment"): Promise<string> {
  const spawn = await h.call("spawn_agent", { message });
  assert.equal(spawn.outcome, "result"); if (spawn.outcome !== "result") throw new Error("spawn failed");
  const task = String(spawn.value["task_id"]);
  await flush();
  const result = await h.call("wait_agent", { targets: [task], timeout_ms: 0 });
  assert.equal(result.outcome, "result");
  return task;
}

test("a fresh owner discovers and explicitly resumes a durable task with canonical history, identity and cumulative budget", async t => {
  const records: SessionRecord[] = [];
  const old = harness(records, "old"); t.after(() => old.runtime.cancelAll());
  const task = await ready(old);
  const snapshot = structuredClone(records);
  await old.runtime.cancelAll();
  const next = harness(snapshot, "new"); t.after(() => next.runtime.cancelAll());
  const listed = await next.call("list_agents");
  assert.equal(listed.outcome, "result");
  assert.equal(next.requests.length, 0, "history loading must not start a model");
  const resumed = await next.call("resume_agent", { target: task, message: "inspect prior result, then continue" });
  assert.equal(resumed.outcome, "result"); if (resumed.outcome !== "result") return;
  assert.equal(resumed.value["task_id"], task);
  assert.notEqual(resumed.value["agent_id"], task);
  assert.equal(resumed.value["recovery"], "canonical_checkpoint");
  await flush();
  assert.equal(next.requests.length, 1);
  assert.ok(next.requests[0]?.messages.some(message => message.content === "checkpoint answer old"));
  const answer = await next.call("wait_agent", { targets: [task], timeout_ms: 0 });
  assert.equal(answer.outcome, "result"); if (answer.outcome !== "result") return;
  const row = (answer.value["results"] as JsonObject)[task] as JsonObject;
  assert.equal(row["round"], 2);
  assert.equal((row["budget"] as JsonObject)["tokens_used"], 50);
  const duplicate = await next.call("resume_agent", { target: task });
  assert.equal(duplicate.outcome, "error"); if (duplicate.outcome === "error") assert.equal(duplicate.code, "agent_still_running");
});

test("interrupted checkpoints demand an explicit instruction and never replay a model on inspection", async t => {
  const records: SessionRecord[] = [];
  const old = harness(records, "old"); t.after(() => old.runtime.cancelAll());
  const task = await ready(old, "wait until crash");
  const snapshot = structuredClone(records);
  const next = harness(snapshot, "new"); t.after(() => next.runtime.cancelAll());
  const refused = await next.call("resume_agent", { target: task });
  assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, "agent_recovery_instruction_required");
  assert.equal(next.requests.length, 0);
  const budgetRequired = await next.call("resume_agent", { target: task, message: "inspect files first" });
  assert.equal(budgetRequired.outcome, "error"); if (budgetRequired.outcome === "error") assert.equal(budgetRequired.code, "agent_recovery_budget_required");
  const resumed = await next.call("resume_agent", { target: task, message: "I checked existing effects; inspect files before continuing", token_budget: 1000, timeout_ms: 60_000 });
  assert.equal(resumed.outcome, "result"); await flush(); assert.equal(next.requests.length, 1);
});

test("changed role instructions refuse recovery and revoked tools remain revoked", async t => {
  const records: SessionRecord[] = [];
  const old = harness(records, "old", { roles: [{ name: "default", description: "test role", prompt: "scope A" }], allowedTools: ["read_file", "write_file"] });
  t.after(() => old.runtime.cancelAll()); const task = await ready(old);
  const next = harness(structuredClone(records), "new", { roles: [{ name: "default", description: "test role", prompt: "scope B" }], allowedTools: ["read_file"] });
  t.after(() => next.runtime.cancelAll());
  const refused = await next.call("resume_agent", { target: task });
  assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, "agent_recovery_profile_mismatch");
  assert.equal(next.requests.length, 0);
  const narrowed = harness(structuredClone(records), "narrowed", { roles: [{ name: "default", description: "test role", prompt: "scope A" }], allowedTools: ["read_file"] });
  t.after(() => narrowed.runtime.cancelAll());
  const restored = await narrowed.call("resume_agent", { target: task });
  assert.equal(restored.outcome, "result"); await flush();
  assert.ok(old.requests[0]?.tools.some(tool => tool.name === "write_file"), "the original member really had the tool before revocation");
  assert.ok(narrowed.requests[0]?.tools.some(tool => tool.name === "read_file"));
  assert.ok(narrowed.requests.every(request => !request.tools.some(tool => tool.name === "write_file")));
});

test("recovering a frozen Worker cannot inherit a previous process's Person clearance", async t => {
  const records: SessionRecord[] = []; const old = harness(records, "old", { team: {
    runId: "team", members: [{ memberId: "worker", baseRole: "worker", displayName: "实现", role: { name: "worker", description: "实现" } }],
  } });
  t.after(() => old.runtime.cancelAll());
  const spawn = await old.call("spawn_agent", { agent_type: "worker", member_id: "worker", message: "已确认范围内实现" });
  assert.equal(spawn.outcome, "result"); if (spawn.outcome !== "result") return; await flush();
  const next = harness(structuredClone(records), "new", { team: { runId: "team", inspectRepresentation: inspectTeamRepresentation,
    members: ["person", "worker"].map(role => ({ memberId: role, baseRole: role, displayName: role, role: { name: role, description: role } })),
  } });
  t.after(() => next.runtime.cancelAll());
  const resumed = await next.call("resume_agent", { target: String(spawn.value["task_id"]) });
  assert.equal(resumed.outcome, "error"); if (resumed.outcome === "error") assert.equal(resumed.code, "team_representation_pending");
  assert.equal(next.requests.length, 0);
});

test("failed owned-resource cleanup blocks recovery before another model is called", async t => {
  const records: SessionRecord[] = []; const old = harness(records, "old"); t.after(() => old.runtime.cancelAll()); const task = await ready(old);
  const next = harness(structuredClone(records), "new", { taskResources: { stop: async () => { throw new Error("process still active"); } } });
  t.after(() => next.runtime.cancelAll()); const refused = await next.call("resume_agent", { target: task });
  assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, "agent_cleanup_failed");
  assert.equal(next.requests.length, 0);
});

test("missing or corrupt latest chunks refuse recovery instead of substituting an older checkpoint", async t => {
  const records: SessionRecord[] = []; const old = harness(records, "old"); t.after(() => old.runtime.cancelAll()); const task = await ready(old);
  const prior = old.checkpoints.read(task); assert.equal(prior.kind, "ready"); if (prior.kind !== "ready") return;
  const before = records.length;
  await old.checkpoints.save({ ...prior.checkpoint, instruction: "中文边界".repeat(30_000) });
  const incomplete = records.slice(0, -1); assert.ok(records.length > before + 1);
  const next = harness(incomplete, "new"); t.after(() => next.runtime.cancelAll());
  const refused = await next.call("resume_agent", { target: task });
  assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, "agent_checkpoint_invalid");
  assert.equal(next.requests.length, 0);
  for (const row of records) assert.ok(Buffer.byteLength(JSON.stringify(row.payload)) < 65_536);
  const complete = harness(structuredClone(records), "complete"); t.after(() => complete.runtime.cancelAll());
  assert.equal(complete.checkpoints.read(task).kind, "ready");
  const corrupt = structuredClone(records);
  const envelope = corrupt.at(-1)!.payload["envelope"] as JsonObject;
  const payload = envelope["payload"] as JsonObject;
  corrupt[corrupt.length - 1] = { ...corrupt.at(-1)!, payload: { envelope: { ...envelope, payload: { ...payload,
    checkpointPart: { ...(payload["checkpointPart"] as JsonObject), data: "corrupted" } } } } };
  assert.equal(harness(corrupt, "corrupt").checkpoints.read(task).kind, "invalid");
});

test("checkpoint storage failure prevents the member from starting a provider request", async t => {
  const h = harness([], "new", { checkpoints: { save: async () => { throw new Error("disk failed"); }, read: () => ({ kind: "missing" }), list: () => [] } });
  t.after(() => h.runtime.cancelAll()); const task = await ready(h);
  assert.equal(h.requests.length, 0);
  const result = await h.call("wait_agent", { targets: [task], timeout_ms: 0 });
  assert.equal(result.outcome, "result"); if (result.outcome !== "result") return;
  assert.equal((result.value["status"] as JsonObject)[task], "failed");
});

test("forked image bytes never enter the checkpoint journal and missing media context refuses cold recovery", async t => {
  const records: SessionRecord[] = [];
  const bytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sD5sAAAAASUVORK5CYII=";
  const old = harness(records, "old", { parentMessages: [{ role: "user", content: "check this image", attachments: [
    { mediaType: "image/png", dataBase64: bytes, bytes: 68, detail: "high" },
  ] }] }); t.after(() => old.runtime.cancelAll());
  const spawn = await old.call("spawn_agent", { message: "inspect background", fork_context: true });
  assert.equal(spawn.outcome, "result"); if (spawn.outcome !== "result") return; await flush();
  assert.equal(JSON.stringify(records).includes(bytes), false);
  const next = harness(structuredClone(records), "next"); t.after(() => next.runtime.cancelAll());
  const refused = await next.call("resume_agent", { target: String(spawn.value["task_id"]) });
  assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, "agent_recovery_context_unavailable");
  assert.equal(next.requests.length, 0);
});

test("oversized snapshots and orphan tool calls durably invalidate the task rather than reusing prior history", async t => {
  const records: SessionRecord[] = []; const old = harness(records, "old"); t.after(() => old.runtime.cancelAll()); const task = await ready(old);
  const saved = old.checkpoints.read(task); assert.equal(saved.kind, "ready"); if (saved.kind !== "ready") return;
  for (const checkpoint of [
    { ...saved.checkpoint, instruction: "x".repeat(4 * 1024 * 1024) },
    { ...saved.checkpoint, transcript: [{ kind: "tool_call" as const, sequence: 0, toolCallId: "orphan", name: "write_file", arguments: {} }] },
  ]) {
    await assert.rejects(old.checkpoints.save(checkpoint), { code: "agent_checkpoint_unavailable" });
    const next = harness(structuredClone(records), "next"); t.after(() => next.runtime.cancelAll());
    assert.equal(next.checkpoints.read(task).kind, "invalid");
    assert.equal(next.requests.length, 0);
  }
});

test("checkpoint discovery pages bounded metadata without starting a model", async t => {
  const h = harness([], "list", { checkpoints: { read: () => ({ kind: "missing" }), save: async () => {},
    list: () => Array.from({ length: 12 }, (_, i) => ({ kind: "invalid", taskId: `task-${i}`, message: "incomplete" })),
  } }); t.after(() => h.runtime.cancelAll());
  const first = await h.call("list_agents"); assert.equal(first.outcome, "result"); if (first.outcome !== "result") return;
  assert.equal((first.value["recoverable"] as unknown[]).length, 8); assert.equal(first.value["next_offset"], 8);
  const next = await h.call("list_agents", { offset: 8 }); assert.equal(next.outcome, "result"); if (next.outcome !== "result") return;
  assert.equal((next.value["recoverable"] as unknown[]).length, 4); assert.equal(next.value["next_offset"], null);
  assert.deepEqual(JSON.parse(next.output), next.value);
  const invalid = await h.call("list_agents", { offset: -1 }); assert.equal(invalid.outcome, "error");
  assert.equal(h.requests.length, 0);
});
