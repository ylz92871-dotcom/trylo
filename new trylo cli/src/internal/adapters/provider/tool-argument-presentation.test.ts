import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { createResponsesProvider } from "./responses.js";
import { compactionWiring } from "../../surface/cli/compaction-wiring.js";
import { estimateMessagesTokens } from "../../compaction/token-estimate.js";
import { localPreparedRequestTokens, measureNativeRequestIdentity } from "../../loop/prompt-measurement.js";
import { createFakeTools, createFakePermission, emptyProfileLoader, echoBinding } from "../../loop/fakes.js";
import { createToolArgumentNormalizer } from "../../loop/tool-boundary.js";
import { createStreamAccumulator, applyToolCall } from "../../loop/stream-blocks.js";
import { transcriptToMessages } from "../../loop/transcript-messages.js";
import { runTurn } from "../../loop/runner.js";
import type { ProviderRequest } from "../../ports/provider.js";

const ENDPOINT = "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions";
const NATIVE = "qwen3.8-flash";
const normalized = { text: "ABC中𠀀🙂".repeat(1_000) };
const original = { text: "small" };
const signal = new AbortController().signal;
const wiring = compactionWiring({ nowMs: 0, estimateTextPromptTokens: estimateMessagesTokens });

function request(model = NATIVE, scope?: string): ProviderRequest {
  return { model, attemptId: "synthetic", tools: [], ...(scope === undefined ? {} : { continuationScope: scope }), messages: [
    { role: "user", content: "Perform the public operation." },
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "call-1", name: "echo", arguments: normalized, originalArguments: original }] },
    { role: "tool", toolCallId: "call-1", content: "Done." },
  ] };
}

const cases = [
  { name: "native configured and requested", configured: NATIVE, requested: NATIVE, scope: "task", native: true },
  { name: "native summary without scope", configured: NATIVE, requested: NATIVE, scope: undefined, native: false },
  { name: "empty opaque scope remains native", configured: NATIVE, requested: NATIVE, scope: "", native: true },
  { name: "plain configuration with effective native model", configured: "plain", requested: NATIVE, scope: "task", native: true },
  { name: "native configuration with effective plain model", configured: NATIVE, requested: "plain", scope: "task", native: false },
  { name: "empty request model falls back to native configuration", configured: NATIVE, requested: "", scope: "task", native: true },
  { name: "empty request model falls back to plain configuration", configured: "plain", requested: "", scope: "task", native: false },
  { name: "different endpoint has no native binding", configured: NATIVE, requested: NATIVE, scope: "task", native: false,
    endpoint: "https://offline-estimator.invalid/v1/chat/completions" },
];

for (const control of cases) test(`prepared Chat selector matches actual serialization: ${control.name}`, async () => {
  let credentialReads = 0, sends = 0, wireArguments: string | undefined;
  const provider = createOpenAiCompatibleProvider({ endpoint: control.endpoint ?? ENDPOINT, model: control.configured,
    get apiKey() { credentialReads++; return "OFFLINE_SYNTHETIC_KEY"; }, fetchImpl: async (_url, init) => {
      sends++;
      const body = JSON.parse(String(init?.body));
      wireArguments = body.messages[1].tool_calls[0].function.arguments;
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    } });
  const canonical = request(control.requested, control.scope), before = structuredClone(canonical);
  const preparation = await provider.prepareRequest?.(canonical, signal);
  assert.ok(preparation, "the adapter must expose its final presentation before the budget gate");
  const prepared = preparation.apply(canonical);
  assert.equal(credentialReads, 0, "pure presentation cannot authenticate or start a send");
  assert.equal(sends, 0);
  assert.deepEqual(canonical, before);
  if (control.native) assert.equal(prepared, canonical, "native representation stays untouched");
  else assert.equal(prepared.messages[1]?.toolCalls?.[0]?.originalArguments, undefined);
  for await (const _event of provider.stream(prepared, signal)) { /* In-memory serializer only. */ }
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(wireArguments!), control.native ? original : normalized);
  const local = localPreparedRequestTokens(prepared, wiring, createFakeTools([], []), measureNativeRequestIdentity(provider, prepared));
  assert.equal(local, control.native ? 17 : 3516, "synthetic Port counterexample, not default-normalizer reachability");
});

