import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectCommand } from "./command.js";
import { decideIterationEnd, type IterationObservation } from "./iteration.js";
import { admitInput, nextPromotion, pendingCount } from "./input-queue.js";
import type { ReduceInput } from "./input.js";
import { reduce } from "./reduce.js";
import { awaitingContinuationOf } from "./reduce-lifecycle.js";
import { initialState, type ExecutionState } from "./state.js";
import { openBatch, settleBatch, settlementOrder } from "./tool-batch.js";

/**
 * The iteration-gap contract (WP D 波 §5), pinned from the outside in.
 *
 * These tests are deliberately written against `reduce` and the pure helpers
 * rather than against the loop that drives them: the properties they check —
 * a batch never returns to `turning` early, a steer is never promoted mid-tool,
 * a spent budget is not reported as a crash — are properties of the domain, and
 * a loop that could break them would break them in production too.
 */

let n = 0;

function eid(): string {
  n += 1;
  return `gap-${n}`;
}

type Step = {
  readonly state: ExecutionState;
  readonly commands: readonly EffectCommand[];
  readonly kinds: readonly string[];
  readonly payloads: ReadonlyArray<Record<string, unknown>>;
};

function step(state: ExecutionState, input: ReduceInput): Step {
  const result = reduce(state, input);

  assert.equal(
    result.ok,
    true,
    `${state.phase} <- ${input.type}${result.ok ? "" : `: ${result.error.message}`}`,
  );

  if (!result.ok) {
    throw new Error("unreachable");
  }

  return {
    state: result.state,
    commands: result.commands,
    kinds: result.events.map((event) => event.kind),
    payloads: result.events.map((event) => event.payload as Record<string, unknown>),
  };
}

function start(): ExecutionState {
  return step(initialState(), {
    type: "start_turn",
    eventId: eid(),
    sessionId: "ses-1",
    turnId: "trn-1",
    correlationId: "cor-1",
    text: "go",
  }).state;
}

function streaming(): ExecutionState {
  return step(start(), { type: "begin_stream", eventId: eid() }).state;
}

function toolRequest(toolCallId: string, batch: boolean): ReduceInput {
  return {
    type: "tool_request",
    eventId: eid(),
    toolCallId,
    name: "echo",
    arguments: {},
    needsApproval: false,
    ...(batch ? { batch: true } : {}),
  };
}

function succeeded(toolCallId: string): ReduceInput {
  return { type: "tool_succeeded", eventId: eid(), toolCallId, value: { ok: true } };
}

function userInput(text: string, mode: "steer" | "queue"): ReduceInput {
  return { type: "user_input", eventId: eid(), text, mode };
}

test("反方 #19 — parallel off never introduces a batch", () => {
  const s0 = streaming();
  const requested = step(s0, toolRequest("call-1", false));

  assert.equal(requested.state.phase, "tooling");
  assert.equal(requested.state.activeToolCallId, "call-1");
  assert.equal(requested.state.activeToolCallIds, undefined);

  const done = step(requested.state, succeeded("call-1"));

  assert.equal(done.state.phase, "turning");
  assert.equal(done.state.activeToolCallIds, undefined);
  // The single-tool shape keeps its historical command set exactly: one tool_use
  // event, one execute_tool effect, one tool_result event.
  assert.deepEqual(requested.kinds, ["tool_use"]);
  assert.deepEqual(
    requested.commands.filter((c) => c.type === "execute_tool").length,
    1,
  );
  assert.deepEqual(done.kinds, ["tool_result"]);
});

test("反方 #18 — a batch stays in tooling until its last member settles", () => {
  let s = streaming();

  s = step(s, toolRequest("call-a", true)).state;
  assert.deepEqual(s.activeToolCallIds, ["call-a"]);
  assert.equal(s.activeToolCallId, undefined);
  s = step(s, toolRequest("call-b", true)).state;
  assert.deepEqual(s.activeToolCallIds, ["call-a", "call-b"]);

  const first = step(s, succeeded("call-a"));

  // The whole point: one result landing must not license the next request.
  assert.equal(first.state.phase, "tooling");
  assert.deepEqual(first.state.activeToolCallIds, ["call-b"]);

  const last = step(first.state, succeeded("call-b"));

  assert.equal(last.state.phase, "turning");
  assert.equal(last.state.activeToolCallIds, undefined);
});

test("反方 #18 — a result for a call that is not in the batch is refused", () => {
  let s = streaming();

  s = step(s, toolRequest("call-a", true)).state;
  const stranger = reduce(s, succeeded("call-z"));

  assert.equal(stranger.ok, false);

  if (!stranger.ok) {
    assert.equal(stranger.error.code, "invalid_input");
    assert.equal(stranger.error.message, "tool_result_mismatch");
  }
});

test("反方 #18 — a repeated tool id cannot make the batch un-settlable", () => {
  let s = streaming();
  s = step(s, toolRequest("call-a", true)).state;
  s = step(s, toolRequest("call-a", true)).state;
  assert.deepEqual(s.activeToolCallIds, ["call-a"]);
  assert.equal(step(s, succeeded("call-a")).state.phase, "turning");
});

test("a batch settles in id order regardless of completion order", () => {
  assert.deepEqual(settlementOrder(["call-b", "call-a"]), ["call-a", "call-b"]);
  const ids = openBatch(openBatch([], "call-b"), "call-a");
  assert.deepEqual(settlementOrder(ids), ["call-a", "call-b"]);
  assert.deepEqual(settleBatch(ids, "call-a"), ["call-b"]);
});

