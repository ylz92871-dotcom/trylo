import { extractSkillTask } from "./model-extraction.js";
import { selectSkillTask } from "./model-selection.js";
import { interpretSkillCorrection } from "./model-correction.js";
import type { SkillModelAllowance, SkillTaskCorrectionInput, SkillTaskExtractionInput, SkillTaskModelOptions, SkillTaskSelectionInput } from "./task-contract.js";

export type { SkillModelAllowance, SkillModelUsage, SkillTaskExtractionInput, SkillTaskExtractionResult,
  SkillTaskModelOptions, SkillTaskQualification, SkillTaskSelectionInput, SkillTaskSelectionResult,
  SkillTaskCorrectionInput, SkillTaskCorrectionResult } from "./task-contract.js";

/** Both entrypoints use the already resolved provider configuration, isolated per call. */
export function createSkillTaskModel(options: SkillTaskModelOptions) {
  return {
    extract: (input: SkillTaskExtractionInput, allowance: SkillModelAllowance, signal: AbortSignal) => extractSkillTask(options, input, allowance, signal),
    select: (input: SkillTaskSelectionInput, allowance: SkillModelAllowance, signal: AbortSignal) => selectSkillTask(options, input, allowance, signal),
    interpretCorrection: (input: SkillTaskCorrectionInput, allowance: SkillModelAllowance, signal: AbortSignal) => interpretSkillCorrection(options, input, allowance, signal),
  };
}
