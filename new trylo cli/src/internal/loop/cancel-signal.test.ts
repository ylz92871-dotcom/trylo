import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
} from "./fakes.js";
import { runTurn, type LoopPorts, type RunTurnRequest } from "./runner.js";

/**
 * The cancellation exposure port (WP `2026-09-16-WP-传统CLI-交付面收尾波` D3).
 *
 * What is being pinned here is *ordering*, which is the whole reason this is a
 * loop change and not a surface one:
 *
 *  - a cancel raised while a stream is open ends the turn `cancelled` — and it
 *    does so even when the adapter reports the cut as *nothing at all* rather
 *    than a `cancel_ack`, because the transition is the loop's own, not the
 *    adapter's opinion;
 *  - a cancel raised while a **tool** is running does not touch the tool's
 *    signal: it waits for the boundary, so a write in flight is never stopped
 *    behind `cancel_tool`'s back;
 *  - a turn whose last beat is about to complete still obeys a cancel that
 *    arrived during it, rather than racing it to `completed`;
 *  - with no `cancelSignal` on the request, every byte of the turn is what it
 *    was before this field existed.
 */

function textBlock(blockId: string, text: string): readonly ProviderEvent[] {
  return [
    { type: "text_start", blockId },
    { type: "text_delta", blockId, text },
    { type: "text_end", blockId },
  ];
}

const stop: ProviderEvent = {
  type: "finish",
  reason: "stop",
  rawReason: "stop",
  requiresFollowUp: false,
};

function request(text: string, signal?: AbortSignal): RunTurnRequest {
  return {
    sessionId: "ses-cancel",
    turnId: "trn-cancel",
    correlationId: "cor-cancel",
    text,
    ...(signal === undefined ? {} : { cancelSignal: signal }),
  };
}

function ports(provider: ProviderPort, tools: ToolPort = createFakeTools([])): LoopPorts {
  return {
    provider,
    tools,
    permission: createFakePermission("approved"),
    profile: emptyProfileLoader(),
  };
}

/**
 * A stream that stays open until it is cut and then ends *silently* — no
 * `cancel_ack`, no `error`. This is the adapter the loop must not depend on:
 * if the turn still ends `cancelled`, the transition came from the loop.
 */
function openEndedProvider(): { readonly port: ProviderPort; readonly reached: Promise<void> } {
  let markReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const port: ProviderPort = {
    async *stream(_request, signal) {
      yield { type: "stream_start", providerId: "fake", model: "fake", warnings: [] };
      yield* textBlock("b1", "partial");
      markReached();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };

  return { port, reached };
}

function cancelled(result: Awaited<ReturnType<typeof runTurn>>): void {
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(
    result.envelopes.some((envelope) => envelope.kind === "user_cancel"),
    true,
    "the journal must hold the cancel as a fact",
  );
  assert.equal(
    result.envelopes.some((envelope) => envelope.kind === "error"),
    false,
    "a cancel is a state transition, never an error",
  );
}

test("without a cancelSignal the turn is untouched: same stream, same terminal state", async () => {
  const result = await runTurn(
    ports(createFakeProvider([[...textBlock("b1", "hello"), stop]])),
    request("no signal here"),
  );
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.envelopes.some((envelope) => envelope.kind === "user_cancel"), false);
});

test("an adapter that ends the cut silently still yields a cancelled turn", async () => {
  const controller = new AbortController();
  const { port, reached } = openEndedProvider();
  const running = runTurn(ports(port), request("cut me", controller.signal));
  await reached;
  controller.abort();
  cancelled(await running);
});

test("an adapter that acks the cut yields the same cancelled turn", async () => {
  const controller = new AbortController();
  const { port, reached } = openEndedProvider();
  const acking: ProviderPort = {
    async *stream(request_, signal) {
      // Same stream, but it answers the cut the way the fixture adapter does.
      const inner = port.stream(request_, signal)[Symbol.asyncIterator]();

      for (;;) {
        const step = await inner.next();
        if (step.done === true) {
          break;
        }
        yield step.value;
      }

      if (signal.aborted) {
        yield { type: "cancel_ack" };
      }
    },
  };
  const running = runTurn(ports(acking), request("cut me", controller.signal));

  await reached;
  controller.abort();
  cancelled(await running);
});

test("a cancel raised before the turn starts still lands as cancelled, not failed", async () => {
  const controller = new AbortController();

  controller.abort();
  const result = await runTurn(
    ports(createFakeProvider([[...textBlock("b1", "never sent"), stop]])),
    request("already cancelled", controller.signal),
  );

  cancelled(result);
});

test("a cancel raised while a tool runs waits for the boundary and never aborts the tool", async () => {
  const controller = new AbortController();
  const toolSignals: boolean[] = [];
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tools: ToolPort = {
    snapshot: () => [echoBinding({ needsApproval: false })],
    async execute(_call, signal) {
      markStarted();
      // Long enough that the abort below is raised while this is still open.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      });
      toolSignals.push(signal.aborted);

      return toolResult({ ok: true });
    },
    async cancel() {
      return;
    },
  };
  const provider = createFakeProvider([
    [
      { type: "tool_input_start", toolCallId: "call-1", name: "echo" },
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { text: "hi" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
  ]);
  const running = runTurn(ports(provider, tools), request("cancel during a tool", controller.signal));

  await started;
  controller.abort();
  const result = await running;

  assert.deepEqual(toolSignals, [false], "the tool's own signal must not be cut mid-execution");
  cancelled(result);
});

test("a cancel that arrives on the last beat beats the completion it was racing", async () => {
  const controller = new AbortController();
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tools: ToolPort = {
    snapshot: () => [echoBinding({ needsApproval: false })],
    async execute() {
      markStarted();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      return toolResult({ ok: true });
    },
    async cancel() {
      return;
    },
  };
  const provider = createFakeProvider([
    [
      { type: "tool_input_start", toolCallId: "call-1", name: "echo" },
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { text: "hi" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [...textBlock("b2", "all done"), stop],
  ]);
  const running = runTurn(ports(provider, tools), request("race the ending", controller.signal));

  await started;
  controller.abort();
  cancelled(await running);
});
