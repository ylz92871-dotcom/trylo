import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ProviderMessage } from "../../ports/provider.js";
import type { CentralChangeInput, CentralChangeInputDictionary } from "./change-input-contract.js";
import { CENTRAL_SINGLE_ACTION_TOOL_NAME } from "./change-single-action-tool-contract.js";

export { CENTRAL_SINGLE_ACTION_TOOL_NAME, CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION } from "./change-single-action-tool-contract.js";

import { centralSingleActionMessages } from "./change-single-action-page.js";
import { centralSingleActionGrammar } from "./change-single-action-grammar.js";
import { centralSingleActionGrammar as v3Grammar } from "./change-single-action-grammar-v3.js";
import { centralSingleActionGrammar as v4Grammar } from "./change-single-action-grammar-v4.js";
import { centralSingleActionGrammar as v5Grammar } from "./change-single-action-grammar-v5.js";
import { centralSingleActionLegacyToolSchema } from "./change-single-action-tool-legacy.js";
import { CENTRAL_SINGLE_ACTION_VERSION, CENTRAL_SINGLE_ACTION_LEGACY_VERSION, CENTRAL_SINGLE_ACTION_V2_VERSION, CENTRAL_SINGLE_ACTION_V3_VERSION, CENTRAL_SINGLE_ACTION_V4_VERSION, CENTRAL_SINGLE_ACTION_V5_VERSION, CENTRAL_SINGLE_ACTION_V6_VERSION, CENTRAL_SINGLE_ACTION_V7_VERSION, CENTRAL_SINGLE_ACTION_V8_VERSION, hasCentralDecisionEnvelope,
  type CentralSingleActionVersion } from "./change-single-action-version.js";
import { CentralDeliberationError } from "./deliberation-contract.js";

/** Versioned non-strict advert. Old tool proof bytes never inherit a new grammar;
 * provider capability selection and the original compiler still own admission. */
export function centralSingleActionToolSchema(request: CentralDeliberationRequest, dictionary: CentralChangeInputDictionary,
  representationVersion: CentralSingleActionVersion = CENTRAL_SINGLE_ACTION_VERSION): JsonObject {
  if (representationVersion === CENTRAL_SINGLE_ACTION_LEGACY_VERSION || representationVersion === CENTRAL_SINGLE_ACTION_V2_VERSION) {
    return centralSingleActionLegacyToolSchema(request, dictionary);
  }

  if (representationVersion === CENTRAL_SINGLE_ACTION_V3_VERSION) return v3Grammar(request, dictionary).schema;

  if (representationVersion === CENTRAL_SINGLE_ACTION_V4_VERSION) return v4Grammar(request, dictionary).schema;

  if (representationVersion === CENTRAL_SINGLE_ACTION_V5_VERSION) return v5Grammar(request, dictionary).schema;

  if (representationVersion !== CENTRAL_SINGLE_ACTION_VERSION && representationVersion !== CENTRAL_SINGLE_ACTION_V6_VERSION
    && representationVersion !== CENTRAL_SINGLE_ACTION_V7_VERSION && representationVersion !== CENTRAL_SINGLE_ACTION_V8_VERSION) {
    throw new CentralDeliberationError("central_single_action_version_unsupported", "not_sent");
  }

  const schema = centralSingleActionGrammar(request, dictionary).schema;

  if (!hasCentralDecisionEnvelope(representationVersion)) return schema;

  const decision = representationVersion === CENTRAL_SINGLE_ACTION_V8_VERSION ? { anyOf: schema.anyOf! }
    : { type: "object", description: "One Decision object, never a string or JSON-encoded text. Choose one action or advanced-delta branch below.", anyOf: schema.anyOf! };

  return { type: "object", properties: { decision }, required: ["decision"],
    additionalProperties: false, definitions: schema.definitions! };
}

/** Only the submission channel differs from the same version's JSON page. */
export function centralSingleActionToolMessages(request: CentralDeliberationRequest,
  input: CentralChangeInput, representationVersion: CentralSingleActionVersion = CENTRAL_SINGLE_ACTION_VERSION): readonly ProviderMessage[] {
  const messages = centralSingleActionMessages(request, input, representationVersion);
  return messages.map((message, index) => index === 0 ? { ...message,
    content: `${message.content}\nFor this connection, JSON means the arguments of ${CENTRAL_SINGLE_ACTION_TOOL_NAME}. Submit the decision through that sole function, not assistant prose. It records a learning decision; it executes no business operation.` } : message);
}
