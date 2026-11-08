import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCandidate, evaluateInducedDraft, evaluatePromptPatchDraft } from "./evaluator.js";
import { detectPromptPatch } from "../learning/agent/subsystems/method/legacy-prompt/detector.js";
import type { PromptGainEpisode } from "../learning/agent/subsystems/method/legacy-prompt/attribution.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { qualityDeltaIgnoringLength } from "./goodhart.js";
import { keepBest } from "./keep-best.js";
import { assertRoleSeparation, generatorPort } from "./ports.js";
import { renderProfilePreview } from "./profile-preview.js";
import type { EvaluationRequest } from "./types.js";
import type { ExternalVerdict } from "../learning/domains/shared/types.js";

function verdict(
  result: ExternalVerdict["result"],
  selfGenerated = false,
): ExternalVerdict {
  return {
    kind: "test",
    result,
    ref: `ref-${result}-${selfGenerated ? "self" : "ext"}`,
    selfGenerated,
  };
}

function request(patch: Partial<EvaluationRequest>): EvaluationRequest {
  return {
    proposalId: "pp_1",
    baselineRef: "obs-a",
    candidateRef: "obs-b",
    generatorRoleId: "generator",
    evaluatorRoleId: "evaluator",
    baselineAnchors: [verdict("fail")],
    candidateAnchors: [verdict("pass")],
    weakSignals: [],
    costDelta: 0,
    latencyDelta: 0,
    outputLengthDelta: 0,
    criticalRegressionFailed: false,
    failureDiversity: 1,
    sampleSize: 2,
    ...patch,
  };
}

test("evaluator with only LLM self-score cannot set externalPass", () => {
  const bundle = evaluateCandidate(
    request({
      candidateAnchors: [],
      weakSignals: [{ kind: "llm_self_score", note: "I did better" }],
    }),
  );

  assert.equal(bundle.externalPass, false);
  assert.equal(bundle.verdict, "no_external_pass");
  assert.equal(bundle.commandKind, "submit_evidence");
});

test("critical regression rejects even if the primary metric improved", () => {
  const bundle = evaluateCandidate(request({ criticalRegressionFailed: true }));
  assert.equal(bundle.verdict, "critical_regression");
  assert.equal(bundle.externalPass, false);
});

test("self-generated tests cannot be the sole external anchor", () => {
  const bundle = evaluateCandidate(
    request({
      candidateAnchors: [verdict("pass", true)],
      weakSignals: [{ kind: "self_generated_tests", note: "generator wrote passing tests" }],
    }),
  );

  assert.equal(bundle.externalPass, false);
  assert.equal(bundle.verdict, "no_external_pass");
});

test("independent external pass recommends shadow, never activation", () => {
  const bundle = evaluateCandidate(request({}));

  assert.equal(bundle.verdict, "recommend_shadow");
  assert.equal(bundle.externalPass, true);
  assert.equal("activate" in bundle, false);
  assert.equal(bundle.replay.compared, true);
  assert.equal(bundle.sampleConfidence, "sufficient");
  assert.equal(bundle.shadowRecommended, true);
  assert.equal(bundle.deterministicChecks.includes("independent_external_anchors"), true);
  assert.equal(bundle.externalAnchors.every((anchor) => anchor.selfGenerated === false), true);
});

test("self-generated anchors are stripped from externalAnchors", () => {
  const bundle = evaluateCandidate(
    request({
      candidateAnchors: [verdict("pass", true), verdict("pass", false)],
    }),
  );

  assert.equal(bundle.externalAnchors.length, 1);
  assert.equal(bundle.externalAnchors[0]?.selfGenerated, false);
});

test("cost and latency spike without failure diversity is rejected", () => {
  const bundle = evaluateCandidate(
    request({
      costDelta: 80,
      latencyDelta: 80,
      failureDiversity: 0,
    }),
  );

  assert.equal(bundle.verdict, "reject");
  assert.equal(bundle.externalPass, false);
  assert.equal(bundle.negativeCritique.length > 0, true);
});

