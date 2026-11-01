import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import type { SubagentContext } from "../../subagent/types.js";
import { SubagentRuntime } from "../../subagent/runtime.js";
import { SubagentToolRunner } from "../../subagent/tool-runner.js";
import { createToolEvolutionWorker, ToolEvolutionWorkerError } from "./provider-worker.js";

const TASK = { taskId: "generate-1", name: "tool-evolution", input: { prompt: "Generate a JSON echo tool." } };
const TOOLS: ToolPort = {
  snapshot: () => [],
  execute: async () => { throw new Error("generation must never execute tools"); },
  cancel: async () => {},
};
const STOP: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const TEXT: ProviderEvent = { type: "text_delta", blockId: "answer", text: "  candidate code  " };

function providerFor(events: readonly ProviderEvent[]): ProviderPort {
  return { async *stream() { yield* events; } };
}

function contextFor(controller = new AbortController()) {
  const usage: number[][] = [];
  const context: SubagentContext = {
    subagentId: "child-1", name: "tool-evolution",
    lineage: { parentAgentId: "parent-1", rootAttemptId: "attempt-1" },
    tools: TOOLS, signal: controller.signal, reportProgress: () => {},
    recordUsage: (input, output) => { usage.push([input, output]); },
  };
  return { context, usage, controller };
}

function failure(code: string) {
  return (error: unknown): boolean => error instanceof ToolEvolutionWorkerError && error.code === code;
}

test("tool evolution worker runs one isolated tool-free provider call through the real subagent runtime", async () => {
  const requests: ProviderRequest[] = [];
  let forks = 0;
  const child: ProviderPort = {
    async *stream(request) {
      requests.push(request);
      yield { type: "reasoning_delta", blockId: "hidden", text: "not candidate code", redacted: false };
      yield TEXT;
      yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 } };
      yield { type: "usage", usage: { ...emptyUsage("delta"), inputTokens: 2, outputTokens: 3 } };
      yield STOP;
    },
  };
  const parent: ProviderPort = {
    fork: () => { forks += 1; return child; },
    stream: () => { throw new Error("parent provider state must stay isolated"); },
  };
  const runtime = new SubagentRuntime({ tools: TOOLS });
  const runner = new SubagentToolRunner(runtime, createToolEvolutionWorker({ provider: parent, model: "selected-model" }));
  await runner.submit(TASK);
  const result = await runner.wait(TASK.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "candidate code");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(forks, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "selected-model");
  assert.deepEqual(requests[0]?.tools, []);
  assert.deepEqual(requests[0]?.messages.map(message => message.role), ["system", "user"]);
  assert.equal(requests[0]?.messages[1]?.content, TASK.input.prompt);
  assert.equal(requests[0]?.continuationScope, undefined);
});

test("tool evolution worker rejects missing or oversized prompts before a provider request", async () => {
  let requests = 0;
  const provider: ProviderPort = { async *stream() { requests += 1; yield STOP; } };
  const worker = createToolEvolutionWorker({ provider, model: "model", maxPromptChars: 3 });
  for (const input of [{}, { prompt: "" }, { prompt: "four" }]) {
    await assert.rejects(worker({ ...TASK, input }, contextFor().context), failure("invalid_task_prompt"));
  }
  assert.equal(requests, 0);
});

test("tool evolution worker refuses partial output after a provider error and still accounts known usage", async () => {
  const { context, usage } = contextFor();
  const provider = providerFor([
    TEXT,
    { type: "usage", usage: { ...emptyUsage(), inputTokens: 9, outputTokens: 4 } },
    { type: "error", class: "quota", phase: "after_stream_started", retryable: false, message: "private details" },
  ]);
  await assert.rejects(createToolEvolutionWorker({ provider, model: "model" })(TASK, context), failure("provider_error"));
  assert.deepEqual(usage, [[9, 4]]);
});

