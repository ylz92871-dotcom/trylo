import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { isCentralGenerationLimits, isCentralThinkMaxOutputTokens } from "../../learning/central/runtime/generation.js";
import { CENTRAL_LEARNING_RESOURCE_KEYS, MAX_CENTRAL_LEARNING_RESOURCE,
  isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { ProviderMessage, ProviderRequest } from "../../ports/provider.js";
import { fields, text } from "../../validation/json-shape.js";
import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";
import { CENTRAL_SINGLE_ACTION_TOOL_NAME } from "./change-single-action-tool.js";
import { CENTRAL_CHANGE_INPUT_VERSION, isCentralChangeInputVersion, usesCentralShortReferenceHandles,
  type CentralChangeExposure, type CentralChangeInputVersion, type CentralShortReferenceInputVersion } from "./change-input-contract.js";
import { CENTRAL_LEARNING_CHANGE_PROJECTION } from "./change-prompt.js";
import { centralLearningChangeSchema } from "./change-schema.js";
import { centralDeliberationReservation, decodeCentralDeliberation } from "./deliberation-prompt.js";
import { centralDecisionWireFields, compileCentralDecision, encodeCentralDeliberation, isCentralActionWireFormat,
  type CentralDeliberationWireFormat } from "./deliberation-encoding.js";

type LegacyOutputFormat = Extract<CentralDeliberationWireFormat, { readonly kind: "tool" | "structured" }>;

type ActionOutputFormat = Extract<CentralDeliberationWireFormat, { readonly kind: "action_json" | "action_tool" }>;

type FundingMessage = Pick<ProviderMessage, "role" | "content">;

/** Provider-neutral public decision-wire identity, not an HTTP-envelope hash.
 * The original request plus the frozen renderer version reconstructs the view
 * and dictionary. Only the small post-reservation message is stored again. */
interface CentralDeliberationWireEvidenceBody {
  readonly type: "central_deliberation_wire_evidence";
  readonly projectionVersion: typeof CENTRAL_LEARNING_CHANGE_PROJECTION;
  readonly inputVersion: CentralChangeInputVersion;
  readonly checkpoint: string;
  readonly requestHash: string;
  readonly dictionaryHash: string;
  readonly viewHash: string;
  readonly exposure: readonly CentralChangeExposure[];
  readonly messagesHash: string;
  readonly toolsHash: string;
  readonly responseSchemaHash: string | null;
  /** Actual sender setting, distinct from reserved total maxTokens; no total-billing guarantee. */
  readonly maxOutputTokens: number;
  readonly outputHash: string;
  readonly fundingMessage: FundingMessage;
  /** Validated public decision declaration; never a provider envelope or reasoning. */
  readonly rawChange: unknown;
}

/** v1 preserves tool/schema and v2 preserves the original JSON encoder. v3
 * freezes the single-action representation together with its actual public input version. */
export type CentralDeliberationWireEvidence = CentralDeliberationWireEvidenceBody & (
  { readonly schemaVersion: 1; readonly format: LegacyOutputFormat }
  | { readonly schemaVersion: 2; readonly inputVersion: CentralShortReferenceInputVersion;
    readonly format: { readonly kind: "json_object" }; readonly responseFormatHash: string; readonly wireHash: string }
  | { readonly schemaVersion: 3; readonly inputVersion: CentralShortReferenceInputVersion;
    readonly format: Extract<ActionOutputFormat, { readonly kind: "action_json" }>; readonly responseFormatHash: string; readonly wireHash: string }
  | { readonly schemaVersion: 3; readonly inputVersion: CentralShortReferenceInputVersion;
    readonly format: Extract<ActionOutputFormat, { readonly kind: "action_tool" }>; readonly responseFormatHash: null; readonly wireHash: string }
);

export interface CentralDeliberationWireEvidenceInput {
  readonly request: CentralDeliberationRequest;
  readonly output: CentralDeliberationOutput;
  readonly rawChange: unknown;
  /** Explicit frozen live-capture identity; absence retains historical format detection. */
  readonly format?: ActionOutputFormat;
  readonly wire: Pick<ProviderRequest, "messages" | "tools" | "responseSchema" | "responseFormat" | "maxOutputTokens">;
}

const maximum = MAX_CENTRAL_LEARNING_RESOURCE;
const outputMaximum = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= 1 && value <= maximum;

function fundingMessage(value: unknown, request: CentralDeliberationRequest): value is FundingMessage {
  if (!fields(value, ["role", "content"]) || value.role !== "user"
    || !text(value.content, CENTRAL_RUNTIME_LIMITS.textChars + 4096)) return false;

  let body: unknown;

  try { body = JSON.parse(value.content); }
  catch { return false; } // An unparseable public envelope has no replayable wire identity.

  if (!fields(body, ["role", "budgetId", "limits", "occupied", "available", "status", "holdReason", "thisComputation", "interpretation"])
    || body.role !== "host_original_root_after_this_computation_reservation" || body.budgetId !== request.budgetId
    || !isCentralLearningResources(body.limits) || !isCentralLearningResources(body.occupied)
    || !fields(body.available, ["tokens", "calls", "steps"])
    || !Object.values(body.available).every(item => typeof item === "number" && Number.isSafeInteger(item) && Math.abs(item) <= maximum)
    || !["available", "exhausted", "held"].includes(String(body.status))
    || !(body.holdReason === null || typeof body.holdReason === "string" && body.holdReason.length <= CENTRAL_RUNTIME_LIMITS.textChars)
    || !fields(body.thisComputation, ["reservationId", "maxTokens", "calls", "steps"])
    || body.thisComputation.reservationId !== centralDeliberationReservation(request)
    || typeof body.thisComputation.maxTokens !== "number" || !Number.isSafeInteger(body.thisComputation.maxTokens)
    || body.thisComputation.maxTokens < 1 || body.thisComputation.maxTokens > maximum
    || body.thisComputation.calls !== 1 || body.thisComputation.steps !== 1
    || body.interpretation !== "current_root_resources_not_new_authorization_or_value_prediction") return false;

  // These are the original projection's arithmetic and the current pending
  // reservation's minimum occupancy. They reject synthetic quote ceilings and
  // pre-reservation balances without pretending to independently attest funding.
  const available = body.available, limits = body.limits, occupied = body.occupied;

  return CENTRAL_LEARNING_RESOURCE_KEYS.every(key => available[key] === limits[key] - occupied[key])
    && body.thisComputation.maxTokens <= body.limits.tokens && body.occupied.tokens >= body.thisComputation.maxTokens
    && body.occupied.calls >= 1 && body.occupied.steps >= 1 && canonicalJson(body) === value.content;
}

function jsonWire(wire: CentralDeliberationWireEvidenceInput["wire"]): boolean {
  return Object.hasOwn(wire, "responseFormat") && fields(wire.responseFormat, ["type"]) && wire.responseFormat.type === "json_object"
    && Array.isArray(wire.tools) && wire.tools.length === 0 && !Object.hasOwn(wire, "responseSchema") && wire.responseSchema === undefined;
}

function actionWire(wire: CentralDeliberationWireEvidenceInput["wire"], format: ActionOutputFormat): boolean {
  if (format.kind === "action_json") return jsonWire(wire);
  const tool = wire.tools[0];
  return !Object.hasOwn(wire, "responseFormat") && wire.responseFormat === undefined
    && !Object.hasOwn(wire, "responseSchema") && wire.responseSchema === undefined
    && Array.isArray(wire.tools) && wire.tools.length === 1 && fields(tool, ["name", "description", "parameters"])
    && tool.name === CENTRAL_SINGLE_ACTION_TOOL_NAME && tool.description === format.description;
}

function wireHash(wire: CentralDeliberationWireEvidenceInput["wire"], maxOutputTokens: number): string {
  return contentHashOf({ ...centralDecisionWireFields(wire), maxOutputTokens });
}

function outputFormat(wire: CentralDeliberationWireEvidenceInput["wire"], request: CentralDeliberationRequest): CentralDeliberationWireFormat | undefined {
  if (Object.hasOwn(wire, "responseFormat")) return jsonWire(wire) ? { kind: "json_object" } : undefined;

  // A newly formatted request cannot be downgraded to a v1 proof that never
  // hashed that field, including an inherited defined format.
  if (wire.responseFormat !== undefined) return undefined;

  const schema = centralLearningChangeSchema(request);
  if (wire.tools.length === 0 && canonicalJson(wire.responseSchema) === canonicalJson(schema)) return { kind: "structured" };

  const tool = wire.tools[0];
  if (wire.tools.length !== 1 || wire.responseSchema !== undefined || !fields(tool, ["name", "description", "parameters"])
    || tool.name !== CENTRAL_LEARNING_CHANGE_TOOL || !text(tool.description, CENTRAL_RUNTIME_LIMITS.textChars)
    || canonicalJson(tool.parameters) !== canonicalJson(schema)) return undefined;

  return { kind: "tool", description: tool.description };
}

function formatValid(value: unknown): value is LegacyOutputFormat {
  return fields(value, ["kind"]) && value.kind === "structured"
    || fields(value, ["kind", "description"]) && value.kind === "tool" && text(value.description, CENTRAL_RUNTIME_LIMITS.textChars);
}

function generationMatches(request: CentralDeliberationRequest, maxOutputTokens: number, inputVersion: CentralChangeInputVersion): boolean {
  if (!usesCentralShortReferenceHandles(inputVersion)) return true;

  const limits = request.configuration.generationLimits;
  const chosen = request.operation.kind === "think" ? request.operation.maxOutputTokens : undefined;
  if (chosen !== undefined) return isCentralGenerationLimits(limits) && isCentralThinkMaxOutputTokens(chosen)
    && chosen <= limits.maxOutputTokens && maxOutputTokens === chosen;

  // Legacy callers without advertised capabilities keep their actual stored
  // sender setting. Never reconstruct old absence from today's default.
  return limits === undefined || maxOutputTokens === limits.defaultMaxOutputTokens;
}

function reconstruct(request: CentralDeliberationRequest, output: CentralDeliberationOutput, rawChange: unknown,
  format: CentralDeliberationWireFormat, funding: FundingMessage, maxOutputTokens: number,
  inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): CentralDeliberationWireEvidence | undefined {
  if (!fundingMessage(funding, request) || !generationMatches(request, maxOutputTokens, inputVersion)) return undefined;

  if ((format.kind === "json_object" || format.kind === "action_json" || format.kind === "action_tool")
    && !usesCentralShortReferenceHandles(inputVersion)) return undefined;

  const input = encodeCentralDeliberation(request, format, [], inputVersion);
  const expanded = decodeCentralDeliberation(compileCentralDecision(rawChange, request, input.dictionary, format, inputVersion), request, [], inputVersion);
  if (canonicalJson(expanded) !== canonicalJson(output)) return undefined;

  const wire = { ...input.wire, messages: [...input.messages, funding] };
  const body: CentralDeliberationWireEvidenceBody = { type: "central_deliberation_wire_evidence", projectionVersion: CENTRAL_LEARNING_CHANGE_PROJECTION,
    inputVersion, checkpoint: input.checkpoint, requestHash: contentHashOf(request),
    dictionaryHash: contentHashOf({ checkpoint: input.dictionary.checkpoint, entries: input.dictionary.entries }),
    viewHash: contentHashOf(input.view), exposure: input.exposure, messagesHash: contentHashOf([...input.messages, funding]),
    toolsHash: contentHashOf(wire.tools), responseSchemaHash: wire.responseSchema === undefined ? null : contentHashOf(wire.responseSchema), maxOutputTokens,
    outputHash: contentHashOf(output), fundingMessage: funding, rawChange };

  if (format.kind === "tool" || format.kind === "structured") return { ...body, schemaVersion: 1, format };

  if (!usesCentralShortReferenceHandles(inputVersion)) return undefined;

  if (format.kind === "action_tool") {
    if (!actionWire(wire, format)) return undefined;
    return { ...body, schemaVersion: 3, inputVersion, format,
      responseFormatHash: null, wireHash: wireHash(wire, maxOutputTokens) };
  }

  if (!jsonWire(wire)) return undefined;

  if (format.kind === "action_json") return { ...body, schemaVersion: 3, inputVersion, format,
    responseFormatHash: contentHashOf(wire.responseFormat), wireHash: wireHash(wire, maxOutputTokens) };

  return { ...body, schemaVersion: 2, inputVersion, format,
    responseFormatHash: contentHashOf(wire.responseFormat), wireHash: wireHash(wire, maxOutputTokens) };
}

/** Undefined is a closed validation failure. Actual wire is compared before its
 * bodies are discarded; quote/pre-reservation messages cannot pass this seam. */
export function buildCentralDeliberationWireEvidence(input: CentralDeliberationWireEvidenceInput): CentralDeliberationWireEvidence | undefined {
  try {
    const format = Object.hasOwn(input, "format")
      ? isCentralActionWireFormat(input.format) && actionWire(input.wire, input.format) ? input.format : undefined
      : input.format === undefined ? outputFormat(input.wire, input.request) : undefined;
    const funding = input.wire.messages.at(-1);
    if (format === undefined || !fundingMessage(funding, input.request) || !outputMaximum(input.wire.maxOutputTokens)) return undefined;

    const proof = reconstruct(input.request, input.output, input.rawChange, format, funding, input.wire.maxOutputTokens);
    const matches = proof !== undefined && proof.messagesHash === contentHashOf(input.wire.messages)
      && proof.toolsHash === contentHashOf(input.wire.tools)
      && proof.responseSchemaHash === (input.wire.responseSchema === undefined ? null : contentHashOf(input.wire.responseSchema))
      && (proof.schemaVersion === 1 || proof.responseFormatHash === (input.wire.responseFormat === undefined ? null : contentHashOf(input.wire.responseFormat))
        && proof.wireHash === wireHash(input.wire, input.wire.maxOutputTokens));

    return matches ? proof : undefined;
  } catch { return undefined; } // Malformed public changes/handles/rendering have no successful delivery proof.
}

/** Rebuild from immutable original inputs, never today's funding or a caller's
 * serialized handle table. Legacy deliveries do not call this validator. */
export function isCentralDeliberationWireEvidence(value: unknown, request: CentralDeliberationRequest,
  output: CentralDeliberationOutput): value is CentralDeliberationWireEvidence {
  const json = typeof value === "object" && value !== null && "schemaVersion" in value && (value.schemaVersion === 2 || value.schemaVersion === 3);
  if (!fields(value, ["schemaVersion", "type", "projectionVersion", "inputVersion", "checkpoint", "requestHash", "dictionaryHash",
    "viewHash", "exposure", "messagesHash", "toolsHash", "responseSchemaHash", "maxOutputTokens", "outputHash", "format", "fundingMessage", "rawChange",
    ...(json ? ["responseFormatHash", "wireHash"] : [])])
    || value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 || value.type !== "central_deliberation_wire_evidence"
    || value.projectionVersion !== CENTRAL_LEARNING_CHANGE_PROJECTION
    || !isCentralChangeInputVersion(value.inputVersion)
    || !fundingMessage(value.fundingMessage, request) || !outputMaximum(value.maxOutputTokens)) return false;

  let format: CentralDeliberationWireFormat;

  if (value.schemaVersion === 3) {
    if (!usesCentralShortReferenceHandles(value.inputVersion) || !isCentralActionWireFormat(value.format)
      || (value.format.kind === "action_tool" ? value.responseFormatHash !== null : typeof value.responseFormatHash !== "string")) return false;
    format = value.format;
  } else if (json) {
    if (!usesCentralShortReferenceHandles(value.inputVersion) || !fields(value.format, ["kind"]) || value.format.kind !== "json_object") return false;
    format = { kind: "json_object" };
  } else {
    if (!formatValid(value.format)) return false;
    format = value.format;
  }

  try {
    const expected = reconstruct(request, output, value.rawChange, format, value.fundingMessage, value.maxOutputTokens, value.inputVersion);
    return expected !== undefined && canonicalJson(expected) === canonicalJson(value);
  } catch { return false; } // Invalid historical bindings fail closed; they never fall back to a legacy exposure claim.
}