test("judge rubric cannot fill externalPass", () => {
  const bundle = evaluateCandidate(
    request({
      candidateAnchors: [],
      judgeRubricScore: 0.99,
    }),
  );

  assert.equal(bundle.externalPass, false);
  assert.equal(
    bundle.weakSignals.some((signal) => signal.kind === "judge_rubric"),
    true,
  );
});

test("keep-best never activates even when candidate wins shadow", () => {
  const bundle = evaluateCandidate(request({}));
  const best = keepBest(bundle);

  assert.equal(best.kind, "keep_candidate");

  if (best.kind === "keep_candidate") {
    assert.equal(best.activationEligible, false);
  }

  const rejected = keepBest(evaluateCandidate(request({ criticalRegressionFailed: true })));

  assert.equal(rejected.kind, "keep_baseline");
});

test("evidence records a confidence interval", () => {
  const bundle = evaluateCandidate(request({ sampleSize: 2 }));
  assert.equal(bundle.confidenceInterval.n >= 2, true);
  assert.equal(bundle.confidenceInterval.low <= bundle.confidenceInterval.high, true);
});

test("profile drops duplicates and global scope leaks", () => {
  const preview = renderProfilePreview({
    currentInstruction: { text: "do the task" },
    previewScope: "task",
    tokenBudget: 500,
    assets: [
      {
        id: "a",
        kind: "user_rule",
        origin: "inferred",
        sourceMark: "user_rule@v1",
        body: "same body",
        scopeKind: "task",
      },
      {
        id: "b",
        kind: "user_rule",
        origin: "inferred",
        sourceMark: "user_rule@v1",
        body: "same body",
        scopeKind: "task",
      },
      {
        id: "global",
        kind: "user_rule",
        origin: "inferred",
        sourceMark: "user_rule@v9",
        body: "always everywhere",
        scopeKind: "user_global",
      },
    ],
  });
  if ("kind" in preview) {
    assert.fail("preview should succeed");
    return;
  }

  assert.equal(preview.duplicates.includes("b"), true);
  assert.equal(preview.scopeLeaks.includes("global"), true);
  assert.equal(preview.applied.some((asset) => asset.id === "global"), false);
  assert.equal(preview.snapshot.userRules.some((asset) => asset.id === "a"), true);
  assert.equal(preview.snapshot.workflows.length, 0);
});

test("evaluator consumes a prompt draft and records threshold plus successRate", () => {
  const file = path.join(
    process.cwd(),
    "testdata",
    "learning-domains",
    "positive",
    "two-comparable-prompt-gains.json",
  );
  const payload = JSON.parse(readFileSync(file, "utf8")) as { episodes: PromptGainEpisode[] };
  const detected = detectPromptPatch({ episodes: payload.episodes });

  assert.equal(detected.kind, "draft");

  if (detected.kind !== "draft") {
    return;
  }

  const bundle = evaluatePromptPatchDraft(detected.draft, request({}));

  assert.equal(bundle.proposalId, detected.draft.id);
  assert.equal(bundle.threshold, 2);
  assert.equal(bundle.metrics.successRate > 0, true);
  assert.equal(bundle.shadowRecommended, true);
});

test("induced skill/workflow drafts still need external eval and cannot activate", () => {
  const bundle = evaluateInducedDraft("sk_1", request({}));

  assert.equal(bundle.proposalId, "sk_1");
  const best = keepBest(bundle);

  assert.equal(best.kind, "keep_candidate");

  if (best.kind === "keep_candidate") {
    assert.equal(best.activationEligible, false);
  }

  const weak = evaluateInducedDraft("wf_1", request({ candidateAnchors: [] }));

  assert.equal(weak.externalPass, false);
});

test("longer output does not increase quality", () => {
  assert.equal(qualityDeltaIgnoringLength(false, true, 9999), 1);
  assert.equal(qualityDeltaIgnoringLength(true, true, 9999), 0);
  assert.equal(qualityDeltaIgnoringLength(false, false, 9999), 0);
});

test("generator and evaluator roles are separated and cannot activate", () => {
  const generator = generatorPort();
  const evaluator = { role: "evaluator" as const, evaluate: evaluateCandidate };
  assert.equal(assertRoleSeparation(generator, evaluator).separated, true);
  assert.equal("evaluate" in generator, false);
  assert.equal("propose" in evaluator, false);
});

