import assert from "node:assert/strict";
import test from "node:test";
import { detectPromptPatch } from "../learning/agent/subsystems/method/legacy-prompt/detector.js";
import {
  attributeTwoPromptGains,
  type PromptGainEpisode,
} from "../learning/agent/subsystems/method/legacy-prompt/attribution.js";
import { buildUserRule } from "../learning/domains/user/builder.js";
import { classifyLearningShape } from "../learning/domains/shared/classify.js";
import { evaluateCandidate } from "./evaluator.js";
import { renderProfilePreview } from "./profile-preview.js";
import { qualityDeltaIgnoringLength } from "./goodhart.js";
import type { ExternalVerdict } from "../learning/domains/shared/types.js";

function episode(id: string, conversationId: string): PromptGainEpisode {
  const external = (result: ExternalVerdict["result"]): ExternalVerdict => ({
    kind: "independent_verifier",
    result,
    ref: `${id}-${result}`,
    selfGenerated: false,
  });
  return {
    id,
    conversationId,
    taskFamily: {
      id: "ts-unit-fix",
      intentClass: "fix_failing_unit_test",
      checkKind: "unit_test",
      language: "ts",
    },
    baselinePromptHash: "ph_base",
    candidatePromptHash: "ph_cand",
    candidatePatch: [
      {
        op: "replace_section",
        section: "phrasing",
        fromHash: "p1",
        toHash: "p2",
      },
    ],
    versions: {
      model: "m1",
      toolset: "t1",
      codeBaseline: "c1",
      workflow: "w1",
    },
    baselineExternal: external("fail"),
    candidateExternal: external("pass"),
    weakSignals: [],
    privacy: { rawUserTextStored: false, allowedFields: ["id"] },
  };
}

test("attack: two dissimilar tasks wrongly attributed", () => {
  const left = episode("a", "c1");
  const right: PromptGainEpisode = {
    ...episode("b", "c2"),
    taskFamily: {
      id: "docs",
      intentClass: "write_release_notes",
      checkKind: "acceptance",
    },
  };
  const result = attributeTwoPromptGains(left, right);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_attribution");
  }
});

test("attack: model and tool upgraded but credited to prompt", () => {
  const left = episode("a", "c1");
  const right: PromptGainEpisode = {
    ...episode("b", "c2"),
    versions: { model: "m2", toolset: "t2", codeBaseline: "c1", workflow: "w1" },
  };
  const result = attributeTwoPromptGains(left, right);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_attribution");
    assert.equal(result.confounders.includes("model"), true);
    assert.equal(result.confounders.includes("toolset"), true);
  }
});

test("attack: long output judged as high quality", () => {
  assert.equal(qualityDeltaIgnoringLength(true, true, 100000), 0);
});

test("attack: self-generated tests manufacture fake success", () => {
  const left = episode("a", "c1");
  const right: PromptGainEpisode = {
    ...episode("b", "c2"),
    candidateExternal: {
      kind: "test",
      result: "pass",
      ref: "gen-tests",
      selfGenerated: true,
    },
  };
  const result = attributeTwoPromptGains(left, right);

  assert.equal(result.kind, "failure");
});

test("attack: one user complaint generalized to a global rule", () => {
  const result = buildUserRule({
    text: "不要再这样，所有项目以后都改",
  });

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "scope_too_broad");
  }
});

test("attack: prompt patch smuggles permission and tool switch", () => {
  const detected = detectPromptPatch({
    episodes: [episode("a", "c1"), episode("b", "c2")],
    extraClaims: ["permission", "tool_install"],
  });

  assert.equal(detected.kind, "failure");

  if (detected.kind === "failure") {
    assert.equal(detected.code, "forbidden_payload");
  }
});

test("attack: one phrasing change upgraded to skill", () => {
  const classified = classifyLearningShape({
    explicitFutureDirective: false,
    phrasingOnly: true,
    multiStepWithChecks: false,
    processGraph: false,
  });
  assert.equal(classified.kind, "prompt_patch");
});

test("attack: evaluator self-approves generator output", () => {
  const bundle = evaluateCandidate({
    proposalId: "pp",
    baselineRef: "a",
    candidateRef: "b",
    generatorRoleId: "gen-1",
    evaluatorRoleId: "gen-1",
    baselineAnchors: [],
    candidateAnchors: [],
    weakSignals: [{ kind: "llm_self_score", note: "pass myself" }],
    costDelta: 0,
    latencyDelta: 0,
    outputLengthDelta: 50,
    criticalRegressionFailed: false,
    failureDiversity: 0,
    sampleSize: 2,
  });
  assert.equal(bundle.externalPass, false);
});

test("attack: token budget would drop the current user instruction", () => {
  const preview = renderProfilePreview({
    currentInstruction: { text: "KEEP_ME" },
    assets: [
      {
        id: "huge",
        kind: "workflow",
        origin: "inferred",
        sourceMark: "wf",
        body: "z".repeat(1000),
      },
    ],
    tokenBudget: 3,
  });
  if ("kind" in preview) {
    assert.fail("preview should succeed");
    return;
  }

  assert.equal(preview.currentInstruction, "KEEP_ME");
  assert.equal(preview.currentInstructionPreserved, true);
  assert.equal(preview.trimmed.some((item) => item.id === "huge"), true);
});

test("completed without verifier is not an external pass", () => {
  const bundle = evaluateCandidate({
    proposalId: "pp",
    baselineRef: "a",
    candidateRef: "b",
    generatorRoleId: "generator",
    evaluatorRoleId: "evaluator",
    baselineAnchors: [],
    candidateAnchors: [],
    weakSignals: [{ kind: "no_complaint", note: "turn completed" }],
    costDelta: 0,
    latencyDelta: 0,
    outputLengthDelta: 0,
    criticalRegressionFailed: false,
    failureDiversity: 0,
    sampleSize: 2,
  });

  assert.equal(bundle.externalPass, false);
  assert.equal(bundle.verdict, "no_external_pass");
});
