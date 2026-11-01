import assert from "node:assert/strict";
import test from "node:test";
import { command, passEvidence } from "./fixtures.js";
import { reduce, reduceAll } from "./reducer.js";
import { emptyBoardState } from "./state.js";

function enqueue(jobId: string, maxAttempts = 1) {
  return command("enqueue_job", {
    job: {
      jobId,
      observationId: `obs-${jobId}`,
      domain: "prompt",
      scope: "project",
      maxAttempts,
      dedupeKey: `obs-${jobId}:prompt:project`,
    },
  });
}

test("requeue only wakes waiting evidence, preserves attempt budget and rejects stale replay payloads", () => {
  const base = reduceAll(emptyBoardState(), [enqueue("wake", 2), command("start_job", { jobId: "wake" }),
    command("complete_job", { jobId: "wake", next: "waiting_evidence" })]); assert.ok(base.ok);
  const wake = { type: "requeue_job" as const, commandId: "wake-once", issuedAt: "2026-10-29T00:00:00.000Z", jobId: "wake", expectedAttempt: 1 };
  const stale = reduce(base.state, { ...wake, commandId: "stale", expectedAttempt: 0 }); assert.equal(stale.ok, false);
  const queued = reduce(base.state, wake); assert.ok(queued.ok);
  assert.equal(queued.state.jobs[0]?.state, "queued"); assert.equal(queued.state.jobs[0]?.attempt, 1);
  const replay = reduce(queued.state, wake); assert.ok(replay.ok); assert.equal(replay.idempotent, true);
  const conflict = reduce(queued.state, { ...wake, expectedAttempt: 2 }); assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.reason, "command_payload_conflict");
  const final = reduceAll(queued.state, [command("start_job", { jobId: "wake" }), command("complete_job", { jobId: "wake", next: "waiting_evidence" })]); assert.ok(final.ok);
  assert.equal(reduce(final.state, { ...wake, commandId: "over", expectedAttempt: 2 }).ok, false);
});

test("waiting approval cannot be requeued into an automatic approval bypass", () => {
  const base = reduceAll(emptyBoardState(), [enqueue("approval", 3), command("start_job", { jobId: "approval" }),
    command("complete_job", { jobId: "approval", next: "waiting_approval" })]); assert.ok(base.ok);
  assert.equal(reduce(base.state, { type: "requeue_job", commandId: "no-bypass", issuedAt: "2026-10-29T00:00:00.000Z", jobId: "approval", expectedAttempt: 1 }).ok, false);
});

test("complete_job can enter waiting_evidence and waiting_approval", () => {
  const queued = reduce(emptyBoardState(), enqueue("j1"));
  assert.equal(queued.ok, true);
  if (!queued.ok) {
    return;
  }
  const running = reduce(queued.state, command("start_job", { jobId: "j1" }));
  assert.equal(running.ok, true);
  if (!running.ok) {
    return;
  }
  const waiting = reduce(
    running.state,
    command("complete_job", { jobId: "j1", next: "waiting_evidence" }),
  );
  assert.equal(waiting.ok, true);
  if (waiting.ok) {
    assert.equal(waiting.state.jobs[0]?.state, "waiting_evidence");
  }
  const other = reduceAll(emptyBoardState(), [
    enqueue("j2"),
    command("start_job", { jobId: "j2" }),
    command("complete_job", { jobId: "j2", next: "waiting_approval" }),
  ]);
  assert.equal(other.ok, true);
  if (other.ok) {
    assert.equal(other.state.jobs[0]?.state, "waiting_approval");
  }
});

test("budget exceeded refuses to start past maxAttempts", () => {
  const prepared = reduceAll(emptyBoardState(), [
    enqueue("j1", 1),
    command("start_job", { jobId: "j1" }),
    command("fail_job", { jobId: "j1", terminal: "failed" }),
  ]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) {
    return;
  }
  const again = reduce(
    prepared.state,
    command("enqueue_job", {
      job: {
        jobId: "j1b",
        observationId: "obs-j1",
        domain: "prompt",
        scope: "project",
        maxAttempts: 1,
        dedupeKey: "other",
      },
    }),
  );
  assert.equal(again.ok, true);
  if (!again.ok) {
    return;
  }
  const started = reduce(again.state, command("start_job", { jobId: "j1b" }));
  assert.equal(started.ok, true);
  const over = reduceAll(emptyBoardState(), [
    enqueue("j2", 0),
    command("start_job", { jobId: "j2" }),
  ]);
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.reason, "job_budget_exceeded");
  }
});

test("expired job opens the breaker", () => {
  const result = reduceAll(emptyBoardState(), [
    enqueue("j1", 1),
    command("start_job", { jobId: "j1" }),
    command("fail_job", { jobId: "j1", terminal: "expired" }),
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.jobs[0]?.state, "expired");
    assert.equal(result.state.jobs[0]?.breakerOpen, true);
  }
});

