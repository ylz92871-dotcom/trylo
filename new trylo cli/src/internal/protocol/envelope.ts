export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export type Envelope = {
  readonly protocolVersion: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly correlationId?: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly producerId: string;
  readonly producerSequence: number;
};

export const PROTOCOL_VERSION = "0.0";
export const MAX_PAYLOAD_BYTES = 65_536;
export const TERMINAL_KIND = "terminal";
export const TERMINAL_REASONS = [
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type TerminalReason = (typeof TERMINAL_REASONS)[number];
