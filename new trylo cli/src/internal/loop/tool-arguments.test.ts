import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";
import { createFakePermission, emptyProfileLoader } from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";
import { unwrapWrappedArguments } from "./tool-boundary.js";

/**
 * A provider that hands back one wrapper object instead of the tool's own
 * arguments.
 *
 * Every shape here was observed on a real endpoint, on tools that otherwise
 * worked; the fourth one is why the rule cannot be a list of magic key names.
 * The contract is that the tool and the transcript agree on what was sent, and
 * that a call which was *already* unreadable still fails exactly as it did.
 */

const WRITE_PARAMETERS: JsonObject = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
};

const SHELL_PARAMETERS: JsonObject = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
};

function parametersOf(parameters: JsonObject): ReadonlyMap<string, string | undefined> {
  const declared = new Map<string, string | undefined>();
  const properties = parameters["properties"] as Record<string, JsonObject>;

  for (const [key, schema] of Object.entries(properties)) {
    const type = schema["type"];
    declared.set(key, typeof type === "string" ? type : undefined);
  }

  return declared;
}

const WRITE_DECLARED = parametersOf(WRITE_PARAMETERS);
const SHELL_DECLARED = parametersOf(SHELL_PARAMETERS);

test("a wrapper key is read through, whatever the key is called", () => {
  assert.deepEqual(
    unwrapWrappedArguments(WRITE_DECLARED, { arguments: { path: "a.js", content: "x" } }),
    { path: "a.js", content: "x" },
  );
  assert.deepEqual(
    unwrapWrappedArguments(WRITE_DECLARED, { args: { path: "a.js", content: "x" } }),
    { path: "a.js", content: "x" },
  );
  // The gateway sometimes names the wrapper after the tool's own first
  // parameter — `command` is declared as a string, so `{command: {...}}` was
  // never a real call for `run_shell`.
  assert.deepEqual(
    unwrapWrappedArguments(SHELL_DECLARED, { command: { path: "a.js", command: "cat a.js" } }),
    { command: "cat a.js" },
  );
  // Observed partially wrapped: the wrapper carries one parameter and the rest
  // sit beside it.
  assert.deepEqual(
    unwrapWrappedArguments(WRITE_DECLARED, { arguments: { path: "a.js" }, patch: "P" }),
    { patch: "P", path: "a.js" },
  );
  // A parameter the model also wrote at the top level keeps that value.
  assert.deepEqual(
    unwrapWrappedArguments(WRITE_DECLARED, { arguments: { path: "inner" }, path: "outer" }),
    { path: "outer" },
  );
});

test("an honest call and a genuinely bad one are both left alone", () => {
  // Nothing here invents a value: every case below reaches the tool byte for
  // byte as the model wrote it, and the tool's own refusal is the answer.
  const untouched: ReadonlyArray<JsonObject> = [
    { path: "a.js", content: "x" },
    // The value is not an object.
    { path: 3 },
    // The value is an object naming nothing the tool declares.
    { other: { nope: 1 } },
    // Nothing to read through: no parameter of this tool appears anywhere.
    { arguments: { command: "cat a.js" } },
  ];

  for (const args of untouched) {
    assert.equal(unwrapWrappedArguments(WRITE_DECLARED, args), args, JSON.stringify(args));
  }

  // A parameter the tool itself declares as an object is never read through.
  const objectParameter = new Map<string, string | undefined>([["payload", "object"]]);
  const nested = { payload: { payload: { deep: true } } };

  assert.equal(unwrapWrappedArguments(objectParameter, nested), nested);
  // With no declared shape at all nothing is rewritten.
  const unknown = { arguments: { path: "a.js" } };

  assert.equal(unwrapWrappedArguments(new Map(), unknown), unknown);
});

function binding(name: string, parameters: JsonObject): ToolBinding {
  return {
    name,
    description: "test tool",
    sideEffect: "read_only",
    parameters,
    needsApproval: false,
    timeoutMs: 1_000,
    outputLimits: { maxBytes: 65_536, maxLines: 200 },
  };
}

type Recording = {
  readonly port: ToolPort;
  readonly received: ToolCallRequest[];
};

function recordingTools(): Recording {
  const received: ToolCallRequest[] = [];
  const bindings = [binding("write_file", WRITE_PARAMETERS), binding("run_shell", SHELL_PARAMETERS)];

  return {
    received,
    port: {
      snapshot: () => bindings,
      async execute(call): Promise<ToolOutcome> {
        received.push(call);
        return { outcome: "result", value: { ok: true }, output: "ok", truncated: false };
      },
      async cancel() {},
    },
  };
}

function scripted(
  script: ReadonlyArray<ReadonlyArray<ProviderEvent>>,
): { readonly requests: ProviderRequest[]; readonly port: ProviderPort } {
  const requests: ProviderRequest[] = [];
  let index = 0;

  return {
    requests,
    port: {
      async *stream(request) {
        requests.push(request);
        const events = script[index] ?? [];
        index += 1;
        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

const STOP: ReadonlyArray<ProviderEvent> = [
  { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
];

test("the tool runs on unwrapped arguments and the transcript records the same ones", async () => {
  const provider = scripted([
    [
      { type: "tool_call", toolCallId: "c1", name: "write_file", arguments: { arguments: { path: "a.js", content: "x" } } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    STOP,
  ]);
  const tools = recordingTools();
  const ports: LoopPorts = {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: tools.port,
    provider: provider.port,
  };
  const result = await runTurn(ports, {
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "write it",
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(tools.received.map((call) => call.arguments), [{ path: "a.js", content: "x" }]);
  const recorded = result.transcript.find((item) => item.kind === "tool_call");

  assert.equal(recorded?.kind === "tool_call" ? JSON.stringify(recorded.arguments) : "", '{"path":"a.js","content":"x"}');
  // And the model sees flat arguments when its own call is replayed.
  const replayed = provider.requests[1]?.messages.find((message) => message.toolCalls !== undefined);

  assert.equal(JSON.stringify(replayed?.toolCalls?.[0]?.arguments), '{"path":"a.js","content":"x"}');
});

test("a call the wrapper rule cannot read reaches the tool unchanged", async () => {
  const provider = scripted([
    [
      // No declared parameter of `write_file` appears anywhere: no honest
      // reading exists, so nothing is rewritten and the tool's own refusal is
      // what the model gets.
      {
        type: "tool_call",
        toolCallId: "c1",
        name: "write_file",
        arguments: { arguments: { command: "cat a.js" } },
      },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    STOP,
  ]);
  const tools = recordingTools();
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: tools.port,
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "write it" },
  );

  assert.deepEqual(tools.received.map((call) => call.arguments), [
    { arguments: { command: "cat a.js" } },
  ]);
  assert.equal(result.state.terminalReason, "completed");
});
