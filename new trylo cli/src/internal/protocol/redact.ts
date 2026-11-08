import type { Envelope, JsonObject, JsonValue } from "./envelope.js";

const ABSOLUTE_PATH =
  /(?:[A-Za-z]:\\[^\s"]+|\/(?:home|Users|tmp|var|etc|usr|root)\/[^\s"]+)/g;
const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/gi;

/** Reuse the original credential-shape policy where canonical identity metadata
 * has its own path policy. Existing envelope/value redaction stays unchanged. */
export function redactSecretShapes(text: string): string { return text.replace(SECRET_SHAPE, "[secret]"); }

export function redactEnvelope(envelope: Envelope): Envelope {
  return {
    ...envelope,
    payload: redactObject(envelope.payload),
  };
}

/**
 * The same redaction, over a bare value.
 *
 * Exported so any persisted value can cross this boundary without having to be
 * dressed up as an envelope first — a value that skips it would land secrets
 * and absolute paths on disk.
 */
export function redactJsonValue(value: JsonValue): JsonValue {
  return redactValue(value);
}

function redactObject(value: JsonObject): JsonObject {
  const next: { [key: string]: JsonValue } = {};

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child !== undefined) {
      next[key] = redactValue(child);
    }
  }

  return next;
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.replace(ABSOLUTE_PATH, "[path]").replace(SECRET_SHAPE, "[secret]");
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (typeof value === "object" && value !== null) {
    return redactObject(value as JsonObject);
  }

  return value;
}