test("shared role id cannot self-approve", () => {
  const bundle = evaluateCandidate(
    request({ generatorRoleId: "same", evaluatorRoleId: "same" }),
  );
  assert.equal(bundle.externalPass, false);
  assert.equal(bundle.verdict, "no_external_pass");
});

test("profile preview reports conflicts and keeps the current instruction", () => {
  const preview = renderProfilePreview({
    currentInstruction: {
      text: "this task: use pnpm only",
      constraintKey: "package_manager",
      constraintValue: "pnpm",
    },
    assets: [
      {
        id: "hist-npm",
        kind: "user_rule",
        origin: "inferred",
        sourceMark: "user_rule@v1",
        body: "always use npm",
        constraintKey: "package_manager",
        constraintValue: "npm",
      },
    ],
    tokenBudget: 200,
  });

  assert.equal("kind" in preview && preview.kind === "failure", false);

  if ("kind" in preview) {
    return;
  }

  assert.equal(preview.currentInstruction, "this task: use pnpm only");
  assert.equal(preview.currentInstructionPreserved, true);
  assert.equal(preview.rendered[0]?.sourceMark, "current_instruction");
  assert.equal(preview.rendered[0]?.untrimmable, true);
  assert.equal(preview.conflicts.includes("hist-npm"), true);
  assert.equal(preview.applied.some((asset) => asset.id === "hist-npm"), false);
});

test("token budget trims inferred assets but never the current instruction", () => {
  const preview = renderProfilePreview({
    currentInstruction: { text: "CURRENT_INSTRUCTION_MUST_STAY" },
    assets: [
      {
        id: "wf-long",
        kind: "workflow",
        origin: "inferred",
        sourceMark: "workflow@v1",
        body: "x".repeat(400),
      },
      {
        id: "rule-short",
        kind: "user_rule",
        origin: "user_explicit",
        sourceMark: "user_rule@v2",
        body: "keep tests",
      },
    ],
    tokenBudget: estimateSmallBudget(),
  });

  assert.equal("kind" in preview && preview.kind === "failure", false);

  if ("kind" in preview) {
    return;
  }

  assert.equal(preview.currentInstruction.includes("CURRENT_INSTRUCTION_MUST_STAY"), true);
  assert.equal(preview.currentInstructionPreserved, true);
  assert.equal(
    preview.trimmed.some((item) => item.id === "wf-long" && item.reason === "token_budget"),
    true,
  );
  assert.equal(
    preview.trimmed.some((item) => item.id === "CURRENT_INSTRUCTION_MUST_STAY"),
    false,
  );
});

test("hidden chain-of-thought cannot enter the preview", () => {
  const preview = renderProfilePreview({
    currentInstruction: { text: "do the task" },
    assets: [
      {
        id: "cot",
        kind: "skill",
        origin: "inferred",
        sourceMark: "hidden",
        body: "HIDDEN_COT: internal reasoning",
      },
    ],
    tokenBudget: 100,
  });

  assert.equal("kind" in preview, true);

  if ("kind" in preview) {
    assert.equal(preview.kind, "failure");
    if (preview.kind === "failure") {
      assert.equal(preview.code, "hidden_cot_rejected");
    }
  }
});

test("profile render is deterministic", () => {
  const input = {
    currentInstruction: { text: "do the task" },
    assets: [
      {
        id: "b",
        kind: "skill" as const,
        origin: "inferred" as const,
        sourceMark: "skill@v1",
        body: "steps",
      },
      {
        id: "a",
        kind: "prompt_patch" as const,
        origin: "inferred" as const,
        sourceMark: "prompt@v1",
        body: "role",
      },
    ],
    tokenBudget: 100,
  };
  const first = renderProfilePreview(input);
  const second = renderProfilePreview(input);

  assert.deepEqual(first, second);
});

function estimateSmallBudget(): number {
  return Math.ceil("CURRENT_INSTRUCTION_MUST_STAY".length / 4) + 8;
}
