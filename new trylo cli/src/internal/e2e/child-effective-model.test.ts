import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { createResponsesProvider } from "../adapters/provider/responses.js";
import { boundMessagesTextTokens } from "../compaction/token-estimate.js";
import { localPreparedRequestTokens } from "../loop/prompt-measurement.js";
import { providerContinuationScope, type ProviderMessage, type ProviderPort, type ProviderRequest } from "../ports/provider.js";
import type { SessionRecord } from "../ports/session.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createChildProviderSession, type ChildProviderSession } from "../subagent/child-provider-session.js";
import { childCompaction } from "../subagent/context-budget.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader } from "../loop/fakes.js";
import { ControlAgentSessions } from "../subagent/control-session.js";
import { checkpointContinuation } from "../subagent/control-checkpoint.js";
import { roleBinding, type SubagentCheckpoint } from "../subagent/checkpoint.js";
import { resolveRole } from "../subagent/role.js";
import { SubagentRuntime } from "../subagent/runtime.js";
import { createInteractiveChildWorker } from "../subagent/interactive-worker.js";
import { createChildAttemptWorker } from "../subagent/child-attempt.js";
import type { SubagentContext } from "../subagent/types.js";

const endpoint = "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions";
const target = "qwen3.8-flash", native = "SYNTHETIC_NATIVE_ONLY_".repeat(1200);
const sessionId = "effective-child-model";
const signal = new AbortController().signal;
type Body = { model: string; messages: { role: string; reasoning_content?: string }[] };

// Optional trailing arguments preserve assignment compatibility with C17.
const childSession: (source: ProviderPort, history?: readonly ProviderMessage[], model?: string) => ChildProviderSession = createChildProviderSession;
const forkFor = (provider: ProviderPort, messages: readonly ProviderMessage[] | undefined, model?: string): ProviderPort => {
  const fork: (history?: readonly ProviderMessage[], options?: { readonly model: string }) => ProviderPort = provider.fork!;
  return fork(messages, model === undefined ? undefined : { model });
};

function response(tool: boolean, toolName = "echo"): Response {
  const delta = tool ? { content: "Checking.", reasoning_content: native,
    tool_calls: [{ index: 0, id: "call-model", function: { name: toolName, arguments: '{"value":1}' } }] } : { content: "Done." };
  const frames = [{ choices: [{ delta, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] }];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

function fixture(configuredModel = "plain-parent", url = endpoint, toolName = "echo") {
  const bodies: Body[] = [];
  const provider = createOpenAiCompatibleProvider({ endpoint: url, model: configuredModel, apiKey: "synthetic-no-network",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return response(bodies.length === 1, toolName);
    } });
  return { provider, bodies };
}

function request(model = target, turn = "first", messages: readonly ProviderMessage[] = [{ role: "user", content: "Check and finish." }]): ProviderRequest {
  return { attemptId: turn, model, continuationScope: providerContinuationScope(sessionId, turn), messages, tools: [] };
}

async function complete(provider: ProviderPort, input: ProviderRequest) {
  let content = "", reportedModel: string | undefined;
  const calls: { toolCallId: string; name: string; arguments: JsonObject }[] = [];
  for await (const event of provider.stream(input, signal)) {
    if (event.type === "error") assert.fail(`synthetic provider failed: ${event.class}`);
    if (event.type === "stream_start") reportedModel = event.model;
    if (event.type === "text_delta") content += event.text;
    if (event.type === "tool_call") calls.push({ toolCallId: event.toolCallId, name: event.name, arguments: event.arguments });
  }
  const assistant: ProviderMessage = { role: "assistant", content, ...(calls.length === 0 ? {} : { toolCalls: calls }) };
  return { assistant, reportedModel };
}

function nextRequest(assistant: ProviderMessage, model = target, turn = "second") {
  return request(model, turn, [request().messages[0]!, assistant, { role: "tool", toolCallId: "call-model", content: "Observed." }]);
}

test("a child override charges the native bytes actually serialized on its next request", async () => {
  const f = fixture(), child = childSession(f.provider, undefined, target);
  try {
    const first = await complete(child.provider, request()), next = nextRequest(first.assistant);
    const identity = child.provider.continuation?.measureRequestIdentity?.(next);
    const estimated = localPreparedRequestTokens(next, childCompaction(child.provider), createFakeTools([], []), identity);
    await complete(child.provider, next);

    assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, native);
    assert.equal(estimated - boundMessagesTextTokens(next.messages), Buffer.byteLength(native, "utf8"),
      "child accounting must include the native bytes present in the actual request body");
    assert.equal(identity?.messageOverheadTokens[1], Buffer.byteLength(native, "utf8"));
  } finally { child.close(); }
});

