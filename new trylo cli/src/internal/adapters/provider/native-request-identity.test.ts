import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ProviderContinuationPort, ProviderMessage, ProviderRequest } from "../../ports/provider.js";
import type { NativeCheckpointState } from "./glm-continuation-checkpoint.js";
import { createChatToolContinuation, type ChatToolContinuation } from "./glm-tool-continuation.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", model = "glm-5.3-flash";
const scope = JSON.stringify(["synthetic-session", "synthetic-turn"]);
const assistant = (id = "original"): ProviderMessage => ({ role: "assistant", content: `Answer ${id}.`,
  toolCalls: [{ toolCallId: `call:${id}`, name: "echo", arguments: { id } }] });
const original = assistant();
const request = (messages: readonly ProviderMessage[] = [original]): ProviderRequest => ({
  attemptId: "attempt:identity", continuationScope: scope, model, messages, tools: [],
});
const native = (message: ProviderMessage, reasoning: string): NativeCheckpointState => ({ kind: "native",
  assistant: { text: message.content, calls: [...message.toolCalls ?? []], reasoning } });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type ExpectedIdentity = { readonly messageFieldDigests: readonly string[]; readonly messageOverheadTokens: readonly number[]; readonly requestDigest: string };

function measure(c: ReturnType<typeof createChatToolContinuation>, input = request()): ExpectedIdentity {
  const port: (ProviderContinuationPort & { readonly measureRequestIdentity?: (value: ProviderRequest) => ExpectedIdentity }) | undefined = c.persistence;
  assert.ok(port?.measureRequestIdentity, "a native continuation exposes a pure identity of its actual outgoing fields");
  return port.measureRequestIdentity(input);
}

function complete(capture: ChatToolContinuation | undefined, message: ProviderMessage, reasoning: string) {
  assert.ok(capture);
  capture.observe({ type: "reasoning_delta", blockId: "r", text: reasoning, redacted: false });
  capture.observe({ type: "text_delta", blockId: "b", text: message.content });
  for (const call of message.toolCalls ?? []) capture.observe({ type: "tool_call", ...call });
  capture.observe({ type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true });
  capture.commit();
}

for (const profile of [
  { endpoint, model },
  { endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions", model: "deepseek-v4.1-flash" },
]) test(`native identity describes actual additive wire fields without exposing them: ${profile.model}`, async () => {
  const reasoning = "PRIVATE_NATIVE_REASONING_DO_NOT_EXPOSE";
  const messages: readonly ProviderMessage[] = [{ role: "user", content: "Synthetic input." }, original,
    { role: "tool", content: "Synthetic result.", toolCallId: original.toolCalls![0]!.toolCallId }];
  const input = { ...request(messages), model: profile.model };
  const states = [native(original, reasoning)], continuation = createChatToolContinuation(profile.endpoint, profile.model, states);
  const identity = measure(continuation, input);

  assert.deepEqual(identity.messageFieldDigests, [digest({}), digest({ reasoning_content: reasoning }), digest({})]);
  assert.deepEqual(identity.messageOverheadTokens, [0, Buffer.byteLength(reasoning, "utf8"), 0]);
  assert.match(identity.requestDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(identity), /PRIVATE|synthetic-session|ark\.cn/);
  let body: { messages: { reasoning_content?: string }[] } | undefined;
  const provider = createOpenAiCompatibleProvider({ ...profile, apiKey: "fixture-key", fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body)) as { messages: { reasoning_content?: string }[] };
    return new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } }, states);

  for await (const _event of provider.stream(input, new AbortController().signal)) { /* Local fake fetch only. */ }

  assert.ok(body);
  assert.deepEqual(identity.messageFieldDigests, body.messages.map(message => digest(
    message.reasoning_content === undefined ? {} : { reasoning_content: message.reasoning_content })));
});

test("the same canonical assistant with changed native input has a different field identity", () => {
  const left = measure(createChatToolContinuation(endpoint, model, [native(original, "FIRST_PRIVATE")]));
  const right = measure(createChatToolContinuation(endpoint, model, [native(original, "SECOND_PRIVATE")]));
  assert.equal(left.requestDigest, right.requestDigest);
  assert.notDeepEqual(left.messageFieldDigests, right.messageFieldDigests);
});

