import assert from "node:assert/strict";
import test from "node:test";
import { createSkillPendingReview } from "./pending-review.js";
import { createSkillCoordination } from "../control/coordination.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";

const scope = "workspace:skill-pending-review";
const digest = `sha256:${"a".repeat(64)}`;
const cancellation = () => new AbortController().signal;

async function fixture() {
  let state = emptyBoardState();
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }),
    apply: async (command: Parameters<typeof reduce>[1]) => {
      const result = reduce(state, command);
      if (result.ok) state = result.state;
      return result;
    } };
  const coordination = createSkillCoordination({ board, scope, ownerId: "skill-pending-contract", now: () => "2026-11-05T05:00:00.000Z" });
  const reported = await coordination.report({ sourceRef: "source:pending-actual-review", taskId: "turn:pending-source", versionId: "session:pending-source",
    facts: ["A test source requested review; no task quality is asserted."], evidenceRefs: ["source:pending-actual-review"] });

  assert.ok(reported.ok);
  const focused = await coordination.focus({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision, reason: "Bound native review.",
    sourceRefs: ["source:pending-actual-review"], allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 1000 } });

  assert.ok(focused.ok);
  const finished = await coordination.run({ issueId: reported.issue.issueId, signal: cancellation(),
    worker: async () => ({ kind: "completed", resultRefs: ["hermes-pending:skills:pending:test"] }) });

  assert.ok(finished.ok);
  const calls: string[] = [];
  let currentHash = digest;
  const native = async (method: "pendingList" | "pendingDetail", _params: JsonObject) => {
    calls.push(method);
    return method === "pendingList" ? { ok: true, pending: [
      { id: "pending:test", subsystem: "skills", payloadHash: currentHash, target: "packaging", action: "create", summary: "Retain the lockfile precondition." },
      { id: "pending:another-workspace", subsystem: "skills", payloadHash: digest, target: "private-unrelated", action: "create", summary: "Other workspace." },
    ] } : { ok: true, detail: { success: true, id: "pending:test", subsystem: "skills", payloadHash: currentHash,
      target: "packaging", action: "create", before: "", after: "# Packaging\nOnly npm has source support; other package managers remain untested.",
      diff: "+ lockfile precondition", security: { verdict: "safe", findings: [] } } };
  };
  const review = createSkillPendingReview({ board, scope, native });
  const call = (arguments_: JsonObject, signal = cancellation()) => review.tools.execute({ name: "skill_proposals", toolCallId: "pending-review-call", arguments: arguments_ }, signal);

  return { review, call, calls, board, changeHash: () => { currentHash = `sha256:${"b".repeat(64)}`; } };
}

test("normal PA reads the original scoped proposal before emitting an exact user-review action; it cannot apply", async () => {
  const f = await fixture(), before = await f.board.load();
  const boundary = await f.review.readSkillPending(cancellation());
  assert.ok(boundary);
  assert.match(boundary.text, /pending:test/);
  assert.doesNotMatch(boundary.text, /private-unrelated/);
  const unread = await f.call({ operation: "request_review", pendingId: "pending:test", expectedHash: digest, reason: "Relevant to the current packaging task." });

  assert.equal(unread.outcome, "error");
  assert.equal(unread.code, "skill_pending_detail_read_required");
  const detail = await f.call({ operation: "detail", pendingId: "pending:test" });
  assert.equal(detail.outcome, "result");
  assert.match(detail.output, /other package managers remain untested/);
  const request = await f.call({ operation: "request_review", pendingId: "pending:test", expectedHash: digest, reason: "Relevant to the current packaging task; its prerequisites and unknown cases are shown." });

  assert.equal(request.outcome, "result");
  assert.equal(request.value.kind, "skill_pending_review_request");
  assert.equal(request.value.expectedHash, digest);
  assert.equal(request.value.pendingId, "pending:test");
  assert.equal(request.value.status, "awaiting_user_approval");
  assert.equal(request.value.scope, scope);
  assert.ok(f.calls.every(method => method === "pendingList" || method === "pendingDetail"));
  assert.equal((await f.board.load()).state.sequence, before.state.sequence);
  assert.equal((await f.call({ operation: "apply", pendingId: "pending:test" })).outcome, "error");
});

test("a changed hash, a different workspace, malformed native reads and cancellation cannot request approval", async () => {
  const f = await fixture();

  assert.equal((await f.call({ operation: "detail", pendingId: "pending:another-workspace" })).outcome, "error");
  await f.call({ operation: "detail", pendingId: "pending:test" });
  f.changeHash();
  const stale = await f.call({ operation: "request_review", pendingId: "pending:test", expectedHash: digest, reason: "Stale proposal." });

  assert.equal(stale.outcome, "error");
  assert.equal(stale.code, "skill_pending_review_binding_invalid");
  const broken = createSkillPendingReview({ board: f.board, scope, native: async () => ({ ok: false, pending: [] }) });
  const unavailable = await broken.tools.execute({ name: "skill_proposals", toolCallId: "bad-source", arguments: { operation: "list" } }, cancellation());

  assert.equal(unavailable.outcome, "error");
  assert.equal(unavailable.code, "skill_pending_list_invalid");
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await f.call({ operation: "list" }, aborted.signal)).outcome, "cancelled");
});
