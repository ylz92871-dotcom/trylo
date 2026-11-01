import type { JsonObject, JsonValue } from "../../../../protocol/envelope.js";
import type { ToolRuntimeDescriptor } from "../../../../tooling/contract/descriptor.js";
import { err, ok } from "../../../../tooling/contract/result.js";
import { CRYSTAL_MIN_SUCCESSES } from "../awareness/constants.js";
import {
  TOOL_EVOLUTION_MAX_ATTEMPTS,
  TOOL_EVOLUTION_MAX_CANDIDATE_BYTES,
  TOOL_EVOLUTION_MAX_JSON_DEPTH,
  TOOL_EVOLUTION_MAX_MASTERY_ITEMS,
  TOOL_EVOLUTION_MAX_MASTERY_ITEM_CHARS,
  TOOL_EVOLUTION_MAX_REQUEST_BYTES,
  TOOL_EVOLUTION_MAX_SAMPLE_BYTES,
  TOOL_EVOLUTION_MAX_SAMPLES,
  TOOL_EVOLUTION_MAX_SOURCE_BYTES,
  TOOL_EVOLUTION_SCHEMA_VERSION,
  type ToolEvolutionCandidate,
  type ToolEvolutionExpected,
  type ToolEvolutionParseResult,
  type ToolEvolutionRequest,
  type ToolEvolutionSample,
} from "./contracts.js";

const REQUEST_KEYS = ["schemaVersion", "requestId", "scope", "capability", "operation", "evidence"];
const CANDIDATE_KEYS = ["identity", "description", "source", "inputSchema", "mastery"];
const DESCRIPTOR_KEYS = ["identity", "description", "inputSchema", "mastery"];
const ID_MAX_CHARS = 128;
const SCOPE_MAX_CHARS = 512;
const CAPABILITY_MAX_CHARS = 2048;
const DESCRIPTION_MAX_CHARS = 2048;