test("an explicit Port checkpoint restores the target child's original native bytes into the real serializer", async () => {
  const first = fixture(), child = childSession(first.provider, undefined, target);
  const original = await complete(child.provider, request());
  const saved = child.provider.continuation?.capture(request().continuationScope!);
  const records: SessionRecord[] = saved === undefined ? [] : [{ formatVersion: "1", sequence: 1, type: "envelope", sessionId,
    turnId: "first", at: "2026-11-08T00:00:00.000Z", payload: { envelope: { kind: "stream_end" }, providerContinuation: saved } }];
  child.close();
  const second = fixture(), restored = childSession(second.provider, undefined, target);
  try {
    restored.provider.continuation?.restore({ sessionId, turnId: "second", records });
    await complete(restored.provider, nextRequest(original.assistant));
    assert.equal(second.bodies[0]!.messages.find(message => message.role === "assistant")?.reasoning_content, native,
      "explicit checkpoint replay must produce the exact original native wire field");
  } finally { restored.close(); }
});

test("Chat stream_start names the model used by the actual serialized request", async () => {
  const f = fixture(), observed = await complete(f.provider, request());
  assert.equal(f.bodies[0]!.model, target);
  assert.equal(observed.reportedModel, f.bodies[0]!.model);
});

test("Responses stream_start names the model used by the actual serialized request", async () => {
  let wireModel: string | undefined, reportedModel: string | undefined;
  const provider = createResponsesProvider({ endpoint: "https://synthetic.invalid/v1/responses", model: "plain-parent", apiKey: "synthetic-no-network",
    fetchImpl: async (_url, init) => {
      wireModel = (JSON.parse(String(init?.body)) as { model: string }).model;
      return new Response('event: response.completed\ndata: {"response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } });
    } });
  for await (const event of provider.stream(request(), signal)) {
    if (event.type === "error") assert.fail(event.class);
    if (event.type === "stream_start") reportedModel = event.model;
  }
  assert.equal(wireModel, target);
  assert.equal(reportedModel, wireModel);
});

test("default and explicit configured-model forks cannot replay another effective model's native state", async t => {
  const url = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
  const configured = "glm-5.3", actual = "glm-5.3-flash";
  for (const targetModel of [undefined, configured]) await t.test(targetModel ?? "default", async () => {
    const f = fixture(configured, url), first = await complete(f.provider, request(actual));
    const next = nextRequest(first.assistant, configured, "fork");
    await complete(forkFor(f.provider, next.messages, targetModel), next);
    assert.equal(f.bodies[1]!.model, configured);
    assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, undefined,
      "a matching assistant identity does not authorize another exact model's native state");
  });
});

test("same-model default fork retains native state and a distinct GLM alias does not", async () => {
  const url = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", name = "glm-5.3-flash";
  const f = fixture(name, url), first = await complete(f.provider, request(name)), next = nextRequest(first.assistant, name, "same");
  await complete(forkFor(f.provider, next.messages), next);
  assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, native);
  await complete(forkFor(f.provider, next.messages, "glm-5-3-flash"), { ...next, model: "glm-5-3-flash", continuationScope: providerContinuationScope(sessionId, "alias") });
  assert.equal(f.bodies[2]!.messages.find(message => message.role === "assistant")?.reasoning_content, undefined);
});

function trackedFixture(toolName = "echo") {
  const f = fixture("plain-parent", endpoint, toolName), models: (string | undefined)[] = [], overhead: number[] = [];
  const fork: (history?: readonly ProviderMessage[], options?: { readonly model: string }) => ProviderPort = f.provider.fork!;
  const trackedFork = (history?: readonly ProviderMessage[], options?: { readonly model: string }): ProviderPort => {
    models.push(options?.model);
    const selected = fork(history, options);
    return { ...selected, async *stream(input, currentSignal) {
      overhead.push(selected.continuation?.measureRequestIdentity?.(input).messageOverheadTokens.reduce((sum, value) => sum + value, 0) ?? 0);
      yield* selected.stream(input, currentSignal);
    } };
  };
  return { ...f, provider: { ...f.provider, fork: trackedFork }, models, overhead };
}

const nativeTokens = Buffer.byteLength(native, "utf8");

test("construction through public control start binds the override before real native requests", async () => {
  const f = trackedFixture(), tools = createFakeTools([], [echoBinding({ needsApproval: false })]), runtime = new SubagentRuntime({ tools });
  const sessions = new ControlAgentSessions({ runtime, provider: f.provider, model: "plain-parent", sessionId,
    permission: createFakePermission("approved"), profile: emptyProfileLoader(), allowedTools: ["echo"] });
  const entry = sessions.start({ message: "Check once and finish.", toolCallId: "start-effective-model", model: target });
  entry.channel.close();
  try {
    const settled = await entry.handle.wait();
    assert.equal(settled.status, "completed", JSON.stringify(settled));
    assert.equal(f.bodies.length, 2, "The construction control must actually send both synthetic requests");
    assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, native);
    assert.equal(f.overhead[1], nativeTokens, "the actual control-start second request must account for its native wire bytes");
    assert.deepEqual(f.models, [target]);
  } finally { await runtime.cancelAll(); entry.providerSession.close(); }
});

