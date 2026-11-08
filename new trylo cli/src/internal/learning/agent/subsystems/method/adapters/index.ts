/** Host-facing composition and Board adapters; domain modules never import this entry. */
export {
  LEARNING_SWITCH_METHOD,
  isMethodLearning,
  wireMethodLearning,
  type MethodLearningSwitch,
  type MethodWiringInput,
} from "./wiring.js";
export {
  METHOD_ASSET_KIND,
  METHOD_DOMAIN,
  createMethodBoardWriter,
  type MethodBoardWriterOptions,
} from "./board-writer.js";
export { mapPromptPatchDraft } from "./content/prompt-patch.js";
export { createExperienceTools } from "./experience-tools.js";
export { createExperienceModel, ExperienceModelError } from "./experience-model.js";
export { createExperienceFunding } from "./experience-funding.js";
export { createMethodFocusedLearning } from "./focused-learning.js";
export { createMethodCentralLearning } from "./central-learning.js";
export { readMethodCentralFeedback, methodCentralFeedbackFromBoard } from "./central-history.js";
export { methodFocusedTarget } from "./central-source.js";
export { readCentralMethodResearchStageProduction, createCentralMethodResearchProductionReader,
  type CentralMethodResearchStageProduction } from "./central-research-production.js";
