import type { JsonObject } from "../../../../../../protocol/envelope.js";
import type { ToolRuntimeDescriptor } from "../../../../../../tooling/contract/descriptor.js";
import { err, ok } from "../../../../../../tooling/contract/result.js";
import { CRYSTAL_MIN_SUCCESSES } from "../awareness/constants.js";
import {
  TOOL_EVOLUTION_MAX_ATTEMPTS,
  TOOL_EVOLUTION_MAX_CANDIDATE_BYTES,
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
  type ToolCompositionPlan,
  type ToolCompositionBinding,
} from "./contracts.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf, utf8Bytes as byteLength } from "./json-shape.js";
import { applyToolSourcePatch } from "./source-edits.js";

export { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "./json-shape.js";

const REQUEST_KEYS = ["schemaVersion", "requestId", "scope", "capability", "operation", "evidence"];
const REQUEST_OPTIONAL_KEYS = ["prior", "maxAttempts", "composition", "contractRevisionRefs"];
const SAMPLE_KEYS = ["sampleId", "role", "input", "expected"];
const CANDIDATE_KEYS = ["identity", "description", "source", "inputSchema", "mastery"];
const DESCRIPTOR_KEYS = ["identity", "description", "inputSchema", "mastery"];
const ID_MAX_CHARS = 128;
const SCOPE_MAX_CHARS = 512;
const CAPABILITY_MAX_CHARS = 2048;
const DESCRIPTION_MAX_CHARS = 2048;

/** Model-visible facts from the same request parser, not a second validator or
 * a new spending/output limit. Used when repairing a rejected planning reply. */
export function toolEvolutionRequestFormat() {
  return { requiredFields: [...REQUEST_KEYS], optionalFields: [...REQUEST_OPTIONAL_KEYS], sampleFields: [...SAMPLE_KEYS],
    requestIdMaxChars: ID_MAX_CHARS, scopeMaxChars: SCOPE_MAX_CHARS, capabilityMaxChars: CAPABILITY_MAX_CHARS,
    sampleIdMaxChars: ID_MAX_CHARS, maxSamples: TOOL_EVOLUTION_MAX_SAMPLES, maxSampleBytes: TOOL_EVOLUTION_MAX_SAMPLE_BYTES,
    maxRequestBytes: TOOL_EVOLUTION_MAX_REQUEST_BYTES, sourceSuccessesRequired: CRYSTAL_MIN_SUCCESSES,
    requiredOtherRoles: ["variation", "counterexample"], sourceExpectedKind: "value" };
}

/** 输入是冻结验收合同；解析不采信额外授权字段，也不替调用方生成期望结果。 */
export function parseToolEvolutionRequest(input: unknown): ToolEvolutionParseResult<ToolEvolutionRequest> {
  if (!recordOf(input) || !isJsonValue(input)) return err("invalid_request", "request must be finite, bounded-depth JSON");

  if (jsonBytes(input) > TOOL_EVOLUTION_MAX_REQUEST_BYTES) return err("payload_too_large", "request exceeds byte budget");

  if (input.schemaVersion !== TOOL_EVOLUTION_SCHEMA_VERSION) return err("unsupported_version", "unsupported tool evolution schemaVersion");

  if (!keysAre(input, REQUEST_KEYS, REQUEST_OPTIONAL_KEYS) || !textOf(input.requestId, ID_MAX_CHARS)
    || !textOf(input.scope, SCOPE_MAX_CHARS) || !textOf(input.capability, CAPABILITY_MAX_CHARS)
    || (input.operation !== "create" && input.operation !== "improve")) {
    return err("invalid_request", "request fields are invalid or contain unsupported keys");
  }

  const evidence = parseSamples(input.evidence);
  if (!evidence.ok) return evidence;

  const prior = parsePrior(input.prior, input.operation);
  if (!prior.ok) return prior;

  const composition = input.composition === undefined ? undefined : decodeToolCompositionPlan(input.composition);
  if (input.composition !== undefined && composition === undefined) return err("invalid_request", "composition must be bounded acyclic dataflow over pinned tool versions");

  const revisions = input.contractRevisionRefs;
  if (revisions !== undefined && (!Array.isArray(revisions) || revisions.length > 8
    || revisions.some(ref => !textOf(ref, 160)) || new Set(revisions).size !== revisions.length)) return err("invalid_request", "contract revision refs must be unique bounded approval references");

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
    ...(composition === undefined ? {} : { composition }),
    ...(revisions === undefined ? {} : { contractRevisionRefs: [...revisions] }),
  });
}

