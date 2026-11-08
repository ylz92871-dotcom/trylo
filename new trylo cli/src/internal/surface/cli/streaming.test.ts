import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  emptyProfileLoader,
  toolResult,
} from "../../loop/fakes.js";
import { runTurn, type LoopPorts, type RunTurnRequest, type RunTurnResult } from "../../loop/runner.js";
import type { CliUsage } from "../../protocol/cli-stream.js";
import type { Envelope } from "../../protocol/envelope.js";
import { projectRun, type RunResultMeta, type TerminalFacts } from "./projection.js";
import { createProjection, createTurnRenderer, type CliSink } from "./render.js";

/**
 * Track A's own criteria: A1 (incremental output really is incremental) and
 * A3 (and it is byte-identical to what a piped run produced before).
 *
 * Both are written to survive a slow machine. A1 does not measure time — it
 * asks whether the turn's own promise had settled at the moment the observer
 * was called, which is a fact about ordering and cannot flake. A3 compares the
 * two renderings of the *same* finished turn rather than two runs, so there is
 * nothing left for the clock or the scheduler to vary.
 *
 * The end-to-end half of A3 — two real `trylo run` processes over a pipe, their
 * stdout md5s compared — is recorded in `LB-RUN.md`; it needs the built binary
 * and is not something a unit test can honestly stand in for.
 */

function ports(): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    provider: createFakeProvider([
      [
        { type: "text_start", blockId: "b1" },
        { type: "text_delta", blockId: "b1", text: "中" },
        { type: "text_delta", blockId: "b1", text: "文" },
        { type: "text_end", blockId: "b1" },
        { type: "tool_input_start", toolCallId: "call-1", name: "echo" },
        { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { text: "hi" } },
        // Every iteration has to end with the provider's own terminal fact: a
        // stream that simply stops is a transport failure, not a finish.
        { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
      ],
      [
        { type: "text_start", blockId: "b2" },
        { type: "text_delta", blockId: "b2", text: "done" },
        { type: "text_end", blockId: "b2" },
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ],
    ]),
    tools: createFakeTools([toolResult({ echo: "hi" })]),
    permission: createFakePermission("approved"),
  };
}

function request(overrides: Partial<RunTurnRequest> = {}): RunTurnRequest {
  return {
    sessionId: "ses-1",
    turnId: "trn-1",
    correlationId: "cor-1",
    text: "hello",
    ...overrides,
  };
}

function usageOf(result: RunTurnResult): CliUsage {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    totalTokens: result.usage.totalTokens,
  };
}

function metaOf(result: RunTurnResult): RunResultMeta {
  return {
    sessionId: "ses-1",
    turnId: "trn-1",
    providerId: "fake",
    model: "fake-model",
    iterations: result.iterations,
    durationMs: 0,
  };
}

/** Both streams, so "the bytes a scripted consumer sees" means all of them. */
function capture(): { readonly sink: CliSink; readonly bytes: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    bytes: () => `stdout:${out.join("")}\nstderr:${err.join("")}`,
  };
}

test("A1: the observer sees every envelope before the turn settles, in order", async () => {
  let settled = false;
  const seen: Envelope[] = [];
  const early: Envelope[] = [];
  const result = await runTurn(
    ports(),
    request({
      onEnvelope: (envelope) => {
        seen.push(envelope);
        if (!settled) {
          early.push(envelope);
        }
      },
    }),
  ).then((value) => {
    settled = true;
    return value;
  });

  assert.equal(seen.length > 0, true, "the observer was never called; nothing is incremental");
  assert.deepEqual(
    early,
    seen,
    "an envelope reached the observer only after the turn had settled — that is batching, not streaming",
  );
  assert.deepEqual(seen, [...result.envelopes], "the observer must see the journal itself, envelope for envelope");
});

test("D1: a throwing observer degrades, it never fails the turn", async () => {
  const result = await runTurn(
    ports(),
    request({
      onEnvelope: () => {
        throw new Error("the observer has a bug of its own");
      },
    }),
  );

  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.envelopes.length > 0, true);
});

test("an absent observer changes nothing about the turn", async () => {
  const without = await runTurn(ports(), request());
  const observed = await runTurn(
    ports(),
    request({
      onEnvelope: () => {
        /* a pure observer */
      },
    }),
  );

  assert.deepEqual(observed.envelopes, without.envelopes);
  assert.deepEqual(observed.state, without.state);
  assert.deepEqual(observed.checksums, without.checksums);
});

test("A3: rendering during the turn is byte-identical to projecting after it", async () => {
  const result = await runTurn(ports(), request());
  const usage = usageOf(result);
  const meta = metaOf(result);
  const terminal: TerminalFacts = { status: "completed", finishReason: result.state.finishReason };

  for (const format of ["text", "stream-json"] as const) {
    const streamed = capture();
    const renderer = createTurnRenderer(format, streamed.sink, meta);

    for (const envelope of result.envelopes) {
      renderer.onEnvelope(envelope);
    }

    const streamedResult = renderer.close(result.transcript, usage, meta, terminal);

    const batched = capture();
    const projection = createProjection(format, batched.sink);
    const events = projectRun(result.envelopes, result.transcript, usage, meta, terminal);

    for (const event of events) {
      projection.onEvent(event);
    }

    assert.equal(
      streamed.bytes(),
      batched.bytes(),
      `${format}: a run rendered incrementally must be byte-identical to one projected at the end`,
    );
    assert.deepEqual(streamedResult, events[events.length - 1]);
  }
});

test("A3: the incremental path emits run_start first and run_result last, once each", async () => {
  const result = await runTurn(ports(), request());
  const captured = capture();
  const seen: string[] = [];
  const counting: CliSink = {
    stdout: (text) => {
      captured.sink.stdout(text);
      for (const line of text.split("\n")) {
        if (line.trim().length > 0) {
          seen.push((JSON.parse(line) as { type: string }).type);
        }
      }
    },

    stderr: captured.sink.stderr,
  };
  const renderer = createTurnRenderer("stream-json", counting, metaOf(result));

  for (const envelope of result.envelopes) {
    renderer.onEnvelope(envelope);
  }

  renderer.close(result.transcript, usageOf(result), metaOf(result), {
    status: "completed",
    finishReason: result.state.finishReason,
  });

  assert.equal(seen[0], "run_start");
  assert.equal(seen[seen.length - 1], "run_result");
  assert.equal(seen.filter((type) => type === "run_start").length, 1);
  assert.equal(seen.filter((type) => type === "run_result").length, 1);
});
