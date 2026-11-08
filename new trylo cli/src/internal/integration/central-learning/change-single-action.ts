import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_CHANGE_INPUT_VERSION, type CentralChangeInput } from "./change-input-contract.js";

export { CENTRAL_SINGLE_ACTION_VERSION } from "./change-single-action-version.js";

import { createCentralLearningChangeView } from "./change-prompt.js";
import { centralSingleActionMessages } from "./change-single-action-page.js";

/** Current public input and decision grammar. Historical encoders select their
 * explicit input version and continue to use their original factory. */
export function createCentralSingleActionInput(request: CentralDeliberationRequest,
  secrets: readonly string[] = []): CentralChangeInput {
  const input = createCentralLearningChangeView(request, secrets, CENTRAL_CHANGE_INPUT_VERSION);
  return Object.freeze({ ...input, messages: centralSingleActionMessages(request, input) });
}

export { centralSingleActionMessages } from "./change-single-action-page.js";
export { expandCentralSingleAction } from "./change-single-action-expand.js";
