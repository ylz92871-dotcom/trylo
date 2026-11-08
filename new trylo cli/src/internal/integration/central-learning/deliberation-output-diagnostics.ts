import { PROVIDER_FINISH_REASONS, type ProviderFinishReason } from "../../ports/provider.js";
import { fields, sequence } from "../../validation/json-shape.js";
import { INVALID_TOOL_INPUT_MESSAGE, parseToolInput } from "../../adapters/provider/invalid-tool-input.js";

const REJECTION_REASONS = ["central_deliberation_tool_invalid", "central_deliberation_tool_forbidden",
  "central_deliberation_mixed_output", "central_deliberation_json_invalid", "central_deliberation_incomplete"] as const;
const CAUSES = ["open_json", "non_object_json", "invalid_json", "tool_id_mismatch", "unexpected_tool", "mixed_output",
  "missing_output", "length_termination", "unknown"] as const;

interface OutputDiagnosticsBase {
  readonly argumentChars: number;
  readonly toolStarts: number;
  readonly invalidTools: number;
  readonly requestedOutputTokens: number | null;
  readonly finishReason: ProviderFinishReason | null;
  readonly usageObserved: boolean;
  readonly streamExhausted: boolean;
  readonly usageTailComplete: boolean;
}

/** Public structural metadata only. Arguments, reasoning, tool names and raw
 * parser errors never enter the original operation's diagnostic record. */
export type CentralDeliberationOutputDiagnostics = OutputDiagnosticsBase & (
  | { readonly schemaVersion: 1; readonly rejectionReason: typeof REJECTION_REASONS[number];
    readonly cause: typeof CAUSES[number] }
  | { readonly schemaVersion: 2; readonly rejectionReason: typeof REJECTION_REASONS[number] | "central_deliberation_stream_protocol_gap";
    readonly cause: typeof CAUSES[number] | "wire_frame_invalid"; readonly mode: "tool" | "json_object";
    readonly unparseableSseFrames: number }
);

const BASE_FIELDS = ["schemaVersion", "rejectionReason", "cause", "argumentChars", "toolStarts", "invalidTools",
  "requestedOutputTokens", "finishReason", "usageObserved", "streamExhausted", "usageTailComplete"];

function diagnosticsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "schemaVersion" in value;
}

/** Old receipts may omit this optional record. Present records must match its
 * entire closed schema; unknown extensions cannot conceal private content. */
export function isCentralDeliberationOutputDiagnostics(value: unknown): value is CentralDeliberationOutputDiagnostics {
  if (!diagnosticsRecord(value)) return false;

  const version = value.schemaVersion;

  return (version === 1 || version === 2) && fields(value,
    version === 1 ? BASE_FIELDS : [...BASE_FIELDS, "mode", "unparseableSseFrames"])
    && (REJECTION_REASONS.some(reason => reason === value.rejectionReason)
      || version === 2 && value.rejectionReason === "central_deliberation_stream_protocol_gap")
    && (CAUSES.some(cause => cause === value.cause) || version === 2 && value.cause === "wire_frame_invalid")
    && (version === 1 || (value.mode === "tool" || value.mode === "json_object") && sequence(value.unparseableSseFrames))
    && sequence(value.argumentChars) && sequence(value.toolStarts) && sequence(value.invalidTools)
    && (value.requestedOutputTokens === null || sequence(value.requestedOutputTokens) && value.requestedOutputTokens > 0)
    && (value.finishReason === null || PROVIDER_FINISH_REASONS.some(reason => reason === value.finishReason))
    && typeof value.usageObserved === "boolean" && typeof value.streamExhausted === "boolean" && typeof value.usageTailComplete === "boolean";
}

/** A completely observed exhausted response with no decision tool is a known
 * negative result. Missing tails and partly emitted tools retain their owners. */
export function isCompleteCentralOutputCapacityRejection(value: unknown): value is CentralDeliberationOutputDiagnostics {
  return isCentralDeliberationOutputDiagnostics(value) && value.rejectionReason === "central_deliberation_incomplete"
    && value.cause === "length_termination" && value.finishReason === "length" && value.requestedOutputTokens !== null
    && value.toolStarts === 0 && value.argumentChars === 0 && value.invalidTools === 0
    && value.usageObserved && value.streamExhausted && value.usageTailComplete
    && (value.schemaVersion === 1 || value.unparseableSseFrames === 0);
}

/** Describe syntax without inferring why generation stopped or exposing input.
 * The existing wire parser owns the unclosed-container/string recognition. */
export function classifyCentralToolArguments(text: string): CentralDeliberationOutputDiagnostics["cause"] {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? "unknown" : "non_object_json";
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const parsed = parseToolInput(text);
    return !parsed.ok && parsed.message.startsWith(`${INVALID_TOOL_INPUT_MESSAGE} Input ended with an open JSON string or container.`)
      ? "open_json" : "invalid_json";
  }
}
