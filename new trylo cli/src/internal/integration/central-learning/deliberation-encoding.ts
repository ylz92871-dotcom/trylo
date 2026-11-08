import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { ProviderRequest } from "../../ports/provider.js";
import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";
import { CENTRAL_CHANGE_INPUT_VERSION, usesCentralShortReferenceHandles, type CentralChangeInputVersion } from "./change-input-contract.js";
import { centralContentDecisionMessages } from "./change-content-guide.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { centralLearningChangeSchema } from "./change-schema.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { CENTRAL_SINGLE_ACTION_VERSION, centralSingleActionMessages, expandCentralSingleAction } from "./change-single-action.js";
import { isCentralSingleActionVersion, hasCentralDecisionEnvelope, hasCentralSingleActionHandoff, type CentralSingleActionVersion } from "./change-single-action-version.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { compileCentralSingleActionV6, expandCentralSingleActionV6Base } from "./change-single-action-handoff.js";
import { fields, text } from "../../validation/json-shape.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { CENTRAL_SINGLE_ACTION_TOOL_NAME, CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION,
  centralSingleActionToolMessages, centralSingleActionToolSchema } from "./change-single-action-tool.js";

export type CentralDeliberationWireFormat = { readonly kind: "tool"; readonly description: string }
  | { readonly kind: "structured" } | { readonly kind: "json_object" }
  | { readonly kind: "action_json"; readonly representationVersion: CentralSingleActionVersion }
  | { readonly kind: "action_tool"; readonly representationVersion: CentralSingleActionVersion; readonly description: string };

export const CENTRAL_ACTION_JSON_FORMAT = { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_VERSION } as const;
export const CENTRAL_ACTION_TOOL_FORMAT = { kind: "action_tool", representationVersion: CENTRAL_SINGLE_ACTION_VERSION,
  description: CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION } as const;

export function isCentralActionJsonWireFormat(value: unknown): value is Extract<CentralDeliberationWireFormat, { readonly kind: "action_json" }> {
  return fields(value, ["kind", "representationVersion"]) && value.kind === "action_json"
    && isCentralSingleActionVersion(value.representationVersion);
}

export function isCentralActionToolWireFormat(value: unknown): value is Extract<CentralDeliberationWireFormat, { readonly kind: "action_tool" }> {
  return fields(value, ["kind", "representationVersion", "description"]) && value.kind === "action_tool"
    && isCentralSingleActionVersion(value.representationVersion) && text(value.description, CENTRAL_RUNTIME_LIMITS.textChars);
}

export function isCentralActionWireFormat(value: unknown): value is Extract<CentralDeliberationWireFormat, { readonly kind: "action_json" | "action_tool" }> {
  return isCentralActionJsonWireFormat(value) || isCentralActionToolWireFormat(value);
}

export const CENTRAL_CHANGE_TOOL_FORMAT = { kind: "tool", description:
  "Submit this call's public learning changes. This returns a decision; it executes no tool." } as const;

export type CentralDecisionWire = Pick<ProviderRequest, "messages" | "tools" | "responseSchema" | "responseFormat">;

/** One encoder for quotation, sending and immutable receipt reconstruction.
 * The input version fixes the public DTO and source projection; JSON wire is separately
 * frozen by proof v2 for canonical JSON and v3 for the single-action page.
 * Historical tool/schema formats retain their old bytes. */
