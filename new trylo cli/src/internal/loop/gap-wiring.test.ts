import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingUserInput } from "../domain/input-queue.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import {
  createFakePermission,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
} from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * The gap wiring, driven through `runTurn` only (WP D 波 §5.2).
 *
 * The reducer can refuse a steer in every phase but one and the queue can
 * promote the right messages, and the feature would still be a lie if the loop
 * never sent them. These cases are the loop's half: a run with no port must be
 * indistinguishable from a run before the port existed, and a run with one must
 * put the message where the model can actually see it.
 */

const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "use the tool" };

/**
 * `toolIterations` tool-calling streams that each ask for a follow-up, then one
 * plain stop: every tool settles inside its own iteration, so the gap after it
 * is a real gap.
 */
function scriptFor(toolIterations: number): ReadonlyArray<ReadonlyArray<ProviderEvent>> {
  const script: Array<ReadonlyArray<ProviderEvent>> = [];

  for (let index = 0; index < toolIterations; index += 1) {
    script.push([
      { type: "tool_call", toolCallId: `call-${index}`, name: "echo", arguments: { text: "hi" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ]);
  }

  script.push([{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]);

  return script;
}

function recordingProvider(
  toolIterations = 1,
): { readonly requests: ProviderRequest[]; readonly port: ProviderPort } {
  const script = scriptFor(toolIterations);
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

function portsOf(
  provider: ProviderPort,
  pendingInput?: (turnId: string) => ReadonlyArray<PendingUserInput>,
): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({ echo: "hi" }, "TOOL-OUTPUT")], [
      echoBinding({ needsApproval: false }),
    ]),
    provider,
    ...(pendingInput === undefined ? {} : { pendingInput }),
  };
}

function messageText(request: ProviderRequest | undefined): string {
  return (request?.messages ?? []).map((message) => message.content).join("\n");
}

test("a run with no pendingInput port is byte for byte the run before it", async () => {
  const provider = recordingProvider();
  const result = await runTurn(portsOf(provider.port), REQUEST);

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(
    result.inputs.some((input) => input.type === "user_input"),
    false,
  );
  assert.equal(
    result.envelopes.some((envelope) => envelope.kind === "user_correction"),
    false,
  );
  assert.equal(
    result.transcript.some((item) => item.kind === "user" && item.text === "STEER-MARKER"),
    false,
  );
});

test("a steer typed mid-run reaches the next request and the model sees it", async () => {
  const provider = recordingProvider(2);
  let handedOver = false;
  const result = await runTurn(
    portsOf(provider.port, () => {
      if (handedOver) {
        return [];
      }
      handedOver = true;
      return [{ text: "STEER-MARKER", mode: "steer" }];
    }),
    REQUEST,
  );

  assert.equal(result.state.terminalReason, "completed");

  const steers = result.inputs.filter((input) => input.type === "user_input");

  assert.equal(steers.length, 1);
  assert.equal(steers[0]?.mode, "steer");

  // The whole point of a boundary: the message waits for the tool to settle.
  const steerAt = result.inputs.findIndex((input) => input.type === "user_input");
  const toolSettledAt = result.inputs.findIndex((input) => input.type === "tool_succeeded");

  assert.equal(toolSettledAt >= 0, true);
  assert.equal(steerAt > toolSettledAt, true);

  // A steer the model never sees is not a steer.
  const last = provider.requests.at(-1);

  assert.equal(messageText(last).includes("STEER-MARKER"), true);
});

test("a queued message is taken one gap at a time, and a blank one never", async () => {
  const provider = recordingProvider(4);
  const batch: ReadonlyArray<PendingUserInput> = [
    { text: "", mode: "queue" },
    { text: "FIRST-MARKER", mode: "queue" },
    { text: "SECOND-MARKER", mode: "queue" },
  ];
  let index = 0;
  const result = await runTurn(
    portsOf(provider.port, () => {
      const next = batch[index];
      index += 1;
      return next === undefined ? [] : [next];
    }),
    { ...REQUEST, budget: { maxIterations: 6 } },
  );
  const texts = result.inputs
    .filter((input) => input.type === "user_input")
    .map((input) => (input.type === "user_input" ? input.text : ""));

  assert.deepEqual(texts, ["FIRST-MARKER", "SECOND-MARKER"]);
});

test("a host that never stops offering input is bounded by the iteration budget", async () => {
  const provider = recordingProvider(4);
  const result = await runTurn(
    portsOf(provider.port, () => [{ text: "AGAIN-MARKER", mode: "queue" }]),
    { ...REQUEST, budget: { maxIterations: 3 } },
  );

  assert.equal(result.state.terminalReason, "failed");
  assert.equal(provider.requests.length <= 3, true);
});
