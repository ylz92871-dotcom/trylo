import type { JsonValue } from "../../../../protocol/envelope.js";
import type { Result } from "../../../../tooling/contract/result.js";
import type { ToolRuntimeDescriptor } from "../../../../tooling/contract/descriptor.js";

/** 本实验候选包的版本；不是通用工具掌握模型或新的激活状态机。 */
export const TOOL_EVOLUTION_SCHEMA_VERSION = 1;
export const TOOL_EVOLUTION_MAX_SAMPLES = 32;
export const TOOL_EVOLUTION_MAX_SAMPLE_BYTES = 16 * 1024;
export const TOOL_EVOLUTION_MAX_SOURCE_BYTES = 32 * 1024;
export const TOOL_EVOLUTION_MAX_CANDIDATE_BYTES = 96 * 1024;
export const TOOL_EVOLUTION_MAX_REQUEST_BYTES = 256 * 1024;
export const TOOL_EVOLUTION_MAX_JSON_DEPTH = 16;
export const TOOL_EVOLUTION_MAX_ATTEMPTS = 3;
export const TOOL_EVOLUTION_DEFAULT_GENERATION_MS = 60_000;
export const TOOL_EVOLUTION_MAX_GENERATION_MS = 300_000;
export const TOOL_EVOLUTION_MAX_MASTERY_ITEMS = 8;
export const TOOL_EVOLUTION_MAX_MASTERY_ITEM_CHARS = 500;
export const TOOL_EVOLUTION_MAX_PREVIOUS_FAILURE_CHARS = 4096;

export type ToolEvolutionExpected =
  | { readonly kind: "value"; readonly value: JsonValue }
  | { readonly kind: "error"; readonly code: string };

export type ToolEvolutionSample = {
  readonly sampleId: string;
  readonly role: "source" | "variation" | "counterexample";
  readonly input: JsonValue;
  readonly expected: ToolEvolutionExpected;
};

export type ToolEvolutionRequest = {
  readonly schemaVersion: typeof TOOL_EVOLUTION_SCHEMA_VERSION;
  readonly requestId: string;
  readonly scope: string;
  readonly capability: string;
  readonly operation: "create" | "improve";
  readonly evidence: readonly ToolEvolutionSample[];
  readonly prior?: { readonly versionId: string; readonly source: string };
  readonly maxAttempts?: number;
};

export type ToolEvolutionCandidate = ToolRuntimeDescriptor & {
  /** CommonJS 模块：module.exports = function(input)；允许返回 Promise。 */
  readonly source: string;
};

export type ToolEvolutionParseFailure =
  | "invalid_json"
  | "unsupported_version"
  | "invalid_request"
  | "invalid_samples"
  | "duplicate_sample_id"
  | "insufficient_samples"
  | "invalid_prior"
  | "invalid_attempts"
  | "invalid_candidate"
  | "payload_too_large";

export type ToolEvolutionParseResult<T> = Result<T, ToolEvolutionParseFailure>;
