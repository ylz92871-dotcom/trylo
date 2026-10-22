import assert from "node:assert/strict";
import test from "node:test";
import { runTurn } from "./runner.js";
import { createFakePermission, emptyProfileLoader, echoBinding } from "./fakes.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ToolOutcome } from "../ports/tools.js";
import type { Transcript } from "../protocol/transcript.js";
import type { Envelope } from "../protocol/envelope.js";

const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const request = { sessionId: "s", turnId: "t", correlationId: "c", text: "work" };
type Progress = { readonly transcript: Transcript; readonly envelopes: readonly Envelope[] };
type Outcome = "succeeded" | "failed" | "cancelled" | "unknown";
type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string };

function setup(outcome: ToolOutcome = { outcome: "result", value: {}, output: "done", truncated: false }) {
  const order: string[] = [];
  const transcript: Transcript[number][] = [];
  let executions = 0;
  const progress = {
    async flush(input: Progress) {
      transcript.push(...input.transcript);
      return { ok: true } as const;
    },
    async issue(key: string): Promise<WriteOutcome> { order.push("issue:" + key); return { ok: true }; },
    async settle(key: string, status: Outcome) { order.push(status + ":" + key); return { ok: true } as const; },
  };
  let beat = 0;
  const ports = {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    provider: {
      async *stream() {
        beat++;
        if (beat === 1) {
          yield { type: "tool_call", toolCallId: "call", name: "echo", arguments: {} } as const;
          yield { ...finish, reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true } as const;
        } else {
          yield finish;
        }
      },
    },
    tools: {
      snapshot: () => [echoBinding({ needsApproval: false })],
      async execute() {
        executions++;
        order.push("execute");
        assert.ok(order.includes("issue:tool:call"), "execution began before durable intent");
        assert.ok(transcript.some(item => item.kind === "user"));
        assert.ok(transcript.some(item => item.kind === "tool_call" && item.toolCallId === "call"));
        return outcome;
      },
      async cancel() {},
    },
    progress,
  };
  return { ports, order, transcript, executions: () => executions };
}

test("durability: intent and canonical request are durable before tool execution", async () => {
  const run = setup();
  const result = await runTurn(run.ports, request);
  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(run.order, ["issue:tool:call", "execute", "succeeded:tool:call"]);
  assert.ok(run.transcript.some(item => item.kind === "tool_result" && item.outcome === "succeeded"));
});

test("durability: an intent write failure prevents the tool", async () => {
  const run = setup();
  run.ports.progress.issue = async () => ({ ok: false, code: "disk_full" });
  await assert.rejects(runTurn(run.ports, request), /execution_progress_failed.*disk_full/);
  assert.equal(run.executions(), 0);
});

for (const [outcome, settled] of [
  [{ outcome: "error", code: "bad", message: "bad" }, "failed"],
  [{ outcome: "cancelled" }, "cancelled"],
  [{ outcome: "unknown", code: "lost_ack", message: "uncertain" }, "unknown"],
] as const) {
  test("durability: " + settled + " stays distinct from a successful commit", async () => {
    const run = setup(outcome);
    await runTurn(run.ports, request);
    assert.ok(run.order.includes(settled + ":tool:call"));
    assert.equal(run.order.includes("succeeded:tool:call"), false);
    assert.ok(run.transcript.some(item => item.kind === "tool_result" && item.outcome === settled));
  });
}

test("durability: a closed provider block is written while its stream is still open", async () => {
  const run = setup();
  const ports = {
    ...run.ports,
    provider: {
      async *stream() {
        yield { type: "text_start", blockId: "b" } as const;
        yield { type: "text_delta", blockId: "b", text: "observed" } as const;
        yield { type: "text_end", blockId: "b" } as const;
        assert.ok(run.transcript.some(item => item.kind === "assistant_text" && item.text === "observed"));
        yield finish;
      },
    },
  };
  const result = await runTurn(ports, request);
  assert.equal(result.state.terminalReason, "completed");
});

/**
 * L04 at the *durable* boundary, not just on the returned value.
 *
 * Pairing a cancelled turn's orphan `tool_use` blocks is only worth anything if
 * the pairing reaches the recorder: the journal is what a resumed turn is rebuilt
 * from, so a transcript that is paired on the way out of `buildTurnResult` but
 * flushed unpaired leaves the two disagreeing — and the resumed conversation is
 * missing the calls the user watched the model make.
 */
test("durability: a cancelled turn flushes synthetic results, not bare tool_use blocks", async () => {
  const run = setup();
  const controller = new AbortController();
  let markAsked: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    markAsked = resolve;
  });
  // Cut mid-stream, after the calls are in the transcript and before any of them
  // can settle — the shape that produces orphans.
  const provider: ProviderPort = {
    async *stream(_request, signal) {
      yield { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: {} };
      yield { type: "tool_call", toolCallId: "call-2", name: "echo", arguments: {} };
      markAsked();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  // The recorder accepts full views and incremental closed blocks. Accumulate
  // acknowledged facts by ordinal rather than requiring redundant last snapshots.
  const flushes: Transcript[] = [];
  const ports = {
    ...run.ports,
    provider,
    progress: {
      async flush(input: Progress) {
        flushes.push(input.transcript);
        return { ok: true } as const;
      },
      async issue() {
        return { ok: true } as const;
      },
      async settle() {
        return { ok: true } as const;
      },
    },
  };

  const turn = runTurn(ports, { ...request, cancelSignal: controller.signal });
  await asked;
  controller.abort();
  const result = await turn;

  assert.equal(result.state.terminalReason, "cancelled");
  const idsIn = (items: Transcript): string[] =>
    items.filter((item) => item.kind === "tool_result").map((item) => item.toolCallId).sort();
  const durable = idsIn([...new Map(flushes.flat().map(item => [item.sequence, item])).values()]);
  assert.deepEqual(
    durable,
    ["call-1", "call-2"],
    "the recorder must be handed a result for every tool_use the turn left open",
  );
  assert.deepEqual(
    idsIn(result.transcript),
    durable,
    "the returned and the durable transcript must be the same conversation",
  );
});
