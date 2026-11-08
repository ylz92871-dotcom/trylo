import type { Envelope } from "./envelope.js";
import type { ValidateResult } from "./result.js";
import { parseEnvelope } from "./validate.js";

export function encodeEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function decodeEnvelope(raw: string): ValidateResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json" };
  }

  return parseEnvelope(parsed);
}
