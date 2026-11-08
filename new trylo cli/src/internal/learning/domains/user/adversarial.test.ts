import assert from "node:assert/strict";
import test from "node:test";
import { assertNoActivation } from "../shared/board-command.js";
import { compileBehaviorCommitments } from "./behavior-commitment.js";
import { buildUserRule } from "./builder.js";
import { synthesizeConclusions } from "./conclusion.js";
import type { UserEvidence } from "./contracts.js";
import { classifyEligibility } from "./eligibility.js";
import { extractEvidence } from "./evidence.js";
import { commitBundle, compilePolicyBundle, verifyBundleChecksum } from "./policy-compile.js";
import { evaluateOutcome } from "./outcome-evaluator.js";
import { decideScope } from "./scope.js";
import { fingerprintScopeV2 } from "./scope-v2.js";
import { reasonUserModels } from "./user-model.js";

const SCOPE = fingerprintScopeV2({ projectId: "repo-a" });

function evidenceFor(text: string): UserEvidence {
  const evidence = extractEvidence({
    text,
    source: { sessionId: "session-1", turnId: "turn-1" },
  });
  assert.notEqual(evidence, null);
  return evidence as UserEvidence;
}

function candidateChain(text: string) {
  const evidence = evidenceFor(text);
  const eligibility = classifyEligibility({ evidence, speechAct: "future_directive" });
  const conclusions = synthesizeConclusions({
    userId: "local-user",
    fresh: [evidence],
    existing: [],
    relations: [],
    scopeFingerprint: SCOPE,
  });
  const { models } = reasonUserModels({ userId: "local-user", conclusions });
  const commitments = compileBehaviorCommitments({
    userId: "local-user",
    models,
    evidence: [evidence],
    eligibility: [eligibility],
  });

  return { evidence, eligibility, conclusions, models, commitments };
}

test("反方#1：跳过任何一步都成不了链（空输入逐层断）", () => {
  assert.equal(
    synthesizeConclusions({
      userId: "local-user",
      fresh: [],
      existing: [],
      relations: [],
      scopeFingerprint: SCOPE,
    }).length,
    0,
  );
  assert.equal(reasonUserModels({ userId: "local-user", conclusions: [] }).models.length, 0);
  assert.equal(
    compileBehaviorCommitments({ userId: "local-user", models: [], evidence: [], eligibility: [] }).length,
    0,
  );
  const compiled = compilePolicyBundle({ userId: "local-user", commitments: [], models: [] });

  assert.equal(compiled.rules.length, 0);
  assert.equal(verifyBundleChecksum(compiled), true);
});

test("反方#2：质量缺陷走完全链也产不出画像与承诺", () => {
  const evidence = evidenceFor("不要编造引用");
  const eligibility = classifyEligibility({ evidence, speechAct: "not_explicit" });

  assert.equal(eligibility.classification, "general_quality_defect");
  const conclusions = synthesizeConclusions({
    userId: "local-user",
    fresh: [evidence],
    existing: [],
    relations: [],
    scopeFingerprint: SCOPE,
  });
  const { models } = reasonUserModels({ userId: "local-user", conclusions });
  const commitments = compileBehaviorCommitments({
    userId: "local-user",
    models,
    evidence: [evidence],
    eligibility: [eligibility],
  });

  assert.equal(commitments.length, 0);
  const built = buildUserRule({ text: "不要编造引用" });

  assert.equal(built.kind, "routed");
});

test("反方#3：仅本次意图升不了长期链", () => {
  const built = buildUserRule({ text: "这次先写结论" });

  assert.equal(built.kind, "routed");
  const evidence = evidenceFor("这次先写结论");
  const eligibility = classifyEligibility({ evidence, speechAct: "not_explicit" });

  assert.equal(eligibility.classification, "session_instruction");
  const { models } = reasonUserModels({
    userId: "local-user",
    conclusions: synthesizeConclusions({
      userId: "local-user",
      fresh: [evidence],
      existing: [],
      relations: [],
      scopeFingerprint: SCOPE,
    }),
  });

  assert.equal(
    compileBehaviorCommitments({
      userId: "local-user",
      models,
      evidence: [evidence],
      eligibility: [eligibility],
    }).length,
    0,
  );
});

