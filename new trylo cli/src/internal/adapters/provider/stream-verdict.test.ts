import assert from "node:assert/strict";
import { test } from "node:test";
import { createResponsesProvider } from "./responses.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const item = { type: "function_call", id: "item", call_id: "call", name: "echo", arguments: '{"value":1}' };
const done = frame("response.output_item.done", { output_index: 0, item });
const completed = frame("response.completed", { response: { status: "completed" } });
const text = (value: string): string => frame("response.output_text.delta", { output_index: 1, delta: value });
const snapshot = (value: string): object => ({ type: "message", content: [{ type: "output_text", text: value }] });
const cases: ReadonlyArray<readonly [string, string]> = [
  ["EOF after a complete tool", done],
  ["incomplete after a complete tool", done + frame("response.incomplete", { response: { status: "incomplete" } })],
  ["failure after a complete tool", done + frame("response.failed", { message: "failed" })],
  ["failure after a batch of complete tools", done + frame("response.output_item.done", { output_index: 1,
    item: { ...item, id: "item-2", call_id: "call-2" } }) + frame("response.failed", { message: "failed" })],
  ["incomplete after a batch of complete tools", done + frame("response.output_item.done", { output_index: 1,
    item: { ...item, id: "item-2", call_id: "call-2" } }) + frame("response.incomplete", {})],
  ...["cancelled", "queued", "in_progress", "unrecognized"].map((status): readonly [string, string] =>
    [`non-success status ${status}`, done + frame("response.completed", { response: { status } })]),
  ["conflicting item arguments", done + frame("response.output_item.done", { output_index: 0, item: { ...item, arguments: '{"value":2}' } }) + completed],
  ["conflicting call arguments", done + frame("response.output_item.done", { output_index: 1, item: { ...item, id: "other", arguments: '{"value":2}' } }) + completed],
  ["conflicting final text", done + text("pay 100") + frame("response.output_item.done", { output_index: 1, item: snapshot("pay 1000") })
    + frame("response.completed", { response: { status: "completed", output: [item, snapshot("pay 9999")] } })],
  ["text snapshot retracts a delta", done + text("pay 1000") + frame("response.output_item.done", { output_index: 1, item: snapshot("pay 100") }) + completed],
];

async function exercise(wire: string, kind: "responses" | "chat", resumedTranscript?: Awaited<ReturnType<typeof runTurn>>["transcript"]) {
  let executions = 0, requests = 0, approvals = 0;
  const fetchImpl = async (): Promise<Response> => new Response(++requests === 1 ? wire : kind === "responses"
    ? text("VERIFIED") + completed : 'data: {"choices":[{"delta":{"content":"VERIFIED"},"finish_reason":"stop"}]}\n\n');
  const options = { endpoint: "https://audit.invalid/v1", model: "synthetic", apiKey: "synthetic", fetchImpl };
  const provider = kind === "responses" ? createResponsesProvider(options) : createOpenAiCompatibleProvider(options);
  const permission = createFakePermission("approved");
  const result = await runTurn({ provider, profile: emptyProfileLoader(),
    permission: { ...permission, request: async (...args) => { approvals++; return permission.request(...args); } },
    tools: { snapshot: () => [echoBinding({ needsApproval: true })], cancel: async () => {},
      execute: async () => { executions++; return toolResult({ ok: true }); } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Use echo and verify.", model: "synthetic",
    ...(resumedTranscript === undefined ? {} : { resumedTranscript }), budget: { maxIterations: 3 } });
  return { result, executions, requests, approvals };
}

test("Responses repeated semantic snapshots and sparse duplicate items settle once", async () => {
  const first = { ...item, arguments: '{"a":1,"b":2}' };
  const repeated = { ...item, arguments: '{"b":2,"a":1}' };
  const { result, executions, requests } = await exercise(
    frame("response.output_item.done", { output_index: 0, item: first })
    + frame("response.output_item.done", { output_index: 0, item: { ...item, arguments: "" } })
    + frame("response.completed", { response: { status: "completed", output: [repeated] } }), "responses");
  assert.equal(executions, 1);
  assert.equal(requests, 2);
  assert.equal(result.state.terminalReason, "completed");
});

for (const [name, wire] of cases) {
  test(`Responses verdict: ${name} cannot execute or ask approval`, async () => {
    const { result, executions, requests, approvals } = await exercise(wire, "responses");
    assert.equal(executions, 0, "tentative tools cannot produce effects before an accepted response");
    assert.equal(approvals, 0, "a failed response must not ask the user to approve its tools");
    assert.equal(requests, 1, "a failed response must not start a follow-up");
    assert.notEqual(result.state.terminalReason, "completed");
    assert.equal(result.envelopes.filter(event => event.kind === "terminal").length, 1);
    const resumed = await exercise(text("RESUMED") + completed, "responses", result.transcript);
    assert.equal(resumed.executions, 0, "resuming cannot execute rejected tentative calls");
    assert.equal(resumed.result.state.terminalReason, "completed");
  });
}

const chatCall = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":null}]}\n\n';
for (const reason of [undefined, "length", "content_filter", "error", "unrecognized"]) {
  test(`Chat verdict: ${reason ?? "EOF"} cannot execute or ask approval`, async () => {
    const wire = chatCall + (reason === undefined ? "data: [DONE]\n\n"
      : `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`);
    const { result, executions, approvals, requests } = await exercise(wire, "chat");
    assert.equal(executions, 0);
    assert.equal(approvals, 0);
    assert.equal(requests, 1);
    assert.notEqual(result.state.terminalReason, "completed");
  });
}

for (const kind of ["responses", "chat"] as const) {
  test(`${kind} accepted tools retain approval, exactly one effect and verified follow-up`, async () => {
    const wire = kind === "responses" ? done + frame("response.completed", { response: { status: "completed", output: [item] } })
      : chatCall + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const { result, executions, requests, approvals } = await exercise(wire, kind);
    assert.equal(executions, 1);
    assert.equal(approvals, 1);
    assert.equal(requests, 2);
    assert.equal(result.state.terminalReason, "completed");
    assert.ok(result.transcript.some(value => value.kind === "assistant_text" && value.text === "VERIFIED"));
  });
}
