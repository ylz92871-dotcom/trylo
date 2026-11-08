import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfile } from "../profile/resolver.js";
import { command, userRuleDraft } from "./fixtures.js";
import { reduce, reduceAll } from "./reducer.js";
import { emptyBoardState } from "./state.js";

const BREAKERS = [
  "critical_verification_failed",
  "negative_delta",
  "consecutive_run_errors",
  "user_withdraw",
] as const;

test("suspend for each breaker cause drops the asset from the next snapshot", () => {
  for (const cause of BREAKERS) {
    const draft = userRuleDraft({ proposalId: `p-${cause}` });
    const prepared = reduceAll(emptyBoardState(), [
      command("submit_proposal", { proposal: draft }),
      command("fast_lane_validate", { proposalId: draft.proposalId }),
      command("commit_asset", {
        proposalId: draft.proposalId,
        versionId: `v-${cause}`,
        content: { text: "rule" },
        schemaVersion: 1,
      }),
      command("activate", { proposalId: draft.proposalId, versionId: `v-${cause}` }),
    ]);

    assert.equal(prepared.ok, true, cause);

    if (!prepared.ok) {
      continue;
    }

    const suspended = reduce(
      prepared.state,
      command("suspend", { proposalId: draft.proposalId, breakerReason: cause }),
    );

    assert.equal(suspended.ok, true, cause);

    if (!suspended.ok) {
      continue;
    }

    assert.equal(suspended.state.activations[0]?.breaker?.open, true);
    assert.equal(suspended.state.activations[0]?.breaker?.reason, cause);
    const snapshot = resolveProfile(suspended.state, { scope: "user" });

    assert.equal(snapshot.userRules.length, 0, cause);
  }
});

test("retire keeps history but is absent from snapshot; tombstone refuses a retired target", () => {
  const draft = userRuleDraft({ proposalId: "p-retire" });
  const active = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v-retire",
      content: { text: "rule" },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: draft.proposalId, versionId: "v-retire" }),
    command("suspend", { proposalId: draft.proposalId, breakerReason: "user_withdraw" }),
  ]);

  assert.equal(active.ok, true);

  if (!active.ok) {
    return;
  }

  const retired = reduce(active.state, command("retire", { proposalId: draft.proposalId }));

  assert.equal(retired.ok, true);

  if (!retired.ok) {
    return;
  }

  // retire 只推进生命周期：proposal 与 asset 的历史仍在，但不再进入读模型快照。
  assert.equal(retired.state.proposals[0]?.lifecycle, "retired");
  assert.equal(retired.state.assets.length, 1);
  assert.equal(resolveProfile(retired.state, { scope: "user" }).userRules.length, 0);

  // 外审 R2 §3.3（原文 P1-R3）：已退休属于终止态，tombstone 必须显式拒绝。
  // 旧实现无条件写入墓碑，于是「一条自洽的撤回 draft」就能把任意实体打成墓碑。
  const refused = reduce(
    retired.state,
    command("tombstone", {
      entityId: draft.proposalId,
      entityType: "proposal",
      reason: "delete",
    }),
  );

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.reason, "tombstone_target_retired");
  }

  assert.equal(refused.state.tombstones.length, 0);
});

test("tombstone on a live target records the tombstone and retires its activation", () => {
  const draft = userRuleDraft({ proposalId: "p-tombstone" });
  const active = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v-tombstone",
      content: { text: "rule" },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: draft.proposalId, versionId: "v-tombstone" }),
  ]);

  assert.equal(active.ok, true);

  if (!active.ok) {
    return;
  }

  const deleted = reduce(
    active.state,
    command("tombstone", {
      entityId: draft.proposalId,
      entityType: "proposal",
      reason: "delete",
    }),
  );

  assert.equal(deleted.ok, true);

  if (!deleted.ok) {
    return;
  }

  assert.equal(deleted.state.tombstones.length, 1);
  assert.equal(deleted.state.assets.length, 1);
  assert.equal(
    deleted.state.proposals.find((item) => item.proposalId === draft.proposalId)?.lifecycle,
    "rejected",
  );
  assert.equal(deleted.state.activations[0]?.pointer, "retired");
  assert.equal(resolveProfile(deleted.state, { scope: "user" }).userRules.length, 0);
});
