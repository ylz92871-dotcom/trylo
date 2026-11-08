import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverEvidenceRelations,
  inferDimension,
  synthesizeConclusions,
} from "./conclusion.js";
import type { ConclusionRecord, UserEvidence, UserModelRecord } from "./contracts.js";
import { extractEvidence } from "./evidence.js";
import { fingerprintScopeV2 } from "./scope-v2.js";
import { classifyInferenceDistance, reasonUserModels } from "./user-model.js";

const SCOPE = fingerprintScopeV2({ projectId: "repo-a" });

function evidenceFor(text: string): UserEvidence {
  const evidence = extractEvidence({
    text,
    source: { sessionId: "session-1", turnId: "turn-1" },
  });
  assert.notEqual(evidence, null);
  return evidence as UserEvidence;
}

function conclusionFor(statement: string, overrides?: Partial<ConclusionRecord>): ConclusionRecord {
  return {
    id: "con_test",
    userId: "local-user",
    statement,
    dimension: "reporting_information_density",
    scopeFingerprint: SCOPE,
    supporting: ["ev_1"],
    counter: [],
    contextual: [],
    strength: 0.8,
    temporalState: "stable",
    status: "active",
    version: 1,
    stableKey: ["local-user", "reporting_information_density", SCOPE].join("::"),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("dimension mapping puts report and artifact preferences in their own drawers", () => {
  assert.equal(
    inferDimension("周报先说结论，再展开详细依据"),
    "reporting_information_density",
  );
  assert.equal(
    inferDimension("方案先看结构，再出完整草稿"),
    "work_artifact_workflow",
  );
  assert.equal(inferDimension("减少重复审核，保留最终验证"), "verification_audit");
  assert.equal(inferDimension("今天天气不错"), "agent_autonomy");
});

test("relation discovery only links evidence inside one dimension", () => {
  const a = evidenceFor("以后报告都先说结论");
  const b = evidenceFor("汇报时少说过程，多给依据");
  const c = evidenceFor("减少重复审核");
  const relations = discoverEvidenceRelations({
    userId: "local-user",
    fresh: [a, b],
    existing: [c],
  });

  assert.equal(
    relations.some((relation) => relation.type === "supports"),
    true,
  );
  assert.equal(
    relations.some(
      (relation) =>
        (relation.fromId === a.id && relation.toId === c.id) ||
        (relation.fromId === c.id && relation.toId === a.id),
    ),
    false,
  );
});

test("one strong evidence yields an emerging conclusion", () => {
  const conclusions = synthesizeConclusions({
    userId: "local-user",
    fresh: [evidenceFor("以后报告都先说结论，再展开依据")],
    existing: [],
    relations: [],
    scopeFingerprint: SCOPE,
  });

  assert.equal(conclusions.length, 1);
  const conclusion = conclusions[0] as ConclusionRecord;

  assert.equal(conclusion.dimension, "reporting_information_density");
  assert.equal(conclusion.temporalState, "emerging");
  assert.equal(conclusion.supporting.length, 1);
  assert.equal(
    conclusion.stableKey,
    ["local-user", "reporting_information_density", SCOPE].join("::"),
  );
});

test("a lone weak evidence never becomes a conclusion", () => {
  const weak: UserEvidence = {
    ...evidenceFor("以后报告都先说结论"),
    answers: {
      semantic: 0.4,
      relevance: 0.4,
      contextInformedness: "unknown",
      governance: 1,
      scopeNarrowness: null,
    },
  };
  const conclusions = synthesizeConclusions({
    userId: "local-user",
    fresh: [weak],
    existing: [],
    relations: [],
    scopeFingerprint: SCOPE,
  });

  assert.equal(conclusions.length, 0);
});

test("re-running the same statement merges instead of duplicating", () => {
  const first = synthesizeConclusions({
    userId: "local-user",
    fresh: [evidenceFor("以后报告都先说结论，再展开依据")],
    existing: [],
    relations: [],
    scopeFingerprint: SCOPE,
  });

  assert.equal(first.length, 1);
  const second = synthesizeConclusions({
    userId: "local-user",
    fresh: [evidenceFor("汇报时先说结论")],
    existing: first,
    relations: [],
    scopeFingerprint: SCOPE,
  });

  assert.equal(second.length, 1);
  const merged = second[0] as ConclusionRecord;

  assert.equal(merged.version, 1);
  assert.ok(merged.supporting.length >= 1);
});

test("distance classification keeps D3 out of persistence", () => {
  assert.equal(
    classifyInferenceDistance("用户做事很懒没有耐心", "用户倾向先说结论"),
    "D3",
  );
  assert.equal(
    classifyInferenceDistance("用户倾向先说结论，再展开依据。", "用户倾向先说结论，再展开依据"),
    "D0",
  );
  const rejected = reasonUserModels({
    userId: "local-user",
    conclusions: [conclusionFor("用户很懒，没有耐心看过程")],
  });

  assert.equal(rejected.models.length, 0);
  assert.equal(rejected.rejected[0]?.reason, "d3_forbidden");
});

test("stable conclusions become D0 models with four separate confidences", () => {
  const { models, rejected } = reasonUserModels({
    userId: "local-user",
    conclusions: [conclusionFor("在执行任务中，用户对低信息密度过程性叙述接受度较低。")],
  });

  assert.equal(rejected.length, 0);
  assert.equal(models.length, 1);
  const model = models[0] as UserModelRecord;

  assert.equal(model.distance, "D0");
  assert.equal(model.effectiveness, "unknown");
  assert.equal(model.confirmation, "unconfirmed");
  assert.equal(typeof model.truth.score, "number");
  assert.equal(typeof model.scope.score, "number");
  assert.ok(model.alternativeExplanations.length > 0);
  assert.equal(model.derivedFromConclusionIds.length, 1);
});

test("emerging conclusions are capped at D2 and carry context limits", () => {
  const { models } = reasonUserModels({
    userId: "local-user",
    conclusions: [
      conclusionFor("在执行任务中，用户对低信息密度过程性叙述接受度较低。", {
        temporalState: "emerging",
        strength: 0.68,
      }),
    ],
  });

  assert.equal(models.length, 1);
  const model = models[0] as UserModelRecord;

  assert.equal(model.distance, "D2");
  assert.ok(model.truth.score <= 0.72);
});

test("weak conclusions never promote to D2 models", () => {
  const { models, rejected } = reasonUserModels({
    userId: "local-user",
    conclusions: [
      conclusionFor("在执行任务中，用户对低信息密度过程性叙述接受度较低。", {
        temporalState: "emerging",
        strength: 0.4,
      }),
    ],
  });

  assert.equal(models.length, 0);
  assert.equal(rejected[0]?.reason, "weak_conclusion");
});
