import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dispatchDecision,
  enqueueVerdict,
  isPermutation,
  type DispatchDecision,
} from "./background-queue.js";
import { MAX_QUEUED_MESSAGES, type QueuePage, type QueuedMessage } from "../ports/background-queue.js";

/**
 * The decisions, with no storage anywhere.
 *
 * Each test names the claim it defends rather than the function it calls,
 * because the claims are what a reader of a queue needs to be able to check: a
 * message must not be delivered twice, must not vanish, and an unreadable queue
 * must never be reported as an empty one.
 */

function message(text: string, id = "q1"): QueuedMessage {
  return { id, text, enqueuedAtMs: 0 };
}

function page(items: ReadonlyArray<QueuedMessage>): QueuePage {
  return { items, total: items.length };
}

test("the first message is the one that goes first", () => {
  const decision = dispatchDecision({
    ok: true,
    value: page([message("first"), message("second", "q2")]),
  });
  assert.deepEqual(decision, { kind: "start", message: message("first") });
});

test("an empty queue is idle, which is not the same claim as unreadable", () => {
  // Both are "nothing to start", and they mean opposite things to a person:
  // one says their queue is empty, the other says nobody could find out. A
  // caller that collapses them reports a queue nobody could read as an empty
  // one, and the person concludes their message was never queued.
  const empty = dispatchDecision({ ok: true, value: page([]) });
  const unreadable = dispatchDecision({ ok: false, code: "queue_unreadable" });
  const locked = dispatchDecision({ ok: false, code: "queue_locked" });

  assert.deepEqual(empty, { kind: "idle" });
  assert.deepEqual(unreadable, { kind: "unknown", code: "queue_unreadable" });
  assert.deepEqual(locked, { kind: "unknown", code: "queue_locked" });
  // Spelled out as a pair of claims rather than a kind comparison, because the
  // comparison would be rejected by the compiler for being impossible — which
  // is the property being asserted: the two shapes are disjoint by construction.
  const claims = (decision: DispatchDecision): string =>
    decision.kind === "unknown" ? `unknown:${decision.code}` : decision.kind;

  assert.notEqual(claims(empty), claims(unreadable));
});

test("a message that survived into storage blank is not started and not dropped", () => {
  const decision = dispatchDecision({ ok: true, value: page([message("   ")]) });

  assert.equal(decision.kind, "unknown");

  // The refusal names a reason the surface can show, rather than a generic
  // "something is wrong".
  if (decision.kind === "unknown") {
    assert.equal(decision.code, "queue_unreadable");
  }
});

test("one message starts even when ninety-nine are behind it", () => {
  const many = Array.from({ length: MAX_QUEUED_MESSAGES }, (_, index) =>
    message(`m${index}`, `q${index}`),
  );
  const decision = dispatchDecision({ ok: true, value: page(many) });

  assert.equal(decision.kind, "start");

  if (decision.kind === "start") {
    assert.equal(decision.message.id, "q0");
  }
});

test("whitespace is refused, and a full queue is refused, each with its own reason", () => {
  assert.deepEqual(enqueueVerdict("   ", 0), { kind: "refused", code: "blank" });
  assert.deepEqual(enqueueVerdict("\n\t ", 0), { kind: "refused", code: "blank" });
  assert.deepEqual(enqueueVerdict("real", MAX_QUEUED_MESSAGES), { kind: "refused", code: "full" });
  assert.deepEqual(enqueueVerdict("real", MAX_QUEUED_MESSAGES - 1), { kind: "accepted", text: "real" });
});

test("the ceiling is checked against what is stored, so the hundred-and-first is refused", () => {
  // A message that was started but not yet removed is still in the file and
  // still occupies its place. Counting only the dispatched ones would let two
  // processes each admit one too many.
  assert.equal(enqueueVerdict("x", MAX_QUEUED_MESSAGES).kind, "refused");
  assert.equal(enqueueVerdict("x", MAX_QUEUED_MESSAGES - 1).kind, "accepted");
});

test("reorder must name every message exactly once, and a prefix is refused", () => {
  assert.equal(isPermutation(["a", "b", "c"], ["c", "a", "b"]), true);
  // A prefix would be a way to delete two messages without saying so.
  assert.equal(isPermutation(["a", "b", "c"], ["c", "a"]), false);
  assert.equal(isPermutation(["a", "b", "c"], ["c", "a", "b", "d"]), false);
  // A repeat is not a permutation either, even though the length matches.
  assert.equal(isPermutation(["a", "b", "c"], ["a", "a", "b"]), false);
  assert.equal(isPermutation([], []), true);
});