test("a prepared normalized copy preserves canonical aliases and reapplies to the new base after compaction", async () => {
  const provider = createOpenAiCompatibleProvider({ endpoint: ENDPOINT, model: NATIVE });
  const canonical = request(NATIVE, undefined);
  const call = canonical.messages[1]!.toolCalls![0]!;
  Object.freeze(call); Object.freeze(canonical.messages[1]!.toolCalls); Object.freeze(canonical.messages[1]);
  Object.freeze(canonical.messages); Object.freeze(canonical);
  const before = structuredClone(canonical);
  const preparation = await provider.prepareRequest?.(canonical, signal);
  assert.ok(preparation);
  const first = preparation.apply(canonical);
  assert.equal(first.messages[1]?.toolCalls?.[0]?.arguments, call.arguments);
  assert.deepEqual(canonical, before);
  assert.equal(preparation.apply(first), first, "repeated pure application is idempotent");
  const rebuilt: ProviderRequest = { ...canonical, messages: [...canonical.messages,
    { role: "assistant", content: "", toolCalls: [{ ...call, toolCallId: "new-call" }] }] };
  const next = preparation.apply(rebuilt);
  assert.equal(next.messages.length, rebuilt.messages.length);
  assert.ok(next.messages.filter(message => message.toolCalls !== undefined)
    .every(message => message.toolCalls!.every(value => value.originalArguments === undefined)));
  assert.equal(rebuilt.messages.at(-1)?.toolCalls?.[0]?.originalArguments, original);
});

test("one Chat presentation applies the current model/scope selector on a rebuilt request", async () => {
  const provider = createOpenAiCompatibleProvider({ endpoint: ENDPOINT, model: NATIVE });
  const native = request(NATIVE, "task");
  const preparation = await provider.prepareRequest?.(native, signal);
  assert.ok(preparation);
  assert.equal(preparation.apply(native), native);
  const { continuationScope: _scope, ...unscoped } = native;
  assert.equal(preparation.apply(unscoped).messages[1]?.toolCalls?.[0]?.originalArguments, undefined);
  assert.equal(preparation.apply({ ...native, model: "plain" }).messages[1]?.toolCalls?.[0]?.originalArguments, undefined);
});

test("Responses preparation uses normalized arguments even with a native-looking model and scope", async () => {
  const provider = createResponsesProvider({ endpoint: "https://offline-estimator.invalid/v1/responses", model: NATIVE });
  const canonical = request(NATIVE, "task"), before = structuredClone(canonical);
  const preparation = await provider.prepareRequest?.(canonical, signal);
  assert.ok(preparation);
  const prepared = preparation.apply(canonical);
  assert.equal(prepared.messages[1]?.toolCalls?.[0]?.originalArguments, undefined);
  assert.deepEqual(canonical, before);
  assert.equal(localPreparedRequestTokens(prepared, wiring, createFakeTools([], [])), 3516);
});

for (const kind of ["chat", "responses"] as const) test(`runTurn ${kind} does not compact or block a normalized request below its explicit window`, async () => {
  const tools = createFakeTools([], [echoBinding({ needsApproval: false, parameters: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"],
  } })]);
  const acc = createStreamAccumulator(1);
  applyToolCall(acc, { type: "tool_call", toolCallId: "wrapped", name: "echo",
    arguments: { arguments: { text: "small", ignored: normalized.text } } }, "event", createToolArgumentNormalizer(tools));
  const transcript = [{ kind: "user" as const, sequence: 0, text: "Complete the operation." }, ...acc.transcriptItems,
    { kind: "tool_result" as const, sequence: 2, toolCallId: "wrapped", name: "echo", outcome: "succeeded" as const,
      output: "Done.", truncated: false }];
  assert.ok(estimateMessagesTokens(transcriptToMessages(transcript)) > 1_000, "the old original-argument view exceeds this caller's test window");
  let sends = 0;
  const config = { endpoint: `https://offline-estimator.invalid/v1/${kind === "chat" ? "chat/completions" : "responses"}`,
    model: "plain", apiKey: "OFFLINE_SYNTHETIC_KEY", fetchImpl: async () => {
      sends++;
      const body = kind === "chat" ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    } };
  const provider = kind === "chat" ? createOpenAiCompatibleProvider(config) : createResponsesProvider(config);
  const result = await runTurn({ provider, tools, permission: createFakePermission("approved"), profile: emptyProfileLoader(), compaction: wiring },
    { sessionId: "test-fit-normalized", turnId: "turn", correlationId: "test", text: "Continue.",
      model: "plain", resumedTranscript: transcript, budget: { contextTokenLimit: 1_000 } });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(sends, 1);
  assert.equal(result.compactions.length, 0, "a fitting final view must not be prematurely compacted using the old representation");
  const selected = result.envelopes.filter(envelope => envelope.kind === "observation" && envelope.payload.component === "prompt_budget").at(-1)?.payload;
  assert.ok(selected && typeof selected.tokens === "number" && selected.tokens < 1_000);
});
