import type { CentralLearningGrantAllowance } from "../../learning/control/coordination-contract.js";
import type { LearningAllocationOffer } from "../../learning/control/allocation-contract.js";
import { isCentralLearningGrantAllowance } from "../../learning/control/coordination-parse.js";

export function runtimeAllowanceWithin(value: CentralLearningGrantAllowance, ceiling: CentralLearningGrantAllowance) {
  return isCentralLearningGrantAllowance(value) && isCentralLearningGrantAllowance(ceiling)
    && value.maxTokens <= ceiling.maxTokens && value.maxCalls <= ceiling.maxCalls
    && value.maxSteps <= ceiling.maxSteps && value.maxPromptChars <= ceiling.maxPromptChars;
}

export function runtimeStageIsFree(offer: LearningAllocationOffer) {
  return offer.reserve.tokens === 0 && offer.reserve.calls === 0 && offer.reserve.steps === 0;
}
