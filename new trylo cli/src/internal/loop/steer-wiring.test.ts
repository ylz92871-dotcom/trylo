import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PENDING_INPUT, type AddressedUserInput } from "../domain/input-queue.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { PhaseName } from "../domain/state.js";
import type { ReduceInput } from "../domain/input.js";
import {
  createFakePermission,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
} from "./fakes.js";
import { drainPendingInput, type GapHost } from "./iteration-gap.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * WP08.1 and WP08.3, at the loop: what a turn is allowed to take, and what it
 * must hand back.
 *
 * The inbox's own rules are tested in `domain/input-queue.test.ts`. These cases
 * are the consumer's half — the half that has to hold even when the host is not
 * an inbox — and the recovery half: a turn that took a person's words and then
 * ended has to say so, because "accepted and then never answered" is otherwise
 * indistinguishable from "heard, understood, acted on".
 */

const REQUEST = { sessionId: "s", turnId: "turn-under-test", correlationId: "c", text: "use the tool" };

/**
 * One tool call per iteration, each asking for a follow-up: every tool settles
 * inside its own iteration, so the gap after it is a real gap.
 */
function endlessToolProvider(): { readonly requests: unknown[]; readonly port: ProviderPort } {
  const requests: unknown[] = [];
  return {
    requests,
    port: {
      async *stream(request) {
        requests.push(request);
        const events: ReadonlyArray<ProviderEvent> = [
          { type: "tool_call", toolCallId: `call-${requests.length}`, name: "echo", arguments: { text: "hi" } },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ];

        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

function portsOf(
  provider: ProviderPort,
  pendingInput: (turnId: string) => ReadonlyArray<AddressedUserInput>,
): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({ echo: "hi" }, "TOOL-OUTPUT")], [
      echoBinding({ needsApproval: false }),
    ]),
    provider,
    pendingInput,
  };
}

test("a message addressed to another turn is never promoted into this one", async () => {
  const provider = endlessToolProvider();
  let handedOver = false;
  const result = await runTurn(
    portsOf(provider.port, () => {
      if (handedOver) {
        return [];
      }

      handedOver = true;

      // Typed for the turn before this one: the late arrival the work package
      // exists to stop.
      return [{ text: "LATE-FROM-THE-PREVIOUS-TURN", mode: "steer", turnId: "turn-before" }];
    }),
    { ...REQUEST, budget: { maxIterations: 3 } },
  );

  assert.equal(
    result.inputs.some((input) => input.type === "user_input"),
    false,
    "a foreign turn's message must not be dispatched",
  );
  assert.equal(
    result.envelopes.some((envelope) => envelope.kind === "user_correction"),
    false,
  );
  assert.deepEqual(result.unconsumedInput, [], "and it must not be reported as this turn's debt either");
});

test("a message addressed to this turn is promoted, and the same host is not asked twice for it", async () => {
  const provider = endlessToolProvider();
  let handedOver = false;
  const result = await runTurn(
    portsOf(provider.port, () => {
      if (handedOver) {
        return [];
      }
      handedOver = true;
      return [{ text: "ADDRESSED-HERE", mode: "steer", turnId: REQUEST.turnId }];
    }),
    { ...REQUEST, budget: { maxIterations: 3 } },
  );
  const steers = result.inputs.filter((input) => input.type === "user_input");

  assert.equal(steers.length, 1, "consumed exactly once");
  assert.equal(steers[0]?.text, "ADDRESSED-HERE");
  assert.deepEqual(result.unconsumedInput, []);
});

test("a host that floods the turn loses nothing: everything is delivered or handed back", async () => {
  const provider = endlessToolProvider();
  let calls = 0;
  const offered: string[] = [];
  const result = await runTurn(
    portsOf(provider.port, () => {
      calls += 1;
      // More than the ceiling every single time: a host that never stops.
      const batch = Array.from({ length: MAX_PENDING_INPUT + 4 }, (_unused, index) => ({
        text: `flood-${calls}-${index}`,
        mode: "queue" as const,
        turnId: REQUEST.turnId,
      }));

      offered.push(...batch.map((item) => item.text));

      return batch;
    }),
    { ...REQUEST, budget: { maxIterations: 2 } },
  );

  assert.equal(result.state.terminalReason, "failed");
  const delivered = result.inputs
    .filter((input) => input.type === "user_input")
    .map((input) => input.text);
  const accounted = new Set([...delivered, ...result.unconsumedInput.map((item) => item.text)]);
  const lost = offered.filter((text) => !accounted.has(text));

  assert.deepEqual(lost, [], "no message may vanish between the host and the result");
  assert.equal(calls <= 2, true, `the loop must stop asking; it asked ${calls} times`);
});

test("what a turn took and never delivered is handed back, not forgotten", async () => {
  const provider = endlessToolProvider();
  let handedOver = false;
  const result = await runTurn(
    portsOf(provider.port, () => {
      if (handedOver) {
        return [];
      }

      handedOver = true;

      return [
        { text: "DELIVERED", mode: "queue", turnId: REQUEST.turnId },
        { text: "NEVER-DELIVERED-1", mode: "queue", turnId: REQUEST.turnId },
        { text: "NEVER-DELIVERED-2", mode: "queue", turnId: REQUEST.turnId },
      ];
    }),
    // One iteration only: the gap promotes a single queued message and the
    // budget ends the turn with the other two still held.
    { ...REQUEST, budget: { maxIterations: 1 } },
  );

  assert.equal(result.state.terminalReason, "failed");
  const delivered = result.inputs.filter((input) => input.type === "user_input").map((input) => input.text);

  assert.deepEqual(delivered, ["DELIVERED"], "a queue promotes one message per gap");
  assert.deepEqual(
    result.unconsumedInput.map((input) => input.text),
    ["NEVER-DELIVERED-1", "NEVER-DELIVERED-2"],
    "the ones the turn never answered must come back",
  );
  assert.equal(
    result.unconsumedInput.every((input) => input.turnId === REQUEST.turnId),
    true,
    "and they come back addressed, so the surface can re-offer them to a named turn",
  );
});