test("provider failure keeps its canonical class and phase without leaking provider text", async () => {
  const worker = createToolEvolutionWorker({ provider: providerFor([
    { type: "error", class: "quota", phase: "before_headers", retryable: false, message: "secret-provider-details" },
  ]), model: "model" });
  await assert.rejects(worker(TASK, contextFor().context), error => {
    assert.ok(error instanceof ToolEvolutionWorkerError);
    assert.equal(error.code, "provider_error");
    assert.match(error.message, /quota:before_headers/);
    assert.doesNotMatch(error.message, /secret-provider-details/);
    return true;
  });
});

test("tool evolution worker refuses EOF, truncated terminals, follow-up terminals, and empty output", async () => {
  const cases: readonly (readonly ProviderEvent[])[] = [
    [TEXT],
    [TEXT, { ...STOP, type: "finish", reason: "length" }],
    [TEXT, { ...STOP, type: "finish", requiresFollowUp: true }],
    [STOP],
  ];
  for (const events of cases) {
    const worker = createToolEvolutionWorker({ provider: providerFor(events), model: "model" });
    await assert.rejects(worker(TASK, contextFor().context), failure("incomplete_generation"));
  }
});

test("tool evolution worker refuses attempted tool calls even when the provider ignores its empty tool list", async () => {
  const worker = createToolEvolutionWorker({ provider: providerFor([
    { type: "tool_call", toolCallId: "call-1", name: "run_shell", arguments: { command: "anything" } }, STOP,
  ]), model: "model" });
  await assert.rejects(worker(TASK, contextFor().context), failure("tool_call_forbidden"));
});

test("tool evolution worker bounds answer text and the number of streamed events", async () => {
  await assert.rejects(createToolEvolutionWorker({ provider: providerFor([TEXT, STOP]), model: "model", maxOutputChars: 3 })
    (TASK, contextFor().context), failure("output_limit"));
  const worker = createToolEvolutionWorker({ provider: providerFor([
    { type: "text_start", blockId: "one" }, TEXT, STOP,
  ]), model: "model", maxEvents: 1 });
  await assert.rejects(worker(TASK, contextFor().context), failure("event_limit"));
});

test("tool evolution worker fails closed when a stateful provider cannot create independent state", async () => {
  const continuation = { capture: () => undefined, restore: () => {} };
  const provider: ProviderPort = { ...providerFor([TEXT, STOP]), continuation };
  const worker = createToolEvolutionWorker({ provider, model: "model" });
  await assert.rejects(worker(TASK, contextFor().context), failure("provider_isolation_unavailable"));
});

test("tool evolution worker classifies transport exceptions without leaking their private message", async () => {
  const provider: ProviderPort = { stream: () => { throw new Error("private endpoint or credential"); } };
  const { context, usage } = contextFor();
  await assert.rejects(createToolEvolutionWorker({ provider, model: "model" })(TASK, context), error => {
    assert.ok(failure("provider_error")(error));
    assert.equal(String(error).includes("private endpoint"), false);
    return true;
  });
  assert.deepEqual(usage, [[0, 0]]);
});

test("tool evolution worker forwards cancellation to the provider and classifies the thrown abort", async () => {
  const { context, controller } = contextFor();
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  let transportAborted = false;
  const provider: ProviderPort = {
    async *stream(_request, signal) {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { transportAborted = true; reject(new Error("aborted transport")); }, { once: true });
      });
      yield STOP;
    },
  };
  const result = createToolEvolutionWorker({ provider, model: "model" })(TASK, context);
  await ready;
  controller.abort();
  await assert.rejects(result, failure("cancelled"));
  assert.equal(transportAborted, true);
});

test("tool evolution worker does not request a provider after pre-cancellation", async () => {
  const { context, controller } = contextFor();
  controller.abort();
  const provider: ProviderPort = { stream: () => { throw new Error("must not request"); } };
  await assert.rejects(createToolEvolutionWorker({ provider, model: "model" })(TASK, context), failure("cancelled"));
});
