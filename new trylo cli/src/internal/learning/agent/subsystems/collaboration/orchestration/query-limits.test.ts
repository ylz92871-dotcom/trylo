import assert from "node:assert/strict";
import test from "node:test";
import { isLearningAction } from "./parse.js";
import { isCollaborationRuntimeReceipt } from "../../../../control/collaboration-runtime-parse.js";
import type { CollaborationResourceReceipt } from "../../../../../protocol/collaboration-resource.js";

const queryReceipt = (query: string): CollaborationResourceReceipt => ({ schemaVersion: 1, receiptId: "resource:query", phase: "resource_query",
  scope: "workspace:query-bounds", issueId: "issue:actual", jobId: "job:actual", grantId: "grant:actual", requestId: "request:actual", owner: "research",
  query, resultRefs: [], summary: "The collaboration learner requested this resource.",
  boundary: { executionId: "execution:actual", taskId: "task:actual", round: 1, role: "collaboration_learning" }, recordedAt: "2026-11-04T00:00:00.000Z" });

test("model query admission fits the existing 1500-character canonical resource receipt contract", () => {
  const boundary = "q".repeat(1500), tooLong = "q".repeat(1501);
  assert.equal(isLearningAction({ kind: "query", owner: "research", query: boundary }), true);
  assert.equal(isCollaborationRuntimeReceipt(queryReceipt(boundary)), true);
  assert.equal(isLearningAction({ kind: "query", owner: "research", query: tooLong }), false, "a legal model action must not exceed its actual receipt contract");
  assert.equal(isCollaborationRuntimeReceipt(queryReceipt(tooLong)), false);
  assert.equal(isLearningAction({ kind: "query", owner: "research", query: "q".repeat(2000) }), false);
});

test("resource summary and complete unique source references retain their original persistence bounds", () => {
  const result: CollaborationResourceReceipt = { ...queryReceipt("specific research question"), phase: "resource_result", status: "available",
    receiptId: "resource:result", resultRefs: Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, "0")}${"r".repeat(510)}`), summary: "s".repeat(1500) };

  assert.equal(isCollaborationRuntimeReceipt(result), true);
  assert.equal(isCollaborationRuntimeReceipt({ ...result, summary: "s".repeat(1501) }), false);
  assert.equal(isCollaborationRuntimeReceipt({ ...result, resultRefs: [...result.resultRefs, "source:33"] }), false);
  assert.equal(isCollaborationRuntimeReceipt({ ...result, resultRefs: ["r".repeat(513)] }), false);
  assert.equal(isCollaborationRuntimeReceipt({ ...result, resultRefs: ["duplicate", "duplicate"] }), false);
  assert.equal(result.resultRefs[0]?.length, 512, "the complete boundary reference is preserved; nothing is truncated");
});
