import assert from "node:assert/strict";
import test from "node:test";
import { withSkillReviewDeadline } from "./review-deadline.js";
import { createSkillReviewProcess } from "../review-process.js";

const source = { trigger: "implicit" as const };

test("an omitted caller deadline never arms a timer or interrupts a progressing review", async () => {
  let armed = 0;
  const review = withSkillReviewDeadline(async (_source, _run, signal) => {
    await Promise.resolve();
    assert.equal(signal.aborted, false);
    return { status: "no_learning", candidateId: "review" };
  }, { setTimer(callback) {
    armed += 1;
    queueMicrotask(callback);
    return setTimeout(() => {}, 10_000);
  } });
  const result = await review(source, async () => { throw new Error("not used"); }, new AbortController().signal);

  assert.equal(armed, 0);
  assert.deepEqual(result, { status: "no_learning", candidateId: "review" });
});

test("a review without a deadline still receives the caller cancellation", async () => {
  const parent = new AbortController();
  const review = withSkillReviewDeadline(async (_source, _run, signal) => {
    assert.equal(signal, parent.signal);
    parent.abort();
    assert.equal(signal.aborted, true);
    return { status: "cancelled", error: "cancelled" };
  });

  assert.equal((await review(source, async () => { throw new Error("not used"); }, parent.signal)).status, "cancelled");
});

test("a review deadline aborts model work, releases native ownership and reports timeout", async () => {
  let expire: () => void = () => { throw new Error("timer not armed"); };
  let cleared = false, released = false;
  const process = createSkillReviewProcess({
    async begin() { return { status: "ready", reviewId: "review", prompt: "official prompt" }; },
    async finish() { throw new Error("aborted work must not finish"); },
    async release() { released = true; },
  });
  const review = withSkillReviewDeadline(process, {
    timeoutMs: 180_000,
    setTimer(callback) {
      expire = callback;
      return setTimeout(() => {}, 10_000);
    },
    clearTimer(timer) {
      cleared = true;
      clearTimeout(timer);
    },
  });
  const result = await review(source, async (_prompt, signal) => {
    expire();
    assert.equal(signal.aborted, true);
    return { status: "cancelled", answer: "", proposals: [], toolFailures: 0 };
  }, new AbortController().signal);

  assert.deepEqual(result, { status: "failed", candidateId: "review", error: "hermes_review_timeout" });
  assert.equal(released, true);
  assert.equal(cleared, true);
});

test("caller cancellation stays cancellation and a finished review disarms its timer", async () => {
  const parent = new AbortController();
  let clearCount = 0;
  const review = withSkillReviewDeadline(async (_source, _run, signal) => {
    parent.abort();
    assert.equal(signal.aborted, true);
    return { status: "cancelled", error: "cancelled" };
  }, { timeoutMs: 180_000, clearTimer(timer) {
    clearCount += 1;
    clearTimeout(timer);
  } });

  assert.equal((await review(source, async () => { throw new Error("not used"); }, parent.signal)).status, "cancelled");
  assert.equal(clearCount, 1);
});

test("timeout during native preparation is reported without exposing the preparation exception", async () => {
  let expire = () => {};
  const review = withSkillReviewDeadline(async () => {
    expire();
    throw new Error("native cancellation detail must stay internal");
  }, { timeoutMs: 180_000, setTimer(callback) {
    expire = callback;
    return setTimeout(() => {}, 10_000);
  } });
  assert.deepEqual(await review(source, async () => { throw new Error("not used"); }, new AbortController().signal),
    { status: "failed", error: "hermes_review_timeout" });
});

test("an explicit caller stop takes precedence if the deadline also fires", async () => {
  const parent = new AbortController();
  let expire = () => {};
  const review = withSkillReviewDeadline(async () => {
    parent.abort();
    expire();
    return { status: "cancelled", error: "cancelled" };
  }, { timeoutMs: 180_000, setTimer(callback) {
    expire = callback;
    return setTimeout(() => {}, 10_000);
  } });

  assert.equal((await review(source, async () => { throw new Error("not used"); }, parent.signal)).status, "cancelled");
});
