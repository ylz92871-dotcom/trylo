import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ToolBinding, ToolPort } from "../ports/tools.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * One provider response that asks for several tools is one scheduling unit.
 *
 * This is the contract that a plain four-file read used to break: the loop
 * registered a request and ran it in the same step, so the first `tool_result`
 * put the phase back to `turning` and the siblings that had not been registered
 * yet were `illegal_transition:turning:tool_request`, ending the turn with
 * `unsettled_tool_input`. Everything asserted here is a fact about the *turn* —
 * what settled, what the next request carried, how the turn ended — because the
 * reducer already had a batch shape and it was the wiring that never used it.
 */

const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "read the project" };

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
        // Taken before yielding: the consumer abandons the generator at the
        // stream's terminal event, so anything after the last `yield` may never
        // run and the same script would be replayed on the next request.
        const events = script[index] ?? [];

        index += 1;

        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

/** One response asking for `ids`, in the order the provider gave them. */
function askingFor(ids: ReadonlyArray<string>, name: string): ReadonlyArray<ProviderEvent> {
  return [
    ...ids.map(
      (toolCallId): ProviderEvent => ({
        type: "tool_call",
        toolCallId,
        name,
        arguments: { path: `${toolCallId}.js` },
      }),
    ),
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

const STOP: ReadonlyArray<ProviderEvent> = [
  { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
];

function toolsFor(
  count: number,
  bindings: ReadonlyArray<ToolBinding>,
  offset = 0,
): ToolPort {
  return createFakeTools(
    Array.from({ length: count }, (_unused, index) => toolResult({ ok: true }, `OUT-${offset + index + 1}`)),
    bindings,
  );
}

function portsOf(provider: ProviderPort, tools: ToolPort, permission?: PermissionPort): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: permission ?? createFakePermission("approved"),
    tools,
    provider,
  };
}

function toolMessages(request: ProviderRequest | undefined): ReadonlyArray<string> {
  return (request?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => message.toolCallId ?? "");
}

test("one response asking for four tools settles all four and the next request carries each result", async () => {
  const provider = scripted([askingFor(["c1", "c2", "c3", "c4"], "read_file"), STOP]);
  const result = await runTurn(
    portsOf(provider.port, toolsFor(4, [echoBinding({ name: "read_file", needsApproval: false })])),
    REQUEST,
  );

  assert.equal(result.state.terminalReason, "completed");
  // Every call is answered exactly once, in the order the provider asked.
  const settled = result.transcript.filter((item) => item.kind === "tool_result");

  assert.deepEqual(
    settled.map((item) => item.toolCallId),
    ["c1", "c2", "c3", "c4"],
  );
  assert.equal(result.envelopes.some((envelope) => envelope.kind === "error"), false);
  // The follow-up request must hold one `tool` message per `tool_call`, or the
  // provider rejects the whole turn for an unanswered call.
  const assistant = provider.requests[1]?.messages.find((message) => message.toolCalls !== undefined);

  assert.deepEqual(
    assistant?.toolCalls?.map((call) => call.toolCallId),
    ["c1", "c2", "c3", "c4"],
  );
  assert.deepEqual(toolMessages(provider.requests[1]), ["c1", "c2", "c3", "c4"]);
});

test("a read followed by a write that needs approval settles both, in order", async () => {
  const provider = scripted([
    [
      { type: "tool_call", toolCallId: "read-1", name: "read_file", arguments: { path: "a.js" } },
      { type: "tool_call", toolCallId: "write-1", name: "write_file", arguments: { path: "a.js" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    STOP,
  ]);
  const asked: string[] = [];
  const deciding = createFakePermission("approved");
  const permission: PermissionPort = {
    async request(action) {
      asked.push(action.toolCallId);
      return { ticketId: `tkt-${action.toolCallId}`, toolCallId: action.toolCallId };
    },
    awaitDecision: (ticketId) => deciding.awaitDecision(ticketId),
  };
  const result = await runTurn(
    portsOf(
      provider.port,
      toolsFor(2, [
        echoBinding({ name: "read_file", needsApproval: false }),
        echoBinding({ name: "write_file", sideEffect: "workspace_write" }),
      ]),
      permission,
    ),
    REQUEST,
  );

  assert.deepEqual(asked, ["write-1"]);
  assert.equal(result.state.terminalReason, "completed");
  const settled = result.transcript.filter((item) => item.kind === "tool_result");

  assert.deepEqual(
    settled.map((item) => item.toolCallId),
    ["read-1", "write-1"],
  );
  assert.deepEqual(toolMessages(provider.requests[1]), ["read-1", "write-1"]);
});

test("a refused write is a visible result, and its unapproved sibling still runs", async () => {
  const provider = scripted([
    [
      { type: "tool_call", toolCallId: "read-1", name: "read_file", arguments: { path: "a.js" } },
      { type: "tool_call", toolCallId: "write-1", name: "write_file", arguments: { path: "a.js" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    STOP,
  ]);
  const executed: string[] = [];
  const tools: ToolPort = {
    snapshot: () => [
      echoBinding({ name: "read_file", needsApproval: false }),
      echoBinding({ name: "write_file", sideEffect: "workspace_write" }),
    ],
    async execute(call) {
      executed.push(call.toolCallId);
      return toolResult({ ok: true }, `OUT-${call.toolCallId}`);
    },
    async cancel() {},
  };
  const result = await runTurn(
    portsOf(provider.port, tools, createFakePermission("denied")),
    REQUEST,
  );

  // The turn is not ended by one refusal, and the refused call never ran.
  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(executed, ["read-1"]);
  const settled = result.transcript.filter((item) => item.kind === "tool_result");

  assert.deepEqual(
    settled.map((item) => item.toolCallId),
    ["read-1", "write-1"],
  );
  const refusal = settled.find((item) => item.toolCallId === "write-1");

  assert.equal(refusal?.kind === "tool_result" ? refusal.outcome : undefined, "failed");
  assert.equal(
    refusal?.kind === "tool_result" ? refusal.output.startsWith("permission_denied") : false,
    true,
  );
  assert.deepEqual(toolMessages(provider.requests[1]), ["read-1", "write-1"]);
});

test("a response with a single tool call keeps the one-step path", async () => {
  const provider = scripted([askingFor(["only-1"], "echo"), STOP]);
  const result = await runTurn(
    portsOf(provider.port, toolsFor(1, [echoBinding({ needsApproval: false })])),
    REQUEST,
  );

  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(
    result.transcript.filter((item) => item.kind === "tool_result").map((item) => item.toolCallId),
    ["only-1"],
  );
  assert.equal(result.envelopes.some((envelope) => envelope.kind === "error"), false);
});