test("a turn that consumed everything reports no debt", async () => {
  const provider = endlessToolProvider();
  const result = await runTurn(portsOf(provider.port, () => []), {
    ...REQUEST,
    budget: { maxIterations: 2 },
  });
  assert.deepEqual(result.unconsumedInput, []);
});

test("one steer still buys back the steps the run spent going the wrong way", async () => {
  const provider = endlessToolProvider();
  let handedOver = false;

  await runTurn(
    portsOf(provider.port, () => {
      if (handedOver) {
        return [];
      }
      handedOver = true;
      return [{ text: "STEER-ONE", mode: "steer", turnId: REQUEST.turnId }];
    }),
    { ...REQUEST, budget: { maxIterations: 2 } },
  );
  // Two steps of budget, one of them refunded: three requests, the third being
  // the one the redirect bought.
  assert.equal(provider.requests.length, 3);
});

/**
 * The ceiling, against a person who will not stop redirecting.
 *
 * This is the case the refund was quietly breaking: a steer at every gap reset
 * the counter every time, so a turn whose budget was three ran 41 provider
 * requests for 40 messages and stopped only because the host ran out of things
 * to offer. The budget existed on paper and nowhere else. Measured here with an
 * offer that outlives any sane budget, so a regression cannot hide behind a host
 * that stops early.
 */
test("a steer at every gap cannot buy an unbounded turn", async () => {
  const provider = endlessToolProvider();
  let offered = 0;
  const result = await runTurn(
    portsOf(provider.port, () => {
      offered += 1;
      if (offered > 50) {
        return [];
      }
      return [{ text: `steer-${offered}`, mode: "steer", turnId: REQUEST.turnId }];
    }),
    { ...REQUEST, budget: { maxIterations: 3 } },
  );

  assert.equal(result.state.phase, "terminal", "the turn must end");
  // A refund comes out of an allowance no larger than one turn's budget, so the
  // ceiling can be bought once and not again: at most twice the steps.
  assert.equal(
    provider.requests.length <= 6,
    true,
    `the budget must still bind — ${provider.requests.length} requests for ${offered} steers`,
  );
});

/**
 * The drain itself, without a turn around it.
 *
 * The integration cases above can only observe what the result chose to report;
 * the ceiling is a fact about the queue, so it is measured here, on the one
 * function that fills it.
 */
function hostFor(incoming: ReadonlyArray<AddressedUserInput>) {
  let queue: ReadonlyArray<AddressedUserInput> = [];
  const aside: AddressedUserInput[] = [];
  let asks = 0;
  const host: GapHost = {
    phase: (): PhaseName => "turning",
    pending: () => {
      asks += 1;
      return incoming;
    },
    queue: () => queue,
    setQueue: (next) => {
      queue = next;
    },
    setAside: (items) => {
      aside.push(...items);
    },
    forgiveBudget: () => {},
    dispatch: async (_input: ReduceInput) => {},
    nextEventId: () => "evt",
    appendUser: () => {},
  };

  return { host, aside, queueLength: () => queue.length, asks: () => asks };
}

test("a drain never pushes the queue past the ceiling, and sets the excess aside", () => {
  const incoming = Array.from({ length: MAX_PENDING_INPUT + 4 }, (_unused, index) => ({
    text: `m${index}`,
    mode: "queue" as const,
    turnId: REQUEST.turnId,
  }));
  const { host, aside, queueLength } = hostFor(incoming);
  const count = drainPendingInput(host, REQUEST.turnId);

  assert.equal(count, MAX_PENDING_INPUT);
  assert.equal(queueLength(), MAX_PENDING_INPUT);
  assert.equal(aside.length, 4);
  assert.deepEqual(aside.map((item) => item.text), ["m8", "m9", "m10", "m11"]);
});

test("a queue already at the ceiling is not asked for another thing", () => {
  const { host, asks, queueLength } = hostFor([{ text: "more", mode: "queue", turnId: REQUEST.turnId }]);

  // Fill it the way a turn would: repeatedly, through the same drain.
  for (let index = 0; index < MAX_PENDING_INPUT + 2; index += 1) {
    drainPendingInput(host, REQUEST.turnId);
  }

  assert.equal(queueLength(), MAX_PENDING_INPUT);
  assert.equal(asks(), MAX_PENDING_INPUT, "the drain stops asking once there is no room");
});

test("a drain takes nothing that is addressed to another turn", () => {
  const { host, queueLength } = hostFor([
    { text: "mine", mode: "steer", turnId: REQUEST.turnId },
    { text: "not mine", mode: "steer", turnId: "some-other-turn" },
  ]);
  drainPendingInput(host, REQUEST.turnId);
  assert.equal(queueLength(), 1);
});