/** 输入是冻结验收合同；解析不采信额外授权字段，也不替调用方生成期望结果。 */
export function parseToolEvolutionRequest(input: unknown): ToolEvolutionParseResult<ToolEvolutionRequest> {
  if (!recordOf(input) || !isJsonValue(input)) return err("invalid_request", "request must be finite, bounded-depth JSON");
  if (jsonBytes(input) > TOOL_EVOLUTION_MAX_REQUEST_BYTES) return err("payload_too_large", "request exceeds byte budget");
  if (input.schemaVersion !== TOOL_EVOLUTION_SCHEMA_VERSION) return err("unsupported_version", "unsupported tool evolution schemaVersion");
  if (!keysAre(input, REQUEST_KEYS, ["prior", "maxAttempts"]) || !textOf(input.requestId, ID_MAX_CHARS)
    || !textOf(input.scope, SCOPE_MAX_CHARS) || !textOf(input.capability, CAPABILITY_MAX_CHARS)
    || (input.operation !== "create" && input.operation !== "improve")) {
    return err("invalid_request", "request fields are invalid or contain unsupported keys");
  }
  const evidence = parseSamples(input.evidence);
  if (!evidence.ok) return evidence;
  const prior = parsePrior(input.prior, input.operation);
  if (!prior.ok) return prior;
  const maxAttempts = input.maxAttempts;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || typeof maxAttempts !== "number"
    || maxAttempts < 1 || maxAttempts > TOOL_EVOLUTION_MAX_ATTEMPTS)) {
    return err("invalid_attempts", "maxAttempts must be an integer within the experiment budget");
  }
  return ok({
    schemaVersion: TOOL_EVOLUTION_SCHEMA_VERSION,
    requestId: input.requestId, scope: input.scope, capability: input.capability, operation: input.operation,
    evidence: evidence.value,
    ...(prior.value === undefined ? {} : { prior: prior.value }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

function parseSamples(input: unknown): ToolEvolutionParseResult<readonly ToolEvolutionSample[]> {
  if (!Array.isArray(input)) return err("invalid_samples", "evidence must be an array");
  if (input.length > TOOL_EVOLUTION_MAX_SAMPLES) return err("payload_too_large", "too many evidence samples");
  const samples: ToolEvolutionSample[] = [];
  const ids = new Set<string>();
  for (const value of input) {
    const sample = parseSample(value);
    if (!sample.ok) return sample;
    if (ids.has(sample.value.sampleId)) return err("duplicate_sample_id", "sampleId must be unique");
    ids.add(sample.value.sampleId);
    samples.push(sample.value);
  }
  const sources = samples.filter(sample => sample.role === "source");
  if (sources.length < CRYSTAL_MIN_SUCCESSES || !samples.some(sample => sample.role === "variation")
    || !samples.some(sample => sample.role === "counterexample")) {
    return err("insufficient_samples", "evidence requires two source successes, a variation and a counterexample");
  }
  return ok(samples);
}

function parseSample(input: unknown): ToolEvolutionParseResult<ToolEvolutionSample> {
  if (!recordOf(input) || !keysAre(input, ["sampleId", "role", "input", "expected"])
    || !textOf(input.sampleId, ID_MAX_CHARS) || !isSampleRole(input.role) || !isJsonValue(input.input)) {
    return err("invalid_samples", "sample fields are invalid");
  }
  const expected = parseExpected(input.expected);
  if (!expected.ok) return expected;
  if (input.role === "source" && expected.value.kind !== "value") {
    return err("invalid_samples", "source samples must record a successful value");
  }
  if (jsonBytes(input) > TOOL_EVOLUTION_MAX_SAMPLE_BYTES) return err("payload_too_large", "sample exceeds byte budget");
  return ok({ sampleId: input.sampleId, role: input.role, input: structuredClone(input.input), expected: expected.value });
}

function parseExpected(input: unknown): ToolEvolutionParseResult<ToolEvolutionExpected> {
  if (!recordOf(input)) return err("invalid_samples", "expected must be an object");
  if (input.kind === "value" && keysAre(input, ["kind", "value"]) && isJsonValue(input.value)) {
    return ok({ kind: "value", value: structuredClone(input.value) });
  }
  if (input.kind === "error" && keysAre(input, ["kind", "code"]) && textOf(input.code, ID_MAX_CHARS)) {
    return ok({ kind: "error", code: input.code });
  }
  return err("invalid_samples", "expected must be exactly a JSON value or an error code");
}

function parsePrior(input: unknown, operation: ToolEvolutionRequest["operation"]): ToolEvolutionParseResult<ToolEvolutionRequest["prior"]> {
  if (input === undefined) return operation === "create" ? ok(undefined) : err("invalid_prior", "improve requires a prior version and source");
  if (!recordOf(input) || !keysAre(input, ["versionId", "source"]) || !textOf(input.versionId, ID_MAX_CHARS) || !textOf(input.source)) {
    return err("invalid_prior", "prior must contain the exact versionId and source");
  }
  if (byteLength(input.source) > TOOL_EVOLUTION_MAX_SOURCE_BYTES) return err("payload_too_large", "prior source exceeds byte budget");
  return ok({ versionId: input.versionId, source: input.source });
}

/** 只接收一个候选对象，拒绝解释文字、拼接对象和候选自行提供的验收/授权字段。 */
export function parseToolEvolutionCandidate(text: string): ToolEvolutionParseResult<ToolEvolutionCandidate> {
  if (typeof text !== "string") return err("invalid_json", "candidate response must be text");
  if (byteLength(text) > TOOL_EVOLUTION_MAX_CANDIDATE_BYTES) return err("payload_too_large", "candidate exceeds byte budget");
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
  let input: unknown;
  try {
    input = JSON.parse(fence?.[1] ?? trimmed) as unknown;
  } catch {
    return err("invalid_json", "candidate response must contain one JSON object");
  }
  if (!recordOf(input) || !isJsonValue(input) || !keysAre(input, CANDIDATE_KEYS) || !textOf(input.source)) {
    return err("invalid_candidate", "candidate fields are invalid or contain unsupported keys");
  }
  if (byteLength(input.source) > TOOL_EVOLUTION_MAX_SOURCE_BYTES) return err("payload_too_large", "candidate source exceeds byte budget");
  const descriptor = parseDescriptorFields(input);
  return descriptor.ok ? ok({ ...descriptor.value, source: input.source }) : descriptor;
}

/** Package knowledge has no executable source field; generated and third-party tools share this shape. */
export function parseToolRuntimeDescriptor(input: unknown): ToolEvolutionParseResult<ToolRuntimeDescriptor> {
  if (!recordOf(input) || !isJsonValue(input) || jsonBytes(input) > TOOL_EVOLUTION_MAX_CANDIDATE_BYTES || !keysAre(input, DESCRIPTOR_KEYS)) return err("invalid_candidate", "tool descriptor fields are invalid");
  return parseDescriptorFields(input);
}
function parseDescriptorFields(input: Record<string, unknown>): ToolEvolutionParseResult<ToolRuntimeDescriptor> {
  if (typeof input.identity !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(input.identity)
    || !textOf(input.description, DESCRIPTION_MAX_CHARS) || !jsonObjectOf(input.inputSchema)) return err("invalid_candidate", "tool descriptor fields are invalid");
  const mastery = parseMastery(input.mastery);
  return mastery.ok ? ok({ identity: input.identity, description: input.description, inputSchema: structuredClone(input.inputSchema), mastery: mastery.value }) : mastery;
}

function parseMastery(input: unknown): ToolEvolutionParseResult<ToolEvolutionCandidate["mastery"]> {
  if (!recordOf(input) || !keysAre(input, ["whenToUse", "preconditions", "pitfalls"])
    || !textListOf(input.whenToUse, 1) || !textListOf(input.preconditions, 0) || !textListOf(input.pitfalls, 0)) {
    return err("invalid_candidate", "mastery must contain bounded applicability, preconditions and pitfalls lists");
  }
  return ok({ whenToUse: [...input.whenToUse], preconditions: [...input.preconditions], pitfalls: [...input.pitfalls] });
}

function textListOf(input: unknown, minItems: number): input is readonly string[] {
  return Array.isArray(input) && input.length >= minItems && input.length <= TOOL_EVOLUTION_MAX_MASTERY_ITEMS
    && input.every(item => textOf(item, TOOL_EVOLUTION_MAX_MASTERY_ITEM_CHARS));
}

function isSampleRole(value: unknown): value is ToolEvolutionSample["role"] {
  return value === "source" || value === "variation" || value === "counterexample";
}

export function recordOf(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function keysAre(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

export function textOf(value: unknown, maxChars?: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && (maxChars === undefined || value.length <= maxChars);
}

function jsonObjectOf(value: unknown): value is JsonObject {
  return recordOf(value) && isJsonValue(value);
}

/** 有限数字、普通数据对象、稠密数组；拒绝循环、访问器与隐藏的非 JSON 成员。 */
export function isJsonValue(value: unknown, maxDepth = TOOL_EVOLUTION_MAX_JSON_DEPTH): value is JsonValue {
  return visitJson(value, 0, new Set<object>(), maxDepth);
}

function visitJson(value: unknown, depth: number, seen: Set<object>, maxDepth: number): value is JsonValue {
  if (depth > maxDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const children = jsonChildren(value);
  if (children === undefined) return false;
  seen.add(value);
  const valid = children.every(child => visitJson(child, depth + 1, seen, maxDepth));
  seen.delete(value);
  return valid;
}

function jsonChildren(value: object): readonly unknown[] | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    });
  }
  if (!recordOf(value)) return undefined;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) return undefined;
  return descriptors.map(descriptor => descriptor.value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}
