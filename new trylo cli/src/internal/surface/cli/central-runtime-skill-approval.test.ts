import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { skillApprovalDraft } from "../../learning/agent/subsystems/skill/index.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import { observeCentralRuntimeSkillApproval, type CentralRuntimeSkillApprovalInput } from "./central-runtime-skill-approval.js";
import type { CentralRuntimeSourceNotification } from "./central-runtime-notify.js";
import type { CliContext } from "./context.js";

const at = "2026-11-05T12:00:00.000Z", scope = path.resolve("original-skill-workspace");
const pendingId = "native-approved", expectedHash = `sha256:${"a".repeat(64)}`;
const input: CentralRuntimeSkillApprovalInput = { pendingId, expectedHash, at, reply: { ok: true, result: {
  success: true, committed: true, kept_pending: false, pendingId, payloadHash: expectedHash,
  action: "create", skillName: "original-skill", instructionHash: "b".repeat(64) } } };

function managedBoard(): BoardState {
  return { ...emptyBoardState(), learningIssues: [{ schemaVersion: 1, issueId: "issue:skill", scope, problemKey: "problem:skill",
    revision: 1, createdAt: at, updatedAt: at, decision: { kind: "unreviewed" }, reports: [{ reportId: "report:skill",
      source: { subsystem: "skill", taskId: "turn:original", versionId: "session:original" }, facts: ["Original source"], evidenceRefs: ["source:original"] }] }],
    jobs: [{ jobId: "job:skill", observationId: "issue:skill", domain: "skill", scope, state: "succeeded", attempt: 1,
      maxAttempts: 1, breakerOpen: false, dedupeKey: "job:skill", coordination: { issueId: "issue:skill", grantId: "grant:skill",
        resultRefs: [`hermes-pending:skills:${pendingId}`] } }],
    centralLearningGrants: [{ schemaVersion: 2, grantId: "grant:skill", issueId: "issue:skill", scope, jobId: "job:skill",
      domain: "skill", budgetId: "budget:original", focusRevision: 1, steps: 1, status: "closed", reservations: [],
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10, maxCalls: 1, maxSteps: 1, maxPromptChars: 1000 } }] };
}

const ctx = { cwd: path.resolve("unrelated-current-workspace") } as CliContext;

test("native approval notification uses the reread original draft scope and persisted exact fact", async () => {
  let board = managedBoard();
  const order: string[] = [], notices: CentralRuntimeSourceNotification[] = [];
  const draft = skillApprovalDraft({ ...input, board });
  assert.ok(draft);
  const result = await observeCentralRuntimeSkillApproval(ctx, input, {
    recordApproval: async received => { order.push("record");
    assert.deepEqual(received, input);
      board = { ...board, rewardV2Facts: [{ ...draft, sequence: 1 }] }; },

    loadBoard: async () => {
      order.push("load");
      return { ok: true, state: board, generation: 0 };
    },

    notify: async (received, notice) => {
      order.push("notify");
      assert.equal(received, ctx);
      notices.push(notice);
      return { ok: true, notified: true };
    },
  });

  assert.deepEqual(order, ["record", "load", "notify"]);
  assert.deepEqual(result, { ok: true, notified: true });
  assert.deepEqual(notices, [{ workspaceRoot: scope, reason: "skill_native_approval_committed", sourceRefs: [draft.id] }]);
});

test("native failures, unmatched drafts and missing persisted facts never wake an owner", async () => {
  const board = managedBoard();
  let notifications = 0;
  const ports = { recordApproval: async () => {}, loadBoard: async () => ({ ok: true as const, state: board, generation: 0 }),

    notify: async () => {
      notifications++;
      return { ok: true as const, notified: true };
    } };

  for (const changed of [{ ...input, reply: { ok: false } }, { ...input, expectedHash: `sha256:${"c".repeat(64)}` }]) {
    assert.deepEqual(await observeCentralRuntimeSkillApproval(ctx, changed, ports), { ok: true, notified: false });
  }

  const missing = await observeCentralRuntimeSkillApproval(ctx, input, ports);

  assert.equal(!missing.ok && missing.reason, "skill_approval_source_unavailable");
  assert.equal(notifications, 0);
});

test("approval observation failure remains terminal and notification failure cannot reapply approval", async () => {
  let records = 0, notices = 0;
  const board = managedBoard(), draft = skillApprovalDraft({ ...input, board });
  assert.ok(draft);
  const ports = { recordApproval: async () => { records++; },
    loadBoard: async () => ({ ok: true as const, state: { ...board, rewardV2Facts: [{ ...draft, sequence: 1 }] }, generation: 0 }),

    notify: async () => {
      notices++;
      return { ok: false as const, reason: "runtime_stopping" };
    } };

  assert.deepEqual(await observeCentralRuntimeSkillApproval(ctx, input, ports), { ok: false, reason: "runtime_stopping" });
  assert.equal(records, 1);
  assert.equal(notices, 1);
  await assert.rejects(observeCentralRuntimeSkillApproval(ctx, input,
    { ...ports, recordApproval: async () => { throw new Error("original_observation_failure"); } }), /original_observation_failure/u);
  assert.equal(notices, 1);
});