test("occurrence matching and ambiguity use the same fields as the sending lifecycle", () => {
  const c = createChatToolContinuation(endpoint, model, [native(original, "FIRST"), native(original, "SECOND")]);
  const second = { ...original }, full = request([original, second]);

  assert.deepEqual(measure(c, full).messageFieldDigests, [digest({ reasoning_content: "FIRST" }), digest({ reasoning_content: "SECOND" })]);
  assert.equal(c.persistence!.estimateOverheadTokens!([second]), 0, "a detached new occurrence cannot be matched on its own");
  assert.deepEqual(measure(c, full).messageOverheadTokens, [5, 6], "full-request occurrence accounting bounds both native fields");
  assert.deepEqual(measure(c, request()).messageFieldDigests, [digest({})]);
  const send = c.begin(full)!;

  assert.deepEqual([send.fieldsFor(original), send.fieldsFor(second)], [{ reasoning_content: "FIRST" }, { reasoning_content: "SECOND" }]);
});

test("measurement does not clear scopes, alter checkpoints or invalidate an inflight capture", () => {
  const c = createChatToolContinuation(endpoint, model);

  complete(c.begin(request([])), original, "ORIGINAL");
  const before = c.persistence!.capture(scope);
  const other = { ...request(), continuationScope: "other-execution-scope" };

  assert.deepEqual(measure(c, other).messageFieldDigests, [digest({})]);
  assert.deepEqual(c.persistence!.capture(scope), before);
  assert.equal(c.begin(request())!.fieldsFor(original).reasoning_content, "ORIGINAL");
  const later = assistant("later"), inflight = c.begin(request());

  measure(c, other);
  complete(inflight, later, "LATER");
  const committed = c.persistence!.capture(scope);

  assert.ok(committed);
  assert.deepEqual(committed["assistant"], { reasoning: "LATER", text: later.content, calls: later.toolCalls });
  const { continuationScope: _scope, ...unscoped } = request();

  measure(c, unscoped);
  assert.deepEqual(c.persistence!.capture(scope), committed);
});

test("adding unrelated native history preserves the global and existing message identities", () => {
  const c = createChatToolContinuation(endpoint, model);

  complete(c.begin(request([])), original, "ORIGINAL");
  const before = measure(c), later = assistant("later");

  complete(c.begin(request()), later, "LATER");
  const grown = measure(c, request([original, later]));

  assert.equal(grown.requestDigest, before.requestDigest);
  assert.deepEqual(grown.messageFieldDigests.slice(0, 1), before.messageFieldDigests);
  assert.equal(grown.messageFieldDigests[1], digest({ reasoning_content: "LATER" }));
});

test("real cache eviction changes native identity while warning acknowledgement alone does not", () => {
  const c = createChatToolContinuation(endpoint, model);

  complete(c.begin(request([])), original, "0".repeat(262_144));
  const before = measure(c);

  for (let i = 1; i < 5; i++) complete(c.begin(request([])), assistant(String(i)), String(i).repeat(262_144));

  const evicted = measure(c);

  assert.notDeepEqual(evicted.messageFieldDigests, before.messageFieldDigests);
  assert.deepEqual(evicted.messageFieldDigests, [digest({})]);
  assert.equal(evicted.requestDigest, before.requestDigest, "cache growth is represented only by actual native fields");
  const notice = c.begin(request())!.diagnostic;

  assert.ok(notice);
  c.persistence!.acknowledgeNotice!(notice.noticeId);
  assert.deepEqual(measure(c), evicted, "a warning not sent as model input cannot invalidate its server basis");
});

test("unscoped or unsupported request models expose no inherited native input", () => {
  const c = createChatToolContinuation(endpoint, model, [native(original, "ORIGINAL")]), before = measure(c);
  const { continuationScope: _scope, ...unscoped } = request();
  const auxiliary = measure(c, unscoped), otherModel = measure(c, { ...request(), model: "unsupported-native-model" });
  assert.deepEqual(auxiliary.messageFieldDigests, [digest({})]);
  assert.deepEqual(otherModel.messageFieldDigests, [digest({})]);
  assert.notEqual(auxiliary.requestDigest, before.requestDigest);
  assert.notEqual(otherModel.requestDigest, before.requestDigest);
  assert.deepEqual(measure(c), before, "observing another request does not erase inherited history");
});

test("providers without a native continuation profile keep the optional interface absent", () => {
  assert.equal(createChatToolContinuation("https://other.example/v1/chat/completions", model).persistence, undefined);
});