export function encodeCentralDeliberation(request: CentralDeliberationRequest, format: CentralDeliberationWireFormat,
  secrets: readonly string[] = [], inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION) {
  const input = createCentralLearningChangeView(request, secrets, inputVersion);
  let wire: CentralDecisionWire;

  if (format.kind === "action_json") {
    if (!usesCentralShortReferenceHandles(inputVersion) || !isCentralActionJsonWireFormat(format)) {
      throw new CentralDeliberationError("central_deliberation_output_capability_unavailable");
    }
    wire = { messages: centralSingleActionMessages(request, input, format.representationVersion), tools: [], responseFormat: { type: "json_object" } };
  } else if (format.kind === "action_tool") {
    if (!usesCentralShortReferenceHandles(inputVersion) || !isCentralActionToolWireFormat(format)) {
      throw new CentralDeliberationError("central_deliberation_output_capability_unavailable");
    }
    wire = { messages: centralSingleActionToolMessages(request, input, format.representationVersion), tools: [{ name: CENTRAL_SINGLE_ACTION_TOOL_NAME,
      description: format.description, parameters: centralSingleActionToolSchema(request, input.dictionary, format.representationVersion) }] };
  } else if (format.kind === "json_object") {
    if (!usesCentralShortReferenceHandles(inputVersion)) throw new CentralDeliberationError("central_deliberation_output_capability_unavailable");
    wire = { messages: centralContentDecisionMessages(request, input), tools: [], responseFormat: { type: "json_object" } };
  } else {
    const schema = centralLearningChangeSchema(request, input.dictionary, inputVersion);
    wire = format.kind === "structured" ? { messages: input.messages, tools: [], responseSchema: schema }
      : { messages: input.messages, tools: [{ name: CENTRAL_LEARNING_CHANGE_TOOL, description: format.description, parameters: schema }] };
  }

  return { ...input, messages: wire.messages, wire };
}

/** Expansion belongs to the selected public representation. Historical v1/v2/v3
 * values always enter the original compiler unchanged. */
export function compileCentralDecision(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary, format: CentralDeliberationWireFormat,
  inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION) {
  if ((format.kind === "action_json" || format.kind === "action_tool")
    && (!usesCentralShortReferenceHandles(inputVersion) || !isCentralActionWireFormat(format))) {
    throw new CentralDeliberationError("central_deliberation_output_capability_unavailable");
  }

  const v6 = (format.kind === "action_json" || format.kind === "action_tool") && hasCentralSingleActionHandoff(format.representationVersion);

  value = centralDecisionBody(value, format);
  const canonical = format.kind === "action_json" || format.kind === "action_tool"
    ? v6 ? value : expandCentralSingleAction(value, request, dictionary, format.representationVersion) : value;
  const output = v6 ? compileCentralSingleActionV6(canonical, request, dictionary, inputVersion)
    : compileCentralLearningChange(canonical, request, dictionary, inputVersion);
  if ((format.kind === "action_json" || format.kind === "action_tool")
    && (format.representationVersion === "central-learning-single-action-v5" || v6)
    && canonicalJson(output).length > CENTRAL_RUNTIME_LIMITS.jsonChars) {
    throw new CentralDeliberationError("central_learning_change_invalid", "returned", undefined, undefined, undefined, undefined, undefined,
      { schemaVersion: 1, stage: "shape", field: "", expected: "object", actual: "object", cause: "length" });
  }

  return output;
}

/** Used by both admission and authenticated historical continuation inspection. */
function centralDecisionBody(value: unknown, format: CentralDeliberationWireFormat): unknown {
  if ((format.kind === "action_json" || format.kind === "action_tool") && hasCentralDecisionEnvelope(format.representationVersion)
    && typeof value === "object" && value !== null && Object.hasOwn(value, "decision")) {
    if (!fields(value, ["decision"])) throw new CentralDeliberationError("central_learning_change_invalid", "returned");
    return value.decision;
  }
  return value;
}

/** Expand exactly the proof's frozen decision dialect, without applying its handoff. */
export function expandCentralDecisionBase(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary, format: CentralDeliberationWireFormat): unknown {
  if (format.kind !== "action_json" && format.kind !== "action_tool") return value;
  const body = centralDecisionBody(value, format);
  return hasCentralSingleActionHandoff(format.representationVersion) ? expandCentralSingleActionV6Base(body, request, dictionary)
    : expandCentralSingleAction(body, request, dictionary, format.representationVersion);
}

/** Preserve field presence. A format tag never supplies a missing actual wire
 * field, and legacy wire hashes never inherit today's response format. */
export function centralDecisionWireFields(wire: CentralDecisionWire) {
  return { messages: wire.messages, tools: wire.tools,
    ...(wire.responseSchema === undefined ? {} : { responseSchema: wire.responseSchema }),
    ...(wire.responseFormat === undefined ? {} : { responseFormat: wire.responseFormat }) };
}
