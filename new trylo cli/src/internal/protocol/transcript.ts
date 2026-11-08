import type { JsonObject, JsonValue } from "./envelope.js";
import { assertExhaustive } from "../contract/index.js";
import { isImageReferences, type ImageReference } from "./image-reference.js";

/**
 * Canonical transcript item: the single authoritative shape for "what the model
 * and the tools actually said", independent of any provider wire format or UI
 * projection.
 *
 * Owner: Execution Loop (writer). Readers: provider request builder, session
 * store, CLI projections. There is no second transcript type.
 */

export const TRANSCRIPT_ITEM_KINDS = [
  "system",
  "user",
  "assistant_text",
  "assistant_reasoning",
  "tool_call",
  "tool_result",
] as const;

export type TranscriptItemKind = (typeof TRANSCRIPT_ITEM_KINDS)[number];

type Base = {
  /** Stable within a turn; preserves causal order when projected or reloaded. */
  readonly sequence: number;
};

export type TranscriptItem =
  | (Base & { readonly kind: "system"; readonly text: string })
  | (Base & { readonly kind: "user"; readonly text: string })
  | (Base & { readonly kind: "assistant_text"; readonly blockId: string; readonly text: string })
  | (Base & {
      readonly kind: "assistant_reasoning";
      readonly blockId: string;
      readonly text: string;
      /** Provider delivered redacted/encrypted reasoning; text is a placeholder. */
      readonly redacted: boolean;
    })
  | (Base & {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: JsonObject;
      /** Original provider call when execution applies a declared normalization. */
      readonly originalArguments?: JsonObject;
    })
  | (Base & {
      readonly kind: "tool_result";
      readonly toolCallId: string;
      readonly name: string;
      readonly output: string;
      readonly truncated: boolean;
      readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
      readonly images?: ReadonlyArray<ImageReference>;
    });

export type Transcript = ReadonlyArray<TranscriptItem>;

export function isTranscriptItemKind(value: string): value is TranscriptItemKind {
  return (TRANSCRIPT_ITEM_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Runtime validation for persisted or adapter-supplied items.
 * Fails closed: an unrecognised shape is rejected rather than coerced.
 */
export function isTranscriptItem(value: unknown): value is TranscriptItem {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence)) {
    return false;
  }

  const kind = value.kind;
  if (typeof kind !== "string" || !isTranscriptItemKind(kind)) {
    return false;
  }

  switch (kind) {
    case "system":
    case "user":
      return typeof value.text === "string";
    case "assistant_text":
      return requiredString(value.blockId) && typeof value.text === "string";
    case "assistant_reasoning":
      return (
        requiredString(value.blockId) &&
        typeof value.text === "string" &&
        typeof value.redacted === "boolean"
      );
    case "tool_call":
      return (
        requiredString(value.toolCallId) &&
        requiredString(value.name) &&
        isRecord(value.arguments) &&
        isJsonValue(value.arguments) &&
        (value.originalArguments === undefined || (isRecord(value.originalArguments) && isJsonValue(value.originalArguments)))
      );
    case "tool_result":
      return (
        requiredString(value.toolCallId) &&
        requiredString(value.name) &&
        typeof value.output === "string" &&
        typeof value.truncated === "boolean" &&
        (value.outcome === "succeeded" ||
          value.outcome === "failed" ||
          value.outcome === "cancelled" ||
          value.outcome === "unknown") &&
        (value.images === undefined || (value.outcome === "succeeded" && isImageReferences(value.images)))
      );
    default: {
      assertExhaustive(kind);
      return false;
    }
  }
}

export function isTranscript(value: unknown): value is Transcript {
  return Array.isArray(value) && value.every(isTranscriptItem);
}

export const TRANSCRIPT_FORMAT_VERSION = "1";

export const TRANSCRIPT_UNKNOWN_VERSION_BEHAVIOR =
  "reject: an unknown transcript formatVersion must fail closed, never be partially reinterpreted";
