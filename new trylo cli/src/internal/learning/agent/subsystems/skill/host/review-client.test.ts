import assert from "node:assert/strict";
import test from "node:test";
import { hermesReviewBackend } from "./review-client.js";

const execution = { status: "completed" as const, answer: "", proposals: [], toolFailures: 0 };
const backendFor = (result: unknown) => hermesReviewBackend({ review: async () => result });

test("native process replies cannot fabricate staged records or leak wrongly shaped identifiers", async () => {
  for (const result of [
    { status: "staged", candidateId: "review", pendingId: "missing", pendingIds: ["other"], approval: "required" },
    { status: "staged", candidateId: "review", pendingId: "id", pendingIds: ["id", "id"], approval: "required" },
    { status: "staged", candidateId: "review", pendingId: "", pendingIds: [], approval: "required" },
    { status: "failed", error: "native_failed", candidateId: 42 },
    { status: "cancelled", error: "cancelled", pendingIds: [42] },
  ]) await assert.rejects(backendFor(result).finish("review", execution, new AbortController().signal), /hermes_review_invalid_reply/);
});

test("preparation and release require an actual typed native acknowledgement", async () => {
  await assert.rejects(backendFor({ status: "ready", reviewId: "", prompt: "official" }).begin({ trigger: "implicit" }, new AbortController().signal),
    /hermes_review_invalid_preparation/);
  await assert.rejects(backendFor({ released: false }).release("review"), /hermes_review_invalid_release/);
  await backendFor({ released: true }).release("review");
});