export function decodeToolCompositionPlan(input: unknown): ToolCompositionPlan | undefined {
  if (!recordOf(input) || !isJsonValue(input) || !keysAre(input, ["schemaVersion", "steps", "output"])
    || input.schemaVersion !== 1 || !Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 8) return undefined;

  const steps: ToolCompositionPlan["steps"][number][] = [];
  const preceding = new Set<string>();

  for (const raw of input.steps) {
    if (!recordOf(raw) || !keysAre(raw, ["stepId", "versionId", "input"]) || typeof raw.stepId !== "string"
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(raw.stepId) || preceding.has(raw.stepId)
      || typeof raw.versionId !== "string" || !/^tool-evolution(?:_v1)?_[a-f0-9]{64}$/u.test(raw.versionId)) return undefined;

    const binding = decodeCompositionBinding(raw.input, preceding, 0);
    if (binding === undefined) return undefined;

    steps.push({ stepId: raw.stepId, versionId: raw.versionId, input: binding });
    preceding.add(raw.stepId);
  }

  const output = decodeCompositionBinding(input.output, preceding, 0);

  return output === undefined || !referencesStep(output) ? undefined : { schemaVersion: 1, steps, output };
}

function decodeCompositionBinding(input: unknown, preceding: ReadonlySet<string>, depth: number): ToolCompositionBinding | undefined {
  if (depth > 8 || !recordOf(input)) return undefined;

  if (input.from === "literal" && keysAre(input, ["from", "value"]) && isJsonValue(input.value)) {
    return { from: "literal", value: structuredClone(input.value) };
  }

  if (input.from === "object" && keysAre(input, ["from", "fields"]) && recordOf(input.fields)
    && Object.keys(input.fields).length <= 32) {
    const fields: Record<string, ToolCompositionBinding> = Object.create(null) as Record<string, ToolCompositionBinding>;

    for (const [key, raw] of Object.entries(input.fields)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 128) return undefined;
      const binding = decodeCompositionBinding(raw, preceding, depth + 1);
      if (binding === undefined) return undefined;
      fields[key] = binding;
    }

    return { from: "object", fields };
  }

  if (!Array.isArray(input.path) || input.path.length > 16 || !input.path.every(part => typeof part === "string" && part.length <= 128
    && !["__proto__", "prototype", "constructor"].includes(part))) return undefined;

  if (input.from === "input" && keysAre(input, ["from", "path"])) return { from: "input", path: [...input.path] };

  if (input.from === "step" && keysAre(input, ["from", "stepId", "path"]) && typeof input.stepId === "string" && preceding.has(input.stepId)) {
    return { from: "step", stepId: input.stepId, path: [...input.path] };
  }

  return undefined;
}

function referencesStep(binding: ToolCompositionBinding): boolean {
  return binding.from === "step" || (binding.from === "object" && Object.values(binding.fields).some(referencesStep));
}

function parseSamples(input: unknown): ToolEvolutionParseResult<readonly ToolEvolutionSample[]> {
  if (!Array.isArray(input)) return err("invalid_samples", "evidence must be an array");

  if (input.length > TOOL_EVOLUTION_MAX_SAMPLES) return err("payload_too_large", "too many evidence samples");

  const samples: ToolEvolutionSample[] = [];
  const ids = new Set<string>();

  for (const value of input) {
    const sample = parseToolEvolutionSample(value);
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

export function parseToolEvolutionSample(input: unknown): ToolEvolutionParseResult<ToolEvolutionSample> {
  if (!recordOf(input) || !keysAre(input, SAMPLE_KEYS)
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
export function parseToolEvolutionCandidate(text: string, baseSource?: string): ToolEvolutionParseResult<ToolEvolutionCandidate> {
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

  if (!recordOf(input) || !isJsonValue(input)) return err("invalid_candidate", "candidate fields must be plain JSON data");

  const patched = Object.hasOwn(input, "sourcePatch");
  if (patched === Object.hasOwn(input, "source") || !keysAre(input, patched ? [...DESCRIPTOR_KEYS, "sourcePatch"] : CANDIDATE_KEYS)) {
    return err("invalid_candidate", "candidate fields are invalid or contain unsupported keys");
  }

  let source = input.source;

  if (patched) {
    if (baseSource === undefined) return err("invalid_prior", "sourcePatch requires the host's frozen prior source");
    const expanded = applyToolSourcePatch(baseSource, input.sourcePatch, {
      maxInputBytes: TOOL_EVOLUTION_MAX_SOURCE_BYTES + TOOL_EVOLUTION_MAX_CANDIDATE_BYTES, maxOutputBytes: TOOL_EVOLUTION_MAX_SOURCE_BYTES,
    });
    if (!expanded.ok) return err("invalid_candidate", `${expanded.code}${expanded.editIndex === undefined ? "" : ` at edit ${expanded.editIndex}`}: ${expanded.message}`);
    source = expanded.source;
  }

  if (!textOf(source)) return err("invalid_candidate", "candidate requires one nonempty complete source or a valid prior source patch");

  if (byteLength(source) > TOOL_EVOLUTION_MAX_SOURCE_BYTES) return err("payload_too_large", "candidate source exceeds byte budget");

  const descriptor = parseDescriptorFields(input);

  return descriptor.ok ? ok({ ...descriptor.value, source }) : descriptor;
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

function jsonObjectOf(value: unknown): value is JsonObject {
  return recordOf(value) && isJsonValue(value);
}
