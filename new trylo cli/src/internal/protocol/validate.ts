import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  type Envelope,
  type JsonObject,
  type JsonValue,
} from "./envelope.js";
import type { ValidateErr, ValidateFailureCode, ValidateResult } from "./result.js";

export function parseEnvelope(value: unknown): ValidateResult {
  if (!isRecord(value)) {
    return fail("not_object");
  }
  if (!hasOwn(value, "eventId")) {
    return fail("missing_event_id");
  }

  const protocolVersion = requiredString(value.protocolVersion);
  if (protocolVersion === undefined || protocolVersion !== PROTOCOL_VERSION) {
    return fail("invalid_protocol_version");
  }
  const eventId = requiredString(value.eventId);
  if (eventId === undefined) {
    return fail("missing_event_id");
  }
  const sequence = requiredNat(value.sequence);
  if (sequence === undefined) {
    return fail(hasOwn(value, "sequence") ? "invalid_sequence" : "missing_sequence");
  }
  const timestamp = requiredString(value.timestamp);
  if (timestamp === undefined) {
    return fail("invalid_timestamp");
  }
  const kind = requiredString(value.kind);
  if (kind === undefined) {
    return fail("invalid_kind");
  }
  const payload = parsePayload(value.payload);
  if (payload === "too_large") {
    return fail("payload_too_large");
  }
  if (payload === undefined) {
    return fail("invalid_payload");
  }
  const producerId = requiredString(value.producerId);
  const producerSequence = requiredNat(value.producerSequence);
  if (producerId === undefined || producerSequence === undefined) {
    return fail("invalid_producer");
  }

  const sessionId = optionalId(value, "sessionId");
  const turnId = optionalId(value, "turnId");
  const attemptId = optionalId(value, "attemptId");
  const correlationId = optionalId(value, "correlationId");
  if (
    sessionId === "invalid" ||
    turnId === "invalid" ||
    attemptId === "invalid" ||
    correlationId === "invalid"
  ) {
    return fail("invalid_optional_id");
  }

  const envelope: Envelope = {
    protocolVersion,
    eventId,
    sequence,
    timestamp,
    kind,
    payload,
    producerId,
    producerSequence,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
  return { ok: true, envelope: freezeEnvelope(envelope) };
}

export function freezeEnvelope(envelope: Envelope): Envelope {
  deepFreeze(envelope.payload);
  return Object.freeze(envelope);
}

function parsePayload(value: unknown): JsonObject | "too_large" | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const size = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size > MAX_PAYLOAD_BYTES) {
    return "too_large";
  }
  return value as JsonObject;
}

function optionalId(
  record: Record<string, unknown>,
  key: string,
): string | "invalid" | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const text = requiredString(record[key]);
  return text === undefined ? "invalid" : text;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNat(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(code: ValidateFailureCode): ValidateErr {
  return { ok: false, code };
}

export function deepFreeze(value: JsonValue): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
    return;
  }
  const record = value as JsonObject;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child !== undefined) {
      deepFreeze(child);
    }
  }
  Object.freeze(record);
}