test("反方 #20 — a steer is refused everywhere but the safe boundary", () => {
  const approval = step(streaming(), {
    type: "tool_request",
    eventId: eid(),
    toolCallId: "call-1",
    name: "echo",
    arguments: {},
    needsApproval: true,
  }).state;

  assert.equal(approval.phase, "approval_waiting");
  const tooling = step(streaming(), toolRequest("call-1", false)).state;

  assert.equal(tooling.phase, "tooling");

  for (const state of [streaming(), tooling, approval]) {
    const rejected = reduce(state, userInput("stop, do it differently", "steer"));
    assert.equal(rejected.ok, false, `user_input must be refused in ${state.phase}`);
    assert.equal(rejected.state.phase, state.phase);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, "illegal_transition");
    }
  }

  const accepted = step(start(), userInput("stop, do it differently", "steer"));

  assert.equal(accepted.state.phase, "turning");
  assert.deepEqual(accepted.kinds, ["user_correction"]);
});

test("an empty steer is refused even at the safe boundary", () => {
  const rejected = reduce(start(), userInput("   ", "steer"));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "invalid_input");
    assert.equal(rejected.error.message, "user_input_requires_text");
  }
});

test("反方 #21 — a waiting user message keeps the turn open", () => {
  const base: IterationObservation = {
    providerFinished: true,
    unsettledToolInputCount: 0,
    unsettledToolCallCount: 0,
    requiresFollowUp: false,
    budgetVerdict: { kind: "within_budget" },
  };

  assert.deepEqual(decideIterationEnd(base), { kind: "complete" });
  assert.deepEqual(decideIterationEnd({ ...base, pendingUserInputCount: 0 }), {
    kind: "complete",
  });
  assert.deepEqual(decideIterationEnd({ ...base, pendingUserInputCount: 2 }), {
    kind: "continue",
    reason: "user_input_pending",
  });
  // A tool result is owed to the model before a queued message is: the turn is
  // not finished, and it is not waiting on the person either.
  assert.deepEqual(decideIterationEnd({ ...base, pendingUserInputCount: 1, unsettledToolCallCount: 1 }), {
    kind: "continue",
    reason: "tool_results_pending",
  });
});

test("the input queue promotes one queued message, but every leading steer", () => {
  let q = admitInput([], { text: "later", mode: "queue" });

  q = admitInput(q, { text: "   ", mode: "steer" });
  assert.equal(pendingCount(q), 1);
  q = admitInput(q, { text: "actually no", mode: "steer" });
  q = admitInput(q, { text: "and another thing", mode: "steer" });
  q = admitInput(q, { text: "and afterwards", mode: "queue" });

  const first = nextPromotion(q);

  assert.deepEqual(first.batch.map((i) => i.text), ["later"]);
  assert.equal(first.resetBudget, false);

  const second = nextPromotion(first.rest);

  assert.deepEqual(second.batch.map((i) => i.text), ["actually no", "and another thing"]);
  assert.equal(second.resetBudget, true);

  const third = nextPromotion(second.rest);

  assert.deepEqual(third.batch.map((i) => i.text), ["and afterwards"]);
  assert.equal(third.resetBudget, false);

  assert.deepEqual(nextPromotion(third.rest).batch, []);
  assert.deepEqual(nextPromotion([]).batch, []);
});

test("反方 #22 — a spent budget is awaiting continuation, not a crash", () => {
  const exhausted = step(start(), {
    type: "budget_exhausted",
    eventId: eid(),
    reason: "iterations_exhausted",
  });

  assert.equal(exhausted.state.phase, "terminal");
  assert.equal(exhausted.state.terminalReason, "failed");
  const terminal = exhausted.payloads.find((p) => p.reason === "failed");

  assert.equal(terminal?.awaitingContinuation, true);
  assert.equal(exhausted.state.activeToolCallIds, undefined);

  assert.equal(awaitingContinuationOf("waiting:iterations_exhausted"), true);
  assert.equal(awaitingContinuationOf("waiting:context_limit"), true);
  assert.equal(awaitingContinuationOf("provider_error"), false);
  assert.equal(awaitingContinuationOf(""), false);
});

test("反方 #22 — a waiting turn-failure says so, a plain one does not", () => {
  const waiting = step(start(), {
    type: "turn_failed",
    eventId: eid(),
    reason: "waiting:output_tokens_exhausted",
  });

  assert.equal(waiting.state.terminalReason, "failed");
  assert.equal(waiting.payloads[0]?.awaitingContinuation, true);

  const broken = step(start(), { type: "turn_failed", eventId: eid(), reason: "provider_error" });

  assert.equal(broken.payloads[0]?.awaitingContinuation, false);
});

test("cancelling a batch cancels every member still in flight", () => {
  let s = streaming();

  s = step(s, toolRequest("call-a", true)).state;
  s = step(s, toolRequest("call-b", true)).state;
  const cancelled = step(s, { type: "cancel", eventId: eid() });

  assert.equal(cancelled.state.phase, "terminal");
  assert.equal(cancelled.state.terminalReason, "cancelled");
  assert.deepEqual(
    cancelled.commands.filter((c) => c.type === "cancel_tool").map((c) => c.toolCallId),
    ["call-a", "call-b"],
  );
  assert.equal(cancelled.state.toolCalls["call-a"]?.status, "cancelled");
  assert.equal(cancelled.state.toolCalls["call-b"]?.status, "cancelled");
  assert.equal(cancelled.state.activeToolCallIds, undefined);
});
