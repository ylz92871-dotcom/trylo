import assert from "node:assert/strict";
import test from "node:test";
import {
  NOT_INSTALLED,
  isReviewerSelection,
  reviewerInput,
  runReviewer,
  selectReviewer,
  REVIEWER_SELECTIONS,
  type ReviewRequest,
  type Reviewer,
  type ReviewVerdict,
} from "./approval-reviewer.js";
import { decision, type PermissionAction } from "../ports/permission.js";

/**
 * C67: what an automatic reviewer is allowed to do, and what happens when it is
 * not there. The second half is the half that matters — a component that may be
 * absent must fail towards the behaviour that already exists, never towards
 * access.
 */

const ACTION: PermissionAction = {
  toolCallId: "call-1",
  name: "write_file",
  arguments: { path: "notes.md", content: "x" },
  pattern: "write_file#abc123",
};

const REQUEST: ReviewRequest = { action: ACTION, retry: false };

function reviewerOf(verdict: ReviewVerdict | Promise<ReviewVerdict>, name = "r1"): Reviewer {
  return {
    name,
    async review() {
      return await verdict;
    },
  };
}

test("a reviewer is given the call, not just the tool name", async () => {
  let seen: unknown;
  const reviewer: Reviewer = {
    name: "r1",
    async review(input) {
      seen = input;
      return { answer: "ask_user" };
    },
  };

  await runReviewer(reviewer, REQUEST);
  assert.deepEqual(seen, {
    toolCallId: "call-1",
    name: "write_file",
    arguments: { path: "notes.md", content: "x" },
    pattern: "write_file#abc123",
    retry: false,
  });
});

test("a retry is carried to the reviewer", () => {
  const input = reviewerInput({ action: ACTION, retry: true, reason: "sandbox_refused" });
  assert.equal(input.retry, true);
  assert.equal(input.reason, "sandbox_refused");
});

test("an absent reviewer answers nothing, and says so", async () => {
  const outcome = await runReviewer(undefined, REQUEST);
  assert.deepEqual(outcome, NOT_INSTALLED);
  assert.equal(outcome.kind, "unavailable");
});

test("a reviewer that throws is unavailable, not a denial and not an allow", async () => {
  const outcome = await runReviewer(
    {
      name: "flaky",
      async review() {
        throw new Error("model refused the request");
      },
    },
    REQUEST,
  );

  assert.equal(outcome.kind, "unavailable");
  assert.equal(outcome.kind === "unavailable" && outcome.reason, "failed");
});

test("a reviewer answering nonsense is unavailable too", async () => {
  for (const bad of [undefined, null, 7, "allow", { answer: "maybe" }, { answer: "allow", rationale: 7 }]) {
    const outcome = await runReviewer(
      {
        name: "r1",
        async review(): Promise<ReviewVerdict> {
          return bad as ReviewVerdict;
        },
      },
      REQUEST,
    );
    assert.equal(outcome.kind, "unavailable", `input ${JSON.stringify(bad)} must not be read as a verdict`);
  }
});

test("the three answers survive the boundary intact", async () => {
  for (const answer of ["allow", "deny", "ask_user"] as const) {
    const outcome = await runReviewer(reviewerOf({ answer, rationale: "because" }), REQUEST);
    assert.equal(outcome.kind, "reviewed");
    assert.equal(outcome.kind === "reviewed" && outcome.verdict.answer, answer);
  }
});

test("an empty rationale is legal; only a wrongly typed one is not", async () => {
  const empty = await runReviewer(reviewerOf({ answer: "deny" }), REQUEST);
  assert.equal(empty.kind === "reviewed" && empty.verdict.rationale, undefined);
  const emptyText = await runReviewer(reviewerOf({ answer: "deny", rationale: "" }), REQUEST);
  assert.equal(emptyText.kind === "reviewed" && emptyText.verdict.rationale, "");
});

test("the default reviewer is the person, and only a configured one is installed", () => {
  const installed: Reviewer = { name: "r1", async review() { return { answer: "allow" }; } };
  assert.equal(selectReviewer("user", installed), undefined);
  assert.equal(selectReviewer("auto_review", installed), installed);
  assert.equal(selectReviewer("auto_review", undefined), undefined);
});

test("the reviewer vocabulary is closed, and the upstream alias is not silently accepted", () => {
  assert.deepEqual([...REVIEWER_SELECTIONS], ["user", "auto_review"]);
  assert.equal(isReviewerSelection("user"), true);
  assert.equal(isReviewerSelection("auto_review"), true);
  assert.equal(isReviewerSelection("guardian_subagent"), false);
  assert.equal(isReviewerSelection(""), false);
});

test("the reviewer's name is carried, so a refusal can name its author", async () => {
  const outcome = await runReviewer(reviewerOf({ answer: "deny", rationale: "no" }, "risk-model"), REQUEST);
  assert.equal(outcome.kind === "reviewed" && outcome.verdict.rationale, "no");
  // The domain layer does not decide who to name; the caller reads `name` off
  // the reviewer it passed in. What is asserted here is that the name survives.
  assert.equal(reviewerOf({ answer: "deny" }, "risk-model").name, "risk-model");
});

test("permission decisions are not the reviewer's to make", () => {
  // A reviewer is handed an action and answers a question; it never returns a
  // PermissionDecision, so there is no path by which it can hand back a scope.
  // Asserted structurally: the verdict type has no scope field to set.
  const verdict: ReviewVerdict = { answer: "allow" };
  assert.equal("scope" in verdict, false);
  assert.equal(decision("approved", "session").scope, "session");
});
