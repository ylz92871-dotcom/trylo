import assert from "node:assert/strict";
import test from "node:test";
import { createSkillReviewProcess, type SkillReviewBackend, type SkillReviewExecution } from "./review-process.js";

const opportunity = { trigger: "implicit" as const, workspaceRoot: "fixture-workspace", sessionId: "session", turnId: "turn" };
const completed: SkillReviewExecution = { status: "completed", answer: "Nothing durable to retain.", proposals: [], toolFailures: 0 };

test("cancellation after a real stage releases review ownership and retains its pending record", async () => {
  const controller = new AbortController(), pending = new Set<string>(), released: string[] = [];
  let finished = false;
  const backend: SkillReviewBackend = {
    async begin() { return { status: "ready", reviewId: "review", prompt: "native review" }; },
    async finish(_id, execution, cleanupSignal) {
      finished = true;
      assert.equal(execution.status, "cancelled");
      assert.equal(cleanupSignal.aborted, false);
      return { status: "cancelled", candidateId: "review", error: "hermes_review_execution_incomplete", pendingIds: ["native-pending"] };
    },
    async release(id) { released.push(id); },
  };
  const result = await createSkillReviewProcess(backend)(opportunity, async () => {
    pending.add("native-pending");
    controller.abort();
    return { ...completed, proposals: [{ pendingId: "native-pending", name: "release-procedure", action: "patch" }] };
  }, controller.signal);

  assert.equal(result.status, "cancelled");
  assert.equal(finished, true, "confirmed partial writes must be reconciled without promoting the cancelled execution");
  assert.deepEqual("pendingIds" in result ? result.pendingIds : undefined, ["native-pending"]);
  assert.deepEqual(released, ["review"]);
  assert.deepEqual([...pending], ["native-pending"], "release must not silently discard an unreviewed proposal");
});

test("provider and native-finalization failures release the claimed review and remain failures", async () => {
  for (const failure of ["provider", "finish"] as const) {
    const released: string[] = [];
    const backend: SkillReviewBackend = {
      async begin() { return { status: "ready", reviewId: failure, prompt: "native review" }; },
      async finish() { throw new Error("native pending unavailable"); },
      async release(id) { released.push(id); },
    };
    const result = await createSkillReviewProcess(backend)(opportunity, async () => {
      if (failure === "provider") throw new Error("provider unavailable");
      return completed;
    }, new AbortController().signal);

    assert.equal(result.status, "failed");
    assert.deepEqual(released, [failure]);
  }
});

test("a completed coherent multi-record proposal preserves its native approval requirements", async () => {
  const ids = ["main", "reference"], released: string[] = [];
  const backend: SkillReviewBackend = {
    async begin() { return { status: "ready", reviewId: "review", prompt: "native review" }; },
    async finish() { return { status: "staged", candidateId: "review", pendingId: ids[0]!, pendingIds: ids, approval: "required" }; },
    async release(id) { released.push(id); },
  };
  const result = await createSkillReviewProcess(backend)(opportunity, async () => completed, new AbortController().signal);

  assert.deepEqual(result, { status: "staged", candidateId: "review", pendingId: "main", pendingIds: ids, approval: "required" });
  assert.deepEqual(released, ["review"]);
});

test("admission skips and pre-existing cancellation never start model work", async () => {
  let modelCalls = 0, releases = 0, admissions = 0;
  const backend: SkillReviewBackend = {
    async begin() {
      admissions += 1;
      return { status: "skipped", reasonCode: "HASH_PROCESSED" };
    },
    async finish() { throw new Error("unexpected finish"); },
    async release() { releases += 1; },
  };
  const process = createSkillReviewProcess(backend);
  const run = async () => {
    modelCalls += 1;
    return completed;
  };

  assert.deepEqual(await process(opportunity, run, new AbortController().signal), { status: "skipped", reasonCode: "HASH_PROCESSED" });
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await process(opportunity, run, cancelled.signal)).status, "cancelled");
  assert.equal(modelCalls, 0);
  assert.equal(releases, 0);
  assert.equal(admissions, 1);
});

test("failed release cannot be reported as a clean completed review", async () => {
  const backend: SkillReviewBackend = {
    async begin() { return { status: "ready", reviewId: "review", prompt: "native review" }; },
    async finish() { return { status: "no_learning", candidateId: "review" }; },
    async release() { throw new Error("storage unavailable"); },
  };
  assert.deepEqual(await createSkillReviewProcess(backend)(opportunity, async () => completed, new AbortController().signal),
    { status: "failed", candidateId: "review", error: "hermes_review_release_failed" });
});

test("release failure retains the already confirmed native proposal locators without reporting success", async () => {
  const backend: SkillReviewBackend = {
    async begin() { return { status: "ready", reviewId: "review", prompt: "native review" }; },
    async finish() { return { status: "staged", candidateId: "review", pendingId: "main", pendingIds: ["main", "support"], approval: "required" }; },
    async release() { throw new Error("transport closed"); },
  };
  assert.deepEqual(await createSkillReviewProcess(backend)(opportunity, async () => completed, new AbortController().signal),
    { status: "failed", candidateId: "review", error: "hermes_review_release_failed", pendingIds: ["main", "support"] });
});

test("cancellation during native finalization cannot erase an already staged proposal locator", async () => {
  const controller = new AbortController();
  let released = false;
  const backend: SkillReviewBackend = {
    async begin() { return { status: "ready", reviewId: "review", prompt: "native review" }; },
    async finish(_id, _execution, cleanupSignal) {
      controller.abort();
      assert.equal(cleanupSignal.aborted, false, "native reconciliation has its own bounded request");
      return { status: "staged", candidateId: "review", pendingId: "actual-pending", pendingIds: ["actual-pending"], approval: "required" };
    },
    async release() { released = true; },
  };
  const result = await createSkillReviewProcess(backend)(opportunity,
    async () => ({ ...completed, proposals: [{ pendingId: "actual-pending", name: "release-procedure", action: "patch" }] }), controller.signal);

  assert.deepEqual(result, { status: "cancelled", candidateId: "review", error: "cancelled", pendingIds: ["actual-pending"] });
  assert.equal(released, true);
});
