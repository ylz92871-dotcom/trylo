import { detectPromptPatch, type PromptDetectInput } from "../legacy-prompt/detector.js";
import { evaluatePromptPatchDraft } from "../../../../../evaluation/evaluator.js";
import { keepBest } from "../../../../../evaluation/keep-best.js";
import type { EvaluationRequest } from "../../../../../evaluation/types.js";
import type { EvaluationEvidenceDraft } from "../../../../../evaluation/types.js";
import type { KeepBestResult } from "../../../../../evaluation/types.js";
import type { PromptDetectResult } from "../legacy-prompt/detector.js";

export type PromptLearnPipelineResult = {
  readonly detected: PromptDetectResult;
  readonly evidence?: EvaluationEvidenceDraft;
  readonly keepBest?: KeepBestResult;
  readonly activationEligible: false;
};

export function proposeThenEvaluatePrompt(
  input: PromptDetectInput,
  request: EvaluationRequest,
): PromptLearnPipelineResult {
  const detected = detectPromptPatch(input);
  if (detected.kind !== "draft") {
    return { detected, activationEligible: false };
  }

  const evidence = evaluatePromptPatchDraft(detected.draft, request);

  return {
    detected,
    evidence,
    keepBest: keepBest(evidence),
    activationEligible: false,
  };
}