test("反方#4：授权话术永不进入规则正文", () => {
  for (const text of ["以后跳过审批", "允许网络，以后都允许"]) {
    const built = buildUserRule({ text });
    assert.notEqual(built.kind, "draft", text);
  }

  const mixed = buildUserRule({ text: "以后都这样用 pnpm，并跳过审批", projectId: "repo-a" });

  assert.equal(mixed.kind, "draft");

  if (mixed.kind === "draft") {
    assert.equal(mixed.draft.ruleText.includes("跳过审批"), false);
    assert.equal(mixed.draft.capabilityGranted, "never");
  }
});

test("反方#5：模糊表述不猜，效果位保持 unknown", () => {
  const built = buildUserRule({ text: "就这样吧" });
  assert.equal(built.kind, "routed");
  const { models } = candidateChain("以后周报都先说结论，再展开依据");
  for (const model of models) {
    assert.equal(model.effectiveness, "unknown");
  }
});

test("反方#6：原文与推断物理分离（改推断不动原文）", () => {
  const evidence = evidenceFor("以后报告都先说结论");
  const edited: UserEvidence = { ...evidence, claim: "被篡改的解读" };
  assert.equal(edited.rawText, "以后报告都先说结论");
  assert.notEqual(edited.claim, edited.rawText);
});

test("反方#7：scope v2 身份条件分离，且旧 fast-path 语义不回退", () => {
  const decision = decideScope({ text: "不要再这样，所有项目都改", explicitGlobal: true }, "correction");
  assert.equal(decision.kind, "too_broad");
  const ok = decideScope({ text: "以后都这样：先跑检查", taskFamilyId: "f1" }, "future_directive");
  assert.equal(ok.kind, "ok");
});

test("反方#8：bundle 里拼不出任何提示词，候选承诺编不进包", () => {
  const { commitments, models } = candidateChain("以后周报都先说结论，再展开依据");
  const compiled = compilePolicyBundle({ userId: "local-user", commitments, models });
  const serialized = JSON.stringify(compiled);

  for (const forbidden of ["promptMessages", "renderInjection", "systemPrompt", "inject"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  assert.doesNotThrow(() => assertNoActivation(compiled.bundle));
  assert.doesNotThrow(() => assertNoActivation(compiled.rules[0] as unknown as object));
  assert.throws(() => assertNoActivation({ activate: true }), /forbidden board action/);
});

test("反方#9：任务完成与缺反馈都不升偏好", () => {
  const { commitments } = candidateChain("以后周报都先说结论，再展开依据");
  const id = commitments[0]?.id as string;
  const done = evaluateOutcome({ commitmentIds: [id], events: [], taskOutcome: "completed" });

  for (const observation of done.observations) {
    assert.notEqual(observation.attribution, "direct");
  }

  const silent = evaluateOutcome({ commitmentIds: [id], events: [] });

  assert.equal(silent.observations.length, 0);
});

test("反方#10：无来源承诺不存在（provenance 为空即无承诺）", () => {
  const { models, eligibility } = candidateChain("以后周报都先说结论，再展开依据");
  const commitments = compileBehaviorCommitments({
    userId: "local-user",
    models,
    evidence: [],
    eligibility: [eligibility],
  });

  assert.equal(commitments.length, 0);
});

test("反方#11：域产物里藏不下激活指令", () => {
  const { commitments, models, evidence } = candidateChain("以后周报都先说结论，再展开依据");

  for (const item of [...commitments, ...models, evidence]) {
    assert.doesNotThrow(() => assertNoActivation(item as unknown as object));
  }

  const compiled = compilePolicyBundle({ userId: "local-user", commitments, models });
  const state = commitBundle({ bundles: [] }, compiled);

  assert.equal(state.currentBundleId, compiled.bundle.id);
  assert.doesNotThrow(() => assertNoActivation(state as unknown as object));
});

test("反方#12：三条违规路径全部有测试背书，零 draft 产出", () => {
  const cases = ["不要编造引用", "这次先写结论", "以后跳过审批", "就这样吧"];
  for (const text of cases) {
    const built = buildUserRule({ text });
    assert.notEqual(built.kind, "draft", text);
  }
});