test("construction from checkpoint selects migration, saved model, then resolved model without restoring opaque state", async t => {
  for (const variant of ["migration", "saved", "resolved"] as const) await t.test(variant, async () => {
    const f = trackedFixture(), tools = createFakeTools([], [echoBinding({ needsApproval: false })]), runtime = new SubagentRuntime({ tools });
    const parentModel = "plain-parent";
    const roles = variant === "resolved" ? [{ name: "default", description: "Synthetic resolved role", model: target, allowedTools: ["echo"] }] : [];
    const resolved = resolveRole(roles, undefined, { model: parentModel, allowedTools: ["echo"], maxIterations: undefined });
    const checkpoint: SubagentCheckpoint = { version: 1, taskId: "saved-task", agentId: "saved-agent", round: 1, phase: "round_ready",
      nickname: "saved", instruction: "Check once", role: resolved.role.name, roleBinding: roleBinding(resolved),
      ...(variant === "resolved" ? {} : { model: variant === "migration" ? "old-saved-model" : target }), allowedTools: ["echo"],
      dependencies: [], idleTimeoutMs: 30000, budget: { tokensUsed: 0, timeoutMode: "active" }, cursor: 0, transcript: [], forkMessages: [] };
    const restored = await checkpointContinuation({ runtime, provider: f.provider, model: parentModel, roles,
      ...(variant === "migration" ? { modelMigration: target } : {}), permission: createFakePermission("approved"), allowedTools: ["echo"] }, checkpoint, signal);
    try {
      const first = await complete(restored.providerSession.provider, request());
      await complete(restored.providerSession.provider, nextRequest(first.assistant));
      assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, native);
      assert.equal(f.overhead[1], nativeTokens, "new native state acquired after canonical-only recovery must be measurable");
      assert.deepEqual(f.models, [target]);
      assert.equal(restored.resolved.model, target);
    } finally { restored.providerSession.close(); await runtime.cancelAll(); }
  });
});

test("construction through interactive fallback and one-shot options binds before streaming", async t => {
  for (const kind of ["interactive", "one-shot"] as const) await t.test(kind, async () => {
    const f = trackedFixture(), tools = createFakeTools([], [echoBinding({ needsApproval: false })]);
    const context: SubagentContext = { subagentId: "effective-construction", name: "effective-construction",
      lineage: { parentAgentId: "parent", rootAttemptId: "construction-root" }, tools, signal, reportProgress: () => {}, recordUsage: () => {} };
    const options = { provider: f.provider, permission: createFakePermission("approved"), profile: emptyProfileLoader(), model: target, sessionId };
    if (kind === "interactive") await createInteractiveChildWorker({ ...options, message: "Check once and finish." })(context);
    else await createChildAttemptWorker({ ...options, prompt: "Check once and finish." })(context);
    assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, native);
    assert.equal(f.overhead[1], nativeTokens);
    assert.deepEqual(f.models, [target]);
  });
});

test("construction through the configuration branch binds the admitted role model before streaming", async () => {
  const f = trackedFixture("read_file"), tools = createFakeTools([], [echoBinding({ name: "read_file", needsApproval: false })]), runtime = new SubagentRuntime({ tools });
  const sessions = new ControlAgentSessions({ runtime, provider: f.provider, model: "plain-parent", sessionId,
    permission: createFakePermission("approved"), profile: emptyProfileLoader(), allowedTools: ["read_file"] });
  const entry = sessions.start({ message: "Check once and finish.", toolCallId: "configured-effective-model",
    configuration: { metadata: { configurationRef: "synthetic-approved", configurationVersion: "v1",
      identity: { expertId: "synthetic", version: 1, experienceKey: "synthetic" }, experienceVersionIds: [] },
      role: { name: "default", description: "Synthetic admitted role", model: target, allowedTools: ["read_file"] } } });
  entry.channel.close();
  try {
    const settled = await entry.handle.wait();
    assert.equal(settled.status, "completed", JSON.stringify(settled));
    assert.equal(f.bodies.length, 2, "The construction control must actually send both synthetic requests");
    assert.equal(f.bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, native);
    assert.equal(f.overhead[1], nativeTokens);
    assert.deepEqual(f.models, [target]);
  } finally { await runtime.cancelAll(); entry.providerSession.close(); }
});
