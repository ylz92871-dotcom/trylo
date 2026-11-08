import type { ExternalVerdict } from "../learning/domains/shared/types.js";
import {
  allPassed,
  independentAnchors,
  multiMetricBlocked,
  qualityDeltaIgnoringLength,
} from "./goodhart.js";
import { wilsonInterval } from "./keep-best.js";
import type { PromptPatchDraft } from "../learning/agent/subsystems/method/legacy-prompt/builder.js";
import type {
  EvaluationEvidenceDraft,
  EvaluationRequest,
  EvaluationVerdict,
} from "./types.js";

export function evaluateCandidate(raw: EvaluationRequest): EvaluationEvidenceDraft {
  // A rubric score remains a weak signal; only independent anchors support a pass.
  const request: EvaluationRequest =
    raw.judgeRubricScore === undefined
      ? raw
      : {
          ...raw,
          weakSignals: [
            ...raw.weakSignals,
            {
              kind: "judge_rubric" as const,
              note: `rubric=${raw.judgeRubricScore}`,
            },
          ],
        };
  if (request.generatorRoleId === request.evaluatorRoleId) {
    return bundle(request, "no_external_pass", false, [
      "generator and evaluator role ids must differ",
    ]);
  }

  if (request.sampleSize < 2 || !Number.isFinite(request.sampleSize)) {
    return bundle(request, "insufficient_sample", false, ["sample size below two"]);
  }

  if (multiMetricBlocked({
    costDelta: request.costDelta,
    latencyDelta: request.latencyDelta,
    failureDiversity: request.failureDiversity,
  })) {
    return bundle(request, "reject", false, [
      "success cannot be the only optimized metric while cost and latency spike",
    ]);
  }

  if (request.criticalRegressionFailed) {
    return bundle(request, "critical_regression", false, [
      "candidate improved a primary metric but failed a critical regression",
    ]);
  }

  const candidateIndependent = independentAnchors(request.candidateAnchors);
  const baselineIndependent = independentAnchors(request.baselineAnchors);
  const onlyWeak =
    candidateIndependent.length === 0 &&
    request.weakSignals.length > 0;
  if (onlyWeak || candidateIndependent.length === 0) {
    return bundle(request, "no_external_pass", false, [
      "LLM self-score, length, tokens, or self-generated tests cannot fill externalPass",
    ]);
  }

  const candidatePass = allPassed(candidateIndependent);
  const baselinePass = allPassed(baselineIndependent);
  const successImproved = candidatePass && baselinePass === false;
  const qualityDelta = qualityDeltaIgnoringLength(
    baselinePass,
    candidatePass,
    request.outputLengthDelta,
  );

  if (candidatePass === false) {
    return bundle(request, "reject", false, ["candidate external anchors did not pass"], {
      successImproved,
      qualityDelta,
    });
  }

  if (successImproved === false && qualityDelta <= 0) {
    return bundle(request, "no_external_pass", false, ["no external improvement"], {
      successImproved,
      qualityDelta,
    });
  }

  return bundle(request, "recommend_shadow", true, ["external anchors support shadow, not activation"], {
    successImproved,
    qualityDelta,
  });
}

function bundle(
  request: EvaluationRequest,
  verdict: EvaluationVerdict,
  externalPass: boolean,
  notes: readonly string[],
  metrics?: { successImproved: boolean; qualityDelta: number },
): EvaluationEvidenceDraft {
  const independent = independentAnchors(request.candidateAnchors);
  const negativeCritique =
    verdict === "recommend_shadow"
      ? []
      : notes;

  return {
    proposalId: request.proposalId,
    baselineRef: request.baselineRef,
    candidateRef: request.candidateRef,
    replay: {
      baselineRef: request.baselineRef,
      candidateRef: request.candidateRef,
      compared: true,
    },
    externalAnchors: independent,
    weakSignals: request.weakSignals,
    negativeCritique,
    metrics: {
      successImproved: metrics?.successImproved ?? false,
      qualityDelta: metrics?.qualityDelta ?? 0,
      costDelta: request.costDelta,
      latencyDelta: request.latencyDelta,
      criticalRegression: request.criticalRegressionFailed,
      failureDiversity: request.failureDiversity,
      successRate:
        independent.filter((anchor) => anchor.result === "pass").length /
        Math.max(1, request.sampleSize),
    },
    verdict,
    externalPass,
    sampleConfidence: request.sampleSize >= 2 && Number.isFinite(request.sampleSize)
      ? "sufficient"
      : "insufficient",
    confidenceInterval: wilsonInterval(
      independent.filter((anchor) => anchor.result === "pass").length,
      Math.max(request.sampleSize, independent.length),
    ),
    generatorRoleId: request.generatorRoleId,
    evaluatorRoleId: request.evaluatorRoleId,
    notes,
    deterministicChecks: [
      "role_separation",
      "sample_size",
      "multi_metric",
      "critical_regression",
      "independent_external_anchors",
    ],
    shadowRecommended: verdict === "recommend_shadow",
    threshold: request.threshold ?? 2,
    commandKind: "submit_evidence",
  };
}

export function evaluatePromptPatchDraft(
  draft: PromptPatchDraft,
  request: EvaluationRequest,
): EvaluationEvidenceDraft {
  return evaluateCandidate({
    ...request,
    proposalId: draft.id,
    threshold: draft.threshold,
  });
}

export function evaluateInducedDraft(
  proposalId: string,
  request: EvaluationRequest,
): EvaluationEvidenceDraft {
  return evaluateCandidate({
    ...request,
    proposalId,
  });
}

export function createEvaluatorPort(): {
  readonly role: "evaluator";
  readonly evaluate: typeof evaluateCandidate;
} {
  return {
    role: "evaluator",
    evaluate: evaluateCandidate,
  };
}

export type { ExternalVerdict };
