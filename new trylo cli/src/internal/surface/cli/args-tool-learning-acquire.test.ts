import assert from "node:assert/strict";
import test from "node:test";
import { parseToolLearningAcquire } from "./args-tool-learning-acquire.js";

const job = `tool-learning_v1_${"a".repeat(64)}`, child = `tool-adaptation_v1_${"b".repeat(64)}`;
const decision = `tool-decision_v1_${"c".repeat(64)}`, review = `tool-adaptation-recovery-review_v1_${"d".repeat(64)}`;
const failure = `tool-acquisition-failure_v1_${"e".repeat(64)}`, inquiryReview = `acquisition-inquiry-review_v1_${"f".repeat(64)}`;

test("recovery review is read-only and recovery confirmation binds exact child, attempt and original acquisition decision", () => {
  assert.deepEqual(parseToolLearningAcquire([job]), { kind: "acquire-learning", jobId: job });
  assert.deepEqual(parseToolLearningAcquire([job, "--recover-child", child, "--attempt", "1"]), {
    kind: "acquire-learning", jobId: job, recovery: { childJobId: child, attempt: 1 },
  });
  assert.deepEqual(parseToolLearningAcquire([job, "--recover-child", child, "--attempt", "2", "--approve", decision, "--confirm-recovery", review]), {
    kind: "acquire-learning", jobId: job, approvalId: decision, recovery: { childJobId: child, attempt: 2, reviewId: review },
  });
  assert.deepEqual(parseToolLearningAcquire([job, "--resume-child", child, "--approve", decision]), {
    kind: "acquire-learning", jobId: job, approvalId: decision, resumeChildJobId: child,
  });

  for (const tokens of [
    [job, "--recover-child", child], [job, "--recover-child", "latest", "--attempt", "1"], [job, "--recover-child", child, "--attempt", "0"],
    [job, "--recover-child", child, "--attempt", "4"], [job, "--recover-child", child, "--attempt", "1", "--confirm-recovery", review],
    [job, "--recover-child", child, "--attempt", "1", "--approve", decision, "--confirm-recovery", "latest"],
    [job, "--recover-child", child, "--attempt", "1", "--allow-tools", "run_shell"], [job, "--recover-child", child, "--attempt", "1", "--provider", "amd"],
    [job, "--recover-child", child, "--attempt", "1", "--resume-child", child, "--approve", decision],
    [job, "--resume-child", child], [job, "--attempt", "1"], [job, "--confirm-recovery", review],
  ]) assert.equal(parseToolLearningAcquire(tokens).kind, "error", tokens.join(" "));
});

test("failed acquisition research separates read-only review, exact confirmation and expired-owner recovery", () => {
  assert.deepEqual(parseToolLearningAcquire([job, "--reinvestigate-failure", failure]), {
    kind: "acquire-learning", jobId: job, inquiry: { failureRef: failure },
  });
  const confirmed = parseToolLearningAcquire([job, "--reinvestigate-failure", failure, "--approve", decision,
    "--confirm-inquiry", inquiryReview, "--provider", "amd"]);

  assert.ok(confirmed.kind === "acquire-learning");
  assert.equal(confirmed.run?.provider, "amd");
  assert.deepEqual(confirmed.inquiry, { failureRef: failure, reviewId: inquiryReview });
  assert.deepEqual(parseToolLearningAcquire([job, "--reinvestigate-failure", failure, "--approve", decision,
    "--confirm-inquiry-recovery", inquiryReview]), {
    kind: "acquire-learning", jobId: job, approvalId: decision, inquiry: { failureRef: failure, recoveryReviewId: inquiryReview },
  });

  for (const tokens of [
    [job, "--reinvestigate-failure", "latest"], [job, "--confirm-inquiry", inquiryReview, "--approve", decision],
    [job, "--reinvestigate-failure", failure, "--confirm-inquiry", inquiryReview],
    [job, "--reinvestigate-failure", failure, "--approve", decision, "--confirm-inquiry", "latest"],
    [job, "--reinvestigate-failure", failure, "--approve", decision, "--confirm-inquiry", inquiryReview, "--confirm-inquiry-recovery", inquiryReview],
    [job, "--reinvestigate-failure", failure, "--resume-child", child, "--approve", decision],
    [job, "--reinvestigate-failure", failure, "--recover-child", child, "--attempt", "1"],
    [job, "--reinvestigate-failure", failure, "--provider", "amd"],
    [job, "--reinvestigate-failure", failure, "--approve", decision, "--confirm-inquiry-recovery", inquiryReview, "--provider", "amd"],
    [job, "--reinvestigate-failure", failure, "--approve", decision, "--confirm-inquiry", inquiryReview, "--allow-tools", "run_shell"],
    [job, "--reinvestigate-failure", failure, "--approve", decision, "--confirm-inquiry", inquiryReview, "--deny-tools", "run_shell"],
  ]) assert.equal(parseToolLearningAcquire(tokens).kind, "error", tokens.join(" "));
});
