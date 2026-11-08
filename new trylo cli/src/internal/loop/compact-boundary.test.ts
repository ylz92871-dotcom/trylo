import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyUsage,
  type ProviderEvent,
  type ProviderPort,
  type ProviderRequest,
} from "../ports/provider.js";
import {
  createFakeCompaction,
  createFakePermission,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
  type FakeCompaction,
} from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";
import { assembleEngine } from "./runner-engine.js";
import { budgetCeiling } from "./budget-gate.js";
import { capturePromptMeasurement } from "./prompt-measurement.js";
import { buildRequest } from "./request.js";
import { promptContextFor } from "./compact-boundary.js";

/**
 * The compaction wiring contract (WP-HY4 §2.2), driven through `runTurn` only.
 *
 * Every case here is a way a plausible wiring could look finished while being
 * wrong: a window stored but the original text still in the next prompt, a
 * second window in the same turn, a refusal that quietly deletes history, a
 * compaction that cancels the hard gate it exists to avoid.
 *
 * The double wraps the shipping compaction service, so the threshold, the
 * read-time filter and the summary red-line under test are the real ones.
 */

const ORIGINAL = "ORIGINAL-SEGMENT-MARKER";
const TOOL_OUTPUT = "TOOL-OUTPUT-MARKER";
const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "use the tool" };

test("new progress can clear the context ceiling more than twice in one turn", async () => {
  const compaction = createFakeCompaction({ estimatedAfterCompactionTokens: 500 });
  const ports = portsOf(recordingProvider([]).port, compaction);
  const engine = await assembleEngine(ports, { ...REQUEST, budget: { contextTokenLimit: 8000 } }, new AbortController());

  engine.state = { ...engine.state, sessionId: "s", turnId: "t" };

  for (let index = 0; index < 4; index++) {
    engine.transcript = [...engine.transcript, { kind: "assistant_text", sequence: engine.transcript.length + 1,
      blockId: `progress-${index}`, text: `completed new work ${index}` }];
    engine.compaction.attempted = true;
    engine.promptReport = { promptTokens: 9000, transcriptLength: engine.transcript.length,
      measurement: capturePromptMeasurement(buildRequest({ attemptId: "a", model: engine.model, tools: ports.tools,
        prompt: promptContextFor(engine, ports.compaction, ports.tools) })),
      windowId: engine.compaction.window?.windowId };
    assert.equal(await budgetCeiling(engine, ports), false, `new progress ${index} can be compacted`);
  }

  assert.equal(engine.compaction.entries.length, 4);
});

function recordingProvider(script: ReadonlyArray<ReadonlyArray<ProviderEvent>>): {
  readonly requests: ProviderRequest[];
  readonly port: ProviderPort;
} {
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

/**
 * `iterations` tool-calling streams — the first one also says the marker text —
 * followed by a plain stop, so every tool call settles inside its own iteration.
 */
function toolTurnScript(iterations: number): ReadonlyArray<ReadonlyArray<ProviderEvent>> {
  const script: Array<ReadonlyArray<ProviderEvent>> = [];

  for (let index = 0; index < iterations; index += 1) {
    const text: ReadonlyArray<ProviderEvent> =
      index === 0
        ? [
            { type: "text_start", blockId: "b1" },
            { type: "text_delta", blockId: "b1", text: ORIGINAL },
            { type: "text_end", blockId: "b1" },
          ]
        : [];
    script.push([
      ...text,
      { type: "tool_call", toolCallId: `call-${index}`, name: "echo", arguments: { text: "hi" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ]);
  }

  script.push([{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]);

  return script;
}

function portsOf(provider: ProviderPort, compaction?: FakeCompaction): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({ echo: "hi" }, TOOL_OUTPUT)], [
      echoBinding({ needsApproval: false }),
    ]),
    provider,
    ...(compaction === undefined ? {} : { compaction: compaction.wiring }),
  };
}

/** The whole prompt as one string, so a case can scan it for replaced text. */
function messageText(request: ProviderRequest | undefined): string {
  return (request?.messages ?? []).map((message) => message.content).join("\n");
}

function compactEnvelopes(result: Awaited<ReturnType<typeof runTurn>>) {
  return result.envelopes.filter((envelope) => envelope.kind === "compact");
}

function terminalEnvelope(result: Awaited<ReturnType<typeof runTurn>>) {
  return result.envelopes.filter((envelope) => envelope.kind === "terminal").at(-1);
}

