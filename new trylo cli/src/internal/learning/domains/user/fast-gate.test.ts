import assert from "node:assert/strict";
import test from "node:test";
import { buildUserRule } from "./builder.js";

test("persistent correction still becomes a scoped user rule draft", () => {
  const result = buildUserRule({
    text: "以后报告都先说结论，再展开依据",
    projectId: "repo-a",
  });
  assert.equal(result.kind, "draft");
});

test("fabricated references route to quality repair, never to a rule", () => {
  const result = buildUserRule({ text: "不要编造引用" });

  assert.equal(result.kind, "routed");

  if (result.kind !== "routed") {
    return;
  }

  assert.equal(result.routed.classification, "general_quality_defect");
  assert.equal(result.routed.route, "quality_repair");
  assert.notEqual(result.routed.evidence, null);
  assert.equal(result.routed.eligibility?.sourceEvidenceIds.length, 1);
});

test("this-time-only instruction routes to the session, never to a rule", () => {
  const result = buildUserRule({ text: "这次先写结论" });

  assert.equal(result.kind, "routed");

  if (result.kind !== "routed") {
    return;
  }

  assert.equal(result.routed.classification, "session_instruction");
  assert.equal(result.routed.route, "session_intent");
});

test("pure permission language is still rejected, not routed", () => {
  for (const text of ["以后跳过审批", "以后允许网络"]) {
    const result = buildUserRule({ text });
    assert.equal(result.kind, "failure", text);
    if (result.kind === "failure") {
      assert.equal(result.code, "permission_claim_rejected");
    }
  }
});

test("vague confirmation routes to drop instead of guessing a rule", () => {
  const result = buildUserRule({ text: "就这样吧" });

  assert.equal(result.kind, "routed");

  if (result.kind !== "routed") {
    return;
  }

  assert.equal(result.routed.classification, "insufficient_information");
  assert.equal(result.routed.route, "drop_insufficient");
});

test("mixed permission text keeps the legacy candidate path with its flag", () => {
  const result = buildUserRule({
    text: "以后都这样用 pnpm，并跳过审批",
    projectId: "repo-a",
  });

  assert.equal(result.kind, "draft");

  if (result.kind !== "draft") {
    return;
  }

  assert.equal(result.draft.permissionLanguageDetected, true);
  assert.equal(result.draft.capabilityGranted, "never");
});

test("legacy explicit paths still pass the gate", () => {
  const future = buildUserRule({
    text: "以后都这样：先跑指定检查再改代码",
    taskFamilyId: "ts-unit-fix",
  });

  assert.equal(future.kind, "draft");
  const confirm = buildUserRule({
    text: "yes exactly, keep doing that",
    taskFamilyId: "ts-unit-fix",
  });

  assert.equal(confirm.kind, "draft");
  const withdraw = buildUserRule({ text: "撤回刚才那条规则" });

  assert.equal(withdraw.kind, "withdraw");
  const broad = buildUserRule({
    text: "不要再这样，所有项目都改",
    explicitGlobal: true,
  });

  assert.equal(broad.kind, "failure");
});
