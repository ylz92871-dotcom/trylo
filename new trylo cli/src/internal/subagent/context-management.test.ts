import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderMessage, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { completedParentContext } from "./fork-context.js";

const permission = { request: async () => { throw new Error("unexpected approval"); },
  awaitDecision: async () => { throw new Error("unexpected approval"); } };
const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "error", code: "unused", message: "unused" }), cancel: async () => {} };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const tick = (): Promise<void> => new Promise(done => setImmediate(done));
function value(outcome: ToolOutcome): JsonObject { assert.equal(outcome.outcome, "result"); return outcome.outcome === "result" ? outcome.value : {}; }
function reply(text: string): ReadonlyArray<ProviderEvent> { return [{ type: "text_start", blockId: "a" },
  { type: "text_delta", blockId: "a", text }, { type: "text_end", blockId: "a" }, finish]; }

test("fork pairs tool occurrences in order when a provider reuses a tool id", () => {
  const call = (path: string): ProviderMessage => ({ role: "assistant", content: "", toolCalls: [{ toolCallId: "reused", name: "read_file", arguments: { path } }] });
  const result = (content: string): ProviderMessage => ({ role: "tool", toolCallId: "reused", content });
  const parent = [result("ORPHAN_BEFORE_ANY_CALL"), call("first"), result("FIRST_RESULT"), call("second"), result("SECOND_RESULT"),
    result("DUPLICATE_WITHOUT_CALL"), call("pending")];
  const fork = completedParentContext(parent);
  assert.deepEqual(fork, parent.slice(1, 5), "an earlier result cannot answer a later pending occurrence");
});

test("production spawn carries project rules without inheriting unrelated conversation", async t => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) { requests.push(request); yield* reply("done"); } };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, permission, model: "fixture",
    callerMessages: [{ role: "system", content: "PROJECT_RULE_66: metric units only" }] });
  t.after(async () => { await built.runtime.cancelAll(); });
  const spawned = value(await built.tools.execute({ name: "spawn_agent", toolCallId: "spawn", arguments: { message: "summarize" } }, new AbortController().signal));
  await built.tools.execute({ name: "wait_agent", toolCallId: "wait", arguments: { targets: [String(spawned["agent_id"])], timeout_ms: 1000 } }, new AbortController().signal);
  assert.ok(requests[0]?.messages.some(message => message.role === "system" && message.content === "PROJECT_RULE_66: metric units only"));
});

test("fork prefix participates in the child context ceiling before any provider request", async () => {
  let requests = 0;
  const provider: ProviderPort = { async *stream() { requests += 1; yield* reply("should not send"); } };
  const worker = createInteractiveChildWorker({ provider, permission, message: "short instruction", budget: { contextTokenLimit: 128 },
    forkMessages: [{ role: "user", content: "PINNED_USER_CONSTRAINT_" + "x".repeat(80000) }] });
  await assert.rejects(worker({ subagentId: "large-prefix", name: "fork", lineage: { parentAgentId: "parent", rootAttemptId: "root" },
    signal: new AbortController().signal, tools, recordUsage() {}, reportProgress() {} }), /context_limit/);
  assert.equal(requests, 0, "the adapter must not receive a prompt over the hard ceiling");
});

function nativeProvider(wire: JsonObject[]): ProviderPort {
  return createOpenAiCompatibleProvider({ endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", model: "glm-5.3-flash",
    apiKey: "fixture-only", fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      wire.push(body);
      const events = [{ choices: [{ delta: { reasoning_content: `SYNTHETIC_NATIVE_${wire.length}`, content: `answer-${wire.length}` }, finish_reason: "stop" }] }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
}

test("native provider state survives child rounds and parking while siblings remain isolated", async t => {
  const wire: JsonObject[] = [];
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: nativeProvider(wire), permission,
    model: "glm-5.3-flash", callerMessages: undefined });
  t.after(async () => { await built.runtime.cancelAll(); });
  let seq = 0;
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => value(await built.tools.execute({ name, toolCallId: `call-${++seq}`, arguments: args }, new AbortController().signal));
  const id = String((await call("spawn_agent", { message: "TASK_A" }))["agent_id"]);
  await call("wait_agent", { targets: [id], timeout_ms: 1000 });
  const sibling = String((await call("spawn_agent", { message: "TASK_B" }))["agent_id"]);
  await call("wait_agent", { targets: [sibling], timeout_ms: 1000 });
  await call("send_input", { target: id, message: "A_ROUND_2" });
  await call("wait_agent", { targets: [id], timeout_ms: 1000, release_on_ready: true });
  await call("send_input", { target: id, message: "A_ROUND_3" });
  await call("wait_agent", { targets: [id], timeout_ms: 1000 });
  await tick();
  const last = wire.at(-1)?.["messages"] as JsonObject[];
  assert.deepEqual(last.filter(message => message["role"] === "assistant").map(message => message["reasoning_content"]),
    ["SYNTHETIC_NATIVE_1", "SYNTHETIC_NATIVE_3"]);
  assert.ok(!JSON.stringify(last).includes("TASK_B"));
});

test("fork snapshot keeps byte payloads immutable across model requests", async () => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) { requests.push(structuredClone(request)); yield* reply("done"); } };
  const messages: ProviderMessage[] = [{ role: "user", content: "IMAGE_FACT", attachments: [{ mediaType: "image/png", dataBase64: "AAAA", bytes: 3, detail: "original" }] }];
  const worker = createInteractiveChildWorker({ provider, permission, message: "inspect", forkMessages: messages });
  messages[0] = { role: "user", content: "MUTATED_BEFORE_EXECUTION" };
  await worker({ subagentId: "immutable", name: "fork", lineage: { parentAgentId: "parent", rootAttemptId: "root" }, signal: new AbortController().signal,
    tools, recordUsage() {}, reportProgress() {} });
  assert.equal(requests[0]?.messages.find(message => message.content === "IMAGE_FACT")?.attachments?.[0]?.dataBase64, "AAAA");
});

test("fork copies only trusted native state matching the frozen parent history", async t => {
  const wire: JsonObject[] = [];
  const provider = nativeProvider(wire);
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, permission,
    model: "glm-5.3-flash", callerMessages: undefined });
  t.after(async () => { await built.runtime.cancelAll(); });
  const parentScope = JSON.stringify(["parent", "turn-one"]);
  for await (const _event of built.provider.stream({ attemptId: "parent-one", continuationScope: parentScope,
    model: "glm-5.3-flash", messages: [{ role: "user", content: "PARENT_TASK" }], tools: [] }, new AbortController().signal)) { /* consume */ }
  // A subsequent parent request establishes the real frozen conversation snapshot.
  for await (const _event of built.provider.stream({ attemptId: "parent-two", continuationScope: parentScope,
    model: "glm-5.3-flash", messages: [{ role: "user", content: "PARENT_TASK" }, { role: "assistant", content: "answer-1" },
      { role: "user", content: "delegate the next step" }], tools: [] }, new AbortController().signal)) { /* consume */ }
  const forked = value(await built.tools.execute({ name: "spawn_agent", toolCallId: "fork", arguments: { message: "CHILD_FORK", fork_context: true } }, new AbortController().signal));
  await built.tools.execute({ name: "wait_agent", toolCallId: "wait-fork", arguments: { targets: [String(forked["agent_id"])], timeout_ms: 1000 } }, new AbortController().signal);
  const last = wire.at(-1)?.["messages"] as JsonObject[];
  assert.equal(last.find(message => message["role"] === "assistant" && message["content"] === "answer-1")?.["reasoning_content"], "SYNTHETIC_NATIVE_1");
});