test("without an injected compaction port the run stores no compact record", async () => {
  const provider = recordingProvider(toolTurnScript(1));
  const result = await runTurn(portsOf(provider.port), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 0);
  assert.equal(compactEnvelopes(result).length, 0);
  assert.equal(provider.requests.length, 2);
  const second = messageText(provider.requests[1]);

  assert.equal(second.includes(ORIGINAL), true);
  assert.equal(second.includes(TOOL_OUTPUT), true);
});

test("over the estimated limit one window is stored and the next request drops the replaced text", async () => {
  const provider = recordingProvider(toolTurnScript(1));
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000, estimatedAfterCompactionTokens: 500 });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(provider.requests.length, 2);

  assert.equal(result.compactions.length, 1);
  const draft = result.compactions[0];

  assert.equal(draft?.type, "compact");
  assert.equal(draft?.sessionId, "s");
  assert.equal(draft?.payload.windowId, "w1");
  assert.equal(draft?.payload.replacedFromSequence, 0);
  // Bounds are journal sequences. Sequence 0 is `session_start` and the four
  // transcript items occupy 1..4, so the window covers the lot. Numbering from
  // the transcript instead would stop one short and leave the last item live.
  assert.equal(draft?.payload.replacedToSequence, 4);
  assert.equal(draft?.payload.summary, "SUMMARY-MARKER");

  const envelopes = compactEnvelopes(result);

  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]?.payload["compactId"], "w1");
  assert.equal(envelopes[0]?.payload["droppedEvents"], 4);

  // Scanning the second prompt is the point: a stored record proves nothing on
  // its own, because the model keeps seeing the original unless the read-time
  // filter ran. The latest assistant/tool exchange remains intact beside the
  // summary; its assistant text is part of the same live action, while the
  // original user instructions remain verbatim outside the lossy summary.
  // This also preserves native continuations.
  const second = messageText(provider.requests[1]);

  assert.equal(second.includes(ORIGINAL), true);
  assert.equal(second.includes(REQUEST.text), true);
  assert.equal(second.includes(TOOL_OUTPUT), true, "the newest tool result stays live under the window");
  assert.equal(second.includes("SUMMARY-MARKER"), true);

  // The gap is after the tools settle, so the digest covers the result too.
  assert.equal(compaction.summarizeInputs.length, 1);
  assert.equal(
    compaction.summarizeInputs[0]?.some((item) => item.kind === "tool_result"),
    true,
  );
});

test("an irreducible local basis stops before another provider request even without reported usage", async () => {
  // A stored summary does not clear the ceiling when its measured view remains
  // over it. One bounded rescue may try, but it cannot license another request.
  const provider = recordingProvider(toolTurnScript(3));
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000 });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "failed");
  assert.equal(terminalEnvelope(result)?.payload["cause"], "context_limit");
  assert.equal(provider.requests.length, 1);
  assert.equal(compaction.compactRequests.length, 2);
  assert.equal(result.compactions.length, 1);
  assert.equal(compactEnvelopes(result).length, 1);
});

