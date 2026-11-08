import assert from "node:assert/strict";
import test from "node:test";
import { buildUserRule, currentInstructionWins } from "./builder.js";

test("explicit future directive becomes a scoped user rule draft", () => {
  const result = buildUserRule({
    text: "以后都这样：先跑指定检查再改代码",
    taskFamilyId: "ts-unit-fix",
  });

  assert.equal(result.kind, "draft");

  if (result.kind !== "draft") {
    return;
  }

  assert.equal(result.draft.status, "draft");
  assert.equal(result.draft.scope.kind, "task_family");
  assert.equal(result.draft.speechAct, "future_directive");
  assert.equal(result.draft.permissionClaim, false);
  assert.equal(result.draft.capabilityGranted, "never");
  assert.equal(result.draft.command.kind, "submit_draft");
  assert.equal("permission" in result.draft, false);
  assert.equal("allowNetwork" in result.draft, false);
});

test("withdraw produces a withdraw command draft", () => {
  const result = buildUserRule({ text: "撤回刚才那条规则" });
  assert.equal(result.kind, "withdraw");
  if (result.kind === "withdraw") {
    assert.equal(result.draft.command.kind, "submit_withdraw");
    assert.equal(result.draft.status, "draft");
  }
});

test("skip-approval text does not grant permission", () => {
  const only = buildUserRule({ text: "以后跳过审批" });

  assert.equal(only.kind, "failure");

  if (only.kind === "failure") {
    assert.equal(only.code, "permission_claim_rejected");
  }

  const network = buildUserRule({ text: "以后允许网络" });

  assert.equal(network.kind, "failure");

  if (network.kind === "failure") {
    assert.equal(network.code, "permission_claim_rejected");
  }

  const mixed = buildUserRule({
    text: "以后都这样用 pnpm，并跳过审批",
    projectId: "repo-a",
  });

  assert.equal(mixed.kind, "draft");

  if (mixed.kind === "draft") {
    assert.equal(mixed.draft.capabilityGranted, "never");
    assert.equal(mixed.draft.permissionClaim, false);
    assert.equal(mixed.draft.permissionLanguageDetected, true);
    assert.match(mixed.draft.ruleText, /pnpm/);
    assert.equal("grants" in mixed.draft, false);
  }
});

test("one complaint is not a global rule", () => {
  const result = buildUserRule({
    text: "不要再这样，所有项目都改",
    explicitGlobal: true,
  });

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "scope_too_broad");
  }
});

test("current instruction wins over historical rule", () => {
  const decision = currentInstructionWins("this task: use pnpm only", "always use npm");
  assert.equal(decision.winner, "current_instruction");
  assert.equal(decision.conflict, true);
});

test("explicit confirm is a scoped user rule", () => {
  const result = buildUserRule({
    text: "yes exactly, keep doing that",
    taskFamilyId: "ts-unit-fix",
  });

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.speechAct, "confirm");
    assert.notEqual(result.draft.scope.kind, "user_global");
  }
});

test("non-explicit text is not inferred into a user rule", () => {
  const result = buildUserRule({ text: "hmm this output is long and confident" });
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.code, "not_explicit");
  }
});