test("tombstone scopes its effects by entityType (audit P1-1)", () => {
  const submitted = reduce(emptyBoardState(), command("submit_proposal", {
    proposal: {
      proposalId: "tool_package:c1",
      domain: "tool",
      scope: "docs",
      assetKind: "tool_package",
      candidateRef: "tool_package:c1:v1",
      hypothesis: "h",
      observationRefs: ["obs-1"],
      risk: "low",
      requiredVerifiers: ["tool_validation_pipeline"],
      requestedAuthorities: ["fs.read"],
      source: "inferred",
    },
  }));
  assert.equal(submitted.ok, true);
  if (!submitted.ok) {
    return;
  }
  const activated = reduceAll(submitted.state, [
    command("quarantine", { proposalId: "tool_package:c1" }),
    command("start_evaluation", { proposalId: "tool_package:c1" }),
    command("commit_asset", {
      versionId: "asset:v1",
      proposalId: "tool_package:c1",
      content: { packageVersionId: "pkg:1" },
      schemaVersion: 1,
    }),
    command("record_evidence", {
      // 外审 R2 §3.1：外部验证证据必须携带权威回读得到的 receipt 坐标，
      // 且 provenance 必须与之绑定（`receipt:<id>`）；Board 侧只做可追溯性门，
      // 真正的判定发生在 integration 的信任准入网关。
      evidence: passEvidence("tool_package:c1", {
        evidenceId: "ev-1",
        dataVersion: "validation-v1",
      }),
    }),
    command("enter_shadow", { proposalId: "tool_package:c1", versionId: "asset:v1" }),
    command("request_approval", { proposalId: "tool_package:c1", approvalId: "apr-1", action: "install" }),
    command("record_approval_decision", { approvalId: "apr-1", status: "granted" }),
    command("activate", { proposalId: "tool_package:c1", versionId: "asset:v1" }),
  ]);
  assert.equal(activated.ok, true);
  if (!activated.ok) {
    return;
  }
  const base = activated.state;

  // entityType="fragment"：Board 不拥有 knowledge/observation 空间，无法证明目标
  // 存在 —— 越界拒绝，且绝不触碰同 id 的 proposal / activation（P1-1 + D4.1）。
  const fragment = reduce(base, command("tombstone", {
    entityId: "tool_package:c1",
    entityType: "fragment",
    reason: "误报",
  }));
  assert.equal(fragment.ok, false);
  if (!fragment.ok) {
    assert.equal(fragment.reason, "tombstone_target_out_of_scope");
  }
  assert.equal(fragment.state.tombstones.length, 0);
  assert.equal(fragment.state.proposals.find((p) => p.proposalId === "tool_package:c1")?.lifecycle, "active");
  assert.equal(fragment.state.activations[0]?.pointer, "active");

  // observation 同理：Board 无法证明其存在，拒绝而非 fail open 地写墓碑。
  const observation = reduce(base, command("tombstone", {
    entityId: "obs-1",
    entityType: "observation",
    reason: "误报",
  }));
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.reason, "tombstone_target_out_of_scope");
  }
  assert.equal(observation.state.tombstones.length, 0);

  // Board 拥有但查不到的目标：not_found，与「越界」分开，审计可区分试探与重复撤回。
  const missing = reduce(base, command("tombstone", {
    entityId: "no-such-proposal",
    entityType: "proposal",
    reason: "撤回幽灵",
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "tombstone_target_not_found");
  }
  assert.equal(missing.state.tombstones.length, 0);

  // entityType="asset"：只退役该版本的激活，proposal 生命周期不变。
  const assetOnly = reduce(base, command("tombstone", {
    entityId: "asset:v1",
    entityType: "asset",
    reason: "资产删除",
  }));
  assert.equal(assetOnly.ok, true);
  if (assetOnly.ok) {
    assert.equal(assetOnly.state.proposals.find((p) => p.proposalId === "tool_package:c1")?.lifecycle, "active");
    assert.equal(assetOnly.state.activations[0]?.pointer, "retired");
  }

  // 重复 tombstone 同一实体被拒（tombstone_exists 先于目标合法性判定）。
  const duplicate = reduce(assetOnly.ok ? assetOnly.state : base, command("tombstone", {
    entityId: "asset:v1",
    entityType: "asset",
    reason: "再次",
  }));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.reason, "tombstone_exists");
  }

  // entityType="proposal"：proposal 被拒，其产出的资产激活被退役。
  const proposalOnly = reduce(base, command("tombstone", {
    entityId: "tool_package:c1",
    entityType: "proposal",
    reason: "整案撤回",
  }));
  assert.equal(proposalOnly.ok, true);
  if (proposalOnly.ok) {
    assert.equal(proposalOnly.state.proposals.find((p) => p.proposalId === "tool_package:c1")?.lifecycle, "rejected");
    assert.equal(proposalOnly.state.activations[0]?.pointer, "retired");
  }

  // 已退休的目标被拒：终止态实体不能再被撤回（D4.1）。
  const suspended = reduceAll(base, [
    command("suspend", { proposalId: "tool_package:c1", breakerReason: "user_withdraw" }),
    command("retire", { proposalId: "tool_package:c1" }),
  ]);
  assert.equal(suspended.ok, true);
  if (suspended.ok) {
    assert.equal(suspended.state.proposals.find((p) => p.proposalId === "tool_package:c1")?.lifecycle, "retired");
    const retiredRefused = reduce(suspended.state, command("tombstone", {
      entityId: "tool_package:c1",
      entityType: "proposal",
      reason: "重复撤回",
    }));
    assert.equal(retiredRefused.ok, false);
    if (!retiredRefused.ok) {
      assert.equal(retiredRefused.reason, "tombstone_target_retired");
    }
    assert.equal(retiredRefused.state.tombstones.length, 0);
  }

  // 非法 entityType 在运行时被拒（重放路径可能来自 JSON）。
  const invalid = reduce(base, {
    type: "tombstone",
    commandId: "c-invalid",
    issuedAt: "2026-09-12T00:00:00Z",
    entityId: "x",
    entityType: "tool" as never,
    reason: "y",
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.reason, "invalid_entity_type");
  }
});