test("the ceiling rescue forces a second window and the turn continues under it", async () => {
  // WP09.2/C37: the probe stored w1 at the first gap, but the task kept
  // growing until the provider itself reported over the ceiling. The rescue
  // may not be silenced by the probe's latch: it forces w2, re-judges the
  // post-window basis, and — the view being genuinely under the ceiling — the
  // turn continues instead of ending on a stale report.
  // First consume w1's reinserted exchange. Measure the next live exchange,
  // which remains present when the report is used; the covered exchange alone
  // leaves the prompt after consumption and cannot support a lasting floor.
  const provider = recordingProvider([
    [
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: {} },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [
      { type: "tool_call", toolCallId: "call-2", name: "echo", arguments: {} },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [
      {
        type: "usage",
        usage: { ...emptyUsage("snapshot"), inputTokens: 9_000, outputTokens: 10, totalTokens: 9_010 },
      },
      { type: "tool_call", toolCallId: "call-3", name: "echo", arguments: {} },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const compaction = createFakeCompaction({
    estimatedPromptTokens: 9_000,
    estimatedAfterCompactionTokens: 500,
  });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(result.compactions.map((draft) => draft.payload.windowId), ["w1", "w2"]);
  const w1 = result.compactions[0]?.payload;
  const w2 = result.compactions[1]?.payload;

  assert.ok(w1 !== undefined && w2 !== undefined, "both windows exist");
  assert.ok(
    w2.replacedFromSequence > w1.replacedToSequence,
    `w2 starts at ${w2.replacedFromSequence}, after w1 ending at ${w1.replacedToSequence}`,
  );
  assert.equal(provider.requests.length, 4);
});

test("a rescue that cleared the view lets the turn continue instead of ending on a stale report", async () => {
  // WP09.2/C37: the provider's report made the ceiling fire, but a window
  // stored at the gap already replaced the history that made it over. The
  // pre-fix loop re-read the stale report at the next pre-iteration check and
  // ended the turn `waiting:context_limit` with the window in hand — compact
  // without the promised continue.
  const provider = recordingProvider([
    [
      {
        type: "usage",
        usage: {
          ...emptyUsage("snapshot"),
          inputTokens: 9_000,
          outputTokens: 10,
          totalTokens: 9_010,
        },
      },
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: {} },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const compaction = createFakeCompaction({
    estimatedPromptTokens: 9_000,
    estimatedAfterCompactionTokens: 500,
  });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  // The window was stored and the provider was asked again under it.
  assert.equal(result.compactions.length, 1);
  assert.equal(provider.requests.length, 2);
  const second = messageText(provider.requests[1]);

  assert.equal(second.includes("SUMMARY-MARKER"), true);
  const terminal = terminalEnvelope(result);

  assert.equal(terminal?.payload["cause"], undefined);
});

test("compaction does not cancel the context_limit hard gate", async () => {
  const provider = recordingProvider([
    [
      {
        type: "usage",
        usage: {
          ...emptyUsage("snapshot"),
          inputTokens: 9_000,
          outputTokens: 10,
          totalTokens: 9_010,
        },
      },
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: {} },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000 });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "failed");
  assert.equal(terminalEnvelope(result)?.payload["cause"], "context_limit");
  // Compact once, then the gate: the provider is never asked a second time.
  assert.equal(result.compactions.length, 1);
  assert.equal(provider.requests.length, 1);
});

test("a summary carrying an absolute path is refused and replaces nothing", async () => {
  const provider = recordingProvider(toolTurnScript(3));
  const compaction = createFakeCompaction({
    estimatedPromptTokens: 9_000,
    summary: "wrote C:\\Users\\me\\notes.txt",
  });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 6, contextTokenLimit: 8_000 },
  });

  assert.equal(result.compactions.length, 0);
  assert.equal(compactEnvelopes(result).length, 0);
  // The known-over-limit view permits one bounded ceiling rescue, then stops.
  assert.equal(compaction.compactRequests.length, 2);
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(provider.requests.length, 1);

  const refusal = result.envelopes.find(
    (envelope) => envelope.kind === "observation" && envelope.payload["component"] === "compaction" && envelope.payload["degraded"] === true,
  );

  assert.notEqual(refusal, undefined);
  assert.equal(refusal?.payload["reason"], "summary_unsafe");
  // The diagnosis names the code, never the text it refused.
  assert.equal(JSON.stringify(refusal?.payload ?? {}).includes("Users"), false);

  // Failing closed means "nothing was replaced", not "the history went missing".
  assert.equal(result.transcript.some(item => item.kind === "assistant_text" && item.text.includes(ORIGINAL)), true);
});

test("an injected port with no configured ceiling never compacts", async () => {
  const provider = recordingProvider(toolTurnScript(1));
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000_000 });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 4 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 0);
  assert.equal(compaction.compactRequests.length, 0);
  assert.equal(messageText(provider.requests[1]).includes(ORIGINAL), true);
});

test("a short conversation under the ceiling is left alone", async () => {
  const provider = recordingProvider(toolTurnScript(1));
  const compaction = createFakeCompaction({ estimatedPromptTokens: 10 });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 0);
  assert.equal(compaction.compactRequests.length, 0);
  assert.equal(compactEnvelopes(result).length, 0);
  assert.equal(messageText(provider.requests[1]).includes(TOOL_OUTPUT), true);
});

test("a conversation with no tool call has no gap and so is never compacted", async () => {
  // Compaction lives in the gap between iterations. A turn that finishes in one
  // stream has no gap, so size alone cannot compact it — what catches an
  // oversized single-stream turn is still the `context_limit` hard gate.
  const provider = recordingProvider([
    [
      { type: "text_start", blockId: "b1" },
      { type: "text_delta", blockId: "b1", text: ORIGINAL },
      { type: "text_end", blockId: "b1" },
      { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
    ],
  ]);
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000 });
  const result = await runTurn(portsOf(provider.port, compaction), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(provider.requests.length, 1);
  assert.equal(result.compactions.length, 0);
  assert.equal(compaction.compactRequests.length, 0);
  assert.equal(compactEnvelopes(result).length, 0);
  // Nothing was replaced: the assistant's own words are still in the transcript.
  assert.equal(
    result.transcript.some(
      (item) => item.kind === "assistant_text" && item.text.includes(ORIGINAL),
    ),
    true,
  );
});

