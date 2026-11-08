import assert from "node:assert/strict";
import test from "node:test";
import { command, inferredDraft, passEvidence, userRuleDraft } from "../control/fixtures.js";
import { reduceAll } from "../control/reducer.js";
import { emptyBoardState } from "../control/state.js";
import { assembleDegraded, assembleFromState } from "./assemble.js";
import { resolveProfile } from "./resolver.js";

test("same inputs produce the same snapshot hash", () => {
  const state = fastLaneState("always run checks");
  const first = resolveProfile(state, { scope: "user" });
  const second = resolveProfile(state, { scope: "user" });
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.snapshotId, second.snapshotId);
});

test("current instruction is recorded as higher precedence than assets", () => {
  const state = fastLaneState("always run checks");
  const snapshot = resolveProfile(state, {
    scope: "user",
    currentInstruction: "this task: use pnpm only",
  });

  assert.equal(
    snapshot.diagnostics.some((item) => item.code === "current_instruction_precedes_assets"),
    true,
  );
  assert.equal("permission" in snapshot, false);
  assert.equal("allowNetwork" in snapshot, false);
  assert.equal("skipApproval" in snapshot, false);
});

test("inferred shadow assets are not full-active profile members", () => {
  const draft = inferredDraft({ proposalId: "inf" });
  const result = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: "inf" }),
    command("start_evaluation", { proposalId: "inf" }),
    command("commit_asset", {
      proposalId: "inf",
      versionId: "v-inf",
      content: { text: "always use npm" },
      schemaVersion: 1,
    }),
    command("record_evidence", { evidence: passEvidence("inf") }),
    command("enter_shadow", { proposalId: "inf", versionId: "v-inf" }),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const snapshot = resolveProfile(result.state, { scope: "project" });

  assert.equal(snapshot.promptPatches.length, 0);
  assert.equal(snapshot.userRules.length, 0);
});

test("tool bindings do not become permission fields", () => {
  const draft = inferredDraft({
    proposalId: "tb",
    assetKind: "tool_binding",
    domain: "tool",
  });
  const result = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: "tb" }),
    command("start_evaluation", { proposalId: "tb" }),
    command("commit_asset", {
      proposalId: "tb",
      versionId: "v-tb",
      content: { text: "git" },
      schemaVersion: 1,
    }),
    command("record_evidence", { evidence: passEvidence("tb") }),
    command("enter_shadow", { proposalId: "tb", versionId: "v-tb" }),
    command("request_approval", {
      proposalId: "tb",
      approvalId: "ap",
      action: "activate",
    }),
    command("record_approval_decision", { approvalId: "ap", status: "granted" }),
    command("activate", { proposalId: "tb", versionId: "v-tb" }),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const snapshot = resolveProfile(result.state, { scope: "project" });

  assert.equal(snapshot.toolBindings.length, 1);
  assert.equal("permission" in snapshot, false);
  assert.equal("allowNetwork" in snapshot, false);
});

test("assemble preserves caller messages on degrade", () => {
  const messages = [{ role: "user", content: "keep me" }];
  const assembled = assembleDegraded(
    { messages },
    undefined,
    "board_unavailable",
    "store corrupt",
  );

  assert.deepEqual(assembled.messages, messages);
  assert.deepEqual(assembled.systemFragments, []);
  assert.equal(assembled.verified, false);
  assert.equal(assembled.degradedReason?.code, "board_unavailable");
  assert.equal(assembled.profileSnapshot.learningMode, "no_learning");
});

test("aborted assemble keeps messages and uses timeout reason", () => {
  const messages = [{ role: "user", content: "keep me" }];
  const assembled = assembleFromState(emptyBoardState(), {
    messages,
    signal: AbortSignal.abort(),
  });

  assert.deepEqual(assembled.messages, messages);
  assert.equal(assembled.degradedReason?.code, "learning_timeout");
});

test("scoped user rule outranks project rule of the same kind", () => {
  const user = userRuleDraft({ proposalId: "pu", scope: "user" });
  const project = userRuleDraft({ proposalId: "pp", scope: "project" });
  const result = reduceAll(emptyBoardState(), [
    ...fastLaneCommands(user, "v-user", "use pnpm"),
    ...fastLaneCommands(project, "v-proj", "use npm"),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const snapshot = resolveProfile(result.state, { scope: "user" });

  assert.equal(snapshot.userRules.length, 1);
  assert.equal(snapshot.userRules[0]?.scope, "user");
  assert.equal(snapshot.userRules[0]?.text, "use pnpm");
  assert.equal(snapshot.userRules.some((rule) => rule.text === "use pnpm use npm"), false);
});

test("same-rank conflicting rules are not silently concatenated", () => {
  const left = userRuleDraft({ proposalId: "pa", scope: "alpha" });
  const right = userRuleDraft({ proposalId: "pb", scope: "beta" });
  const result = reduceAll(emptyBoardState(), [
    ...fastLaneCommands(left, "v-a", "do A"),
    ...fastLaneCommands(right, "v-b", "do B"),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const snapshot = resolveProfile(result.state, { scope: "alpha" });

  assert.equal(
    snapshot.diagnostics.some((item) => item.code === "conflict_unresolved"),
    true,
  );
  assert.equal(snapshot.userRules.length, 0);
});

function fastLaneCommands(
  draft: ReturnType<typeof userRuleDraft>,
  versionId: string,
  text: string,
) {
  return [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId,
      content: { text },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: draft.proposalId, versionId }),
  ];
}

function fastLaneState(text: string) {
  const draft = userRuleDraft({ proposalId: "p-user" });
  const result = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v-user",
      content: { text },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: draft.proposalId, versionId: "v-user" }),
  ]);
  if (!result.ok) {
    throw new Error(result.detail);
  }

  return result.state;
}
