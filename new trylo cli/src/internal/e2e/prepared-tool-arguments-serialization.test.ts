import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createOpenAiCompatibleProvider } from '../adapters/provider/openai-compatible.js';
import { createResponsesProvider } from '../adapters/provider/responses.js';
import { compactionWiring } from '../surface/cli/compaction-wiring.js';
import { estimateMessagesTokens, estimateToolSpecsTokens } from '../compaction/token-estimate.js';
import { createToolArgumentNormalizer } from '../loop/tool-boundary.js';
import { createStreamAccumulator, applyToolCall } from '../loop/stream-blocks.js';
import { transcriptToMessages } from '../loop/transcript-messages.js';
import { createFakeTools, createFakePermission, emptyProfileLoader, echoBinding } from '../loop/fakes.js';
import { evaluatePreparedRequestBudget, localPreparedRequestTokens, measureNativeRequestIdentity } from '../loop/prompt-measurement.js';
import { runTurn } from '../loop/runner.js';
import type { ProviderPort, ProviderRequest } from '../ports/provider.js';
import type { TranscriptItem } from '../protocol/transcript.js';
import type { JsonObject } from '../protocol/envelope.js';

type WireMessage = { role?: string; content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type WireItem = { type?: string; role?: string; content?: string | Array<{ text: string }>; call_id?: string; name?: string; arguments?: string; output?: string };
type WireBody = { model: string; messages?: WireMessage[]; input?: WireItem[]; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number };
type Scenario = { name: string; kind: 'chat' | 'responses'; endpoint: string; model: string; scope?: string };

const TEXT = 'ABC中𠀀🙂'.repeat(1_000);
const scenarios: Scenario[] = [
  { name: 'plain-chat', kind: 'chat', endpoint: 'https://offline-estimator.invalid/v1/chat/completions', model: 'plain-synthetic' },
  { name: 'qwen-without-native-scope', kind: 'chat', endpoint: 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions', model: 'qwen3.8-flash' },
  { name: 'responses', kind: 'responses', endpoint: 'https://offline-estimator.invalid/v1/responses', model: 'responses-synthetic' },
  { name: 'qwen-native-original-control', kind: 'chat', endpoint: 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions', model: 'qwen3.8-flash', scope: '["synthetic","turn"]' },
];

function normalizerFixture(mode: 'default-wrapper' | 'custom-port' = 'default-wrapper') {
  const tools = createFakeTools([], [echoBinding({ needsApproval: false, parameters: {
    type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
  } })]);
  // The default normalizer only unwraps declared fields. Its larger original
  // produces overcount, not the custom Port's undercount counterexample.
  const original: JsonObject = mode === 'default-wrapper' ? { arguments: { text: 'small', ignored: TEXT } } : { text: 'small' };
  const normalize = mode === 'default-wrapper' ? createToolArgumentNormalizer(tools) : () => ({ text: TEXT });
  const acc = createStreamAccumulator(1);
  applyToolCall(acc, { type: 'tool_call', toolCallId: 'call-1', name: 'echo', arguments: original }, 'event-1', normalize);
  const call = acc.transcriptItems[0];
  assert.ok(call?.kind === 'tool_call');
  assert.deepEqual(call.originalArguments, original);
  assert.deepEqual(call.arguments, { text: mode === 'default-wrapper' ? 'small' : TEXT });
  const transcript: TranscriptItem[] = [
    { kind: 'user', sequence: 0, text: 'Perform the public operation.' }, ...acc.transcriptItems,
    { kind: 'tool_result', sequence: 2, toolCallId: 'call-1', name: 'echo', outcome: 'succeeded', output: 'Done.', truncated: false },
  ];
  return { tools, transcript, original, normalized: call.arguments };
}

function providerFixture(scenario: Scenario) {
  const bodies: WireBody[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(String(init?.body)) as WireBody;
    bodies.push(body);
    assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, undefined); assert.equal(body.max_output_tokens, undefined);
    const stream = scenario.kind === 'responses'
      ? 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const config = { endpoint: scenario.endpoint, model: scenario.model, apiKey: 'OFFLINE_SYNTHETIC_KEY', fetchImpl };
  const provider = scenario.kind === 'responses' ? createResponsesProvider(config) : createOpenAiCompatibleProvider(config);
  return { provider, bodies };
}

/** Same existing per-message UTF8/4 heuristic applied to actual serialized
 * text. This does not assert tokenizer accuracy or count JSON wire framing. */
function outgoingTextQuarter(body: WireBody): number {
  const quarter = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
  if (body.messages !== undefined) return body.messages.reduce((sum, message) => sum + quarter((message.content ?? '')
    + (message.tool_calls ?? []).map(call => call.id + call.function.name + call.function.arguments).join('')), 0);
  assert.ok(Array.isArray(body.input));
  return body.input.reduce((sum, item) => {
    if (item.type === 'function_call') return sum + quarter((item.call_id ?? '') + (item.name ?? '') + (item.arguments ?? ''));
    if (item.type === 'function_call_output') return sum + quarter(item.output ?? '');
    const text = typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text).join('');
    return sum + quarter(text);
  }, 0);
}

function wireArguments(body: WireBody): string {
  const value = body.messages?.flatMap(message => message.tool_calls ?? [])[0]?.function.arguments
    ?? body.input?.find(item => item.type === 'function_call')?.arguments;
  assert.equal(typeof value, 'string'); return value!;
}

function evidence(name: string, value: unknown): void {
  const directory = process.env.TRYLO_ESTIMATOR_EVIDENCE;
  if (directory === undefined) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

for (const mode of ['default-wrapper', 'custom-port'] as const) for (const scenario of scenarios) {
  test(`${mode}: final ${scenario.name} presentation prices the same tool arguments that fakeFetch receives`, async () => {
    const fixture = normalizerFixture(mode), fake = providerFixture(scenario);
    const request: ProviderRequest = { attemptId: 'synthetic', model: scenario.model, tools: [],
      ...(scenario.scope === undefined ? {} : { continuationScope: scenario.scope }), messages: transcriptToMessages(fixture.transcript) };
    const preparation = await fake.provider.prepareRequest?.(request, new AbortController().signal);
    const prepared = preparation?.apply(request) ?? request;
    const wiring = compactionWiring({ nowMs: 0, estimateTextPromptTokens: estimateMessagesTokens });
    const native = measureNativeRequestIdentity(fake.provider, prepared);
    const local = localPreparedRequestTokens(prepared, wiring, createFakeTools([], []), native);
    const selected = evaluatePreparedRequestBudget(prepared, local, undefined, undefined,
      wiring.estimatePromptTokens, native, wiring.estimateTextPromptTokens).decision;
    for await (const _event of fake.provider.stream(prepared, new AbortController().signal)) { /* Fake transport only. */ }
    assert.equal(fake.bodies.length, 1);
    const body = fake.bodies[0]!;
    const expectedArgs = scenario.scope === undefined ? fixture.normalized : fixture.original;
    assert.deepEqual(JSON.parse(wireArguments(body)), expectedArgs);
    const actual = outgoingTextQuarter(body);
    evidence(`${mode}-${scenario.name}`, { entry: 'normalizer → applyToolCall → transcriptToMessages → provider.prepareRequest → selected budget → stream → fakeFetch',
      mode, nativeScope: scenario.scope !== undefined, prepared, body, localEstimate: local, selected,
      actualOutgoingTextQuarter: actual, fakeFetches: fake.bodies.length, realNetworkCalls: 0,
      contract: 'same UTF8/4 on actual sent textual material, not model-tokenizer accuracy' });
    assert.equal(selected.basis, 'local');
    assert.equal(selected.tokens, actual, 'selected cold input basis must price the actual final serialized argument representation');
  });
}

for (const scenario of [scenarios[0]!, scenarios[2]!, scenarios[3]!]) {
  test(`runTurn default normalizer transcript reaches the actual ${scenario.name} sender and budget observation`, async () => {
    const fixture = normalizerFixture(), fake = providerFixture(scenario), sent: ProviderRequest[] = [];
    const provider: ProviderPort = { ...fake.provider, async *stream(request, signal) {
      sent.push(structuredClone(request)); yield* fake.provider.stream(request, signal);
    } };
    const result = await runTurn({ provider, tools: fixture.tools, permission: createFakePermission('approved'),
      profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0, estimateTextPromptTokens: estimateMessagesTokens }) },
    { sessionId: 'public-estimator-test', turnId: 'turn-1', correlationId: 'test', text: 'Continue from the completed operation.',
      model: scenario.model, budget: { contextTokenLimit: 1_000_000 }, resumedTranscript: fixture.transcript });
    assert.equal(result.state.terminalReason, 'completed'); assert.equal(sent.length, 1); assert.equal(fake.bodies.length, 1);
    const selected = result.envelopes.filter(envelope => envelope.kind === 'observation' && envelope.payload.component === 'prompt_budget').at(-1)?.payload;
    assert.ok(selected, 'normal runTurn must publish the actual selected gate observation');
    const actual = outgoingTextQuarter(fake.bodies[0]!) + estimateToolSpecsTokens(sent[0]!.tools);
    evidence(`runTurn-${scenario.name}`, { entry: 'normalizer → canonical resumed transcript → runTurn final preparation and gate → fakeFetch',
      selected, actualOutgoingTextQuarterPlusSameSchemaEstimate: actual, sent: sent[0], body: fake.bodies[0],
      fakeFetches: 1, realNetworkCalls: 0, contextWindow: 1_000_000, newGenerationOrRetryCaps: false });
    assert.equal(selected.localEstimate, actual, 'normal loop observation must account for the arguments actually serialized');
    assert.equal(selected.tokens, actual);
  });
}
