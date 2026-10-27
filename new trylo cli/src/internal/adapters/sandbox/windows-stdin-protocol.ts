import { isAbsolute } from "node:path";
import { timingSafeEqual } from "node:crypto";

export const STDIN_PIPE = "TRYLO_STDIN_BRIDGE_PIPE";
export const STDIN_TOKEN = "TRYLO_STDIN_BRIDGE_TOKEN";
export const STDIN_ACK = "trylo-stdin-v1\n";
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Both private entries accept argv data, never a shell command or executable code. */
export function bridgeArgv(text: string | undefined): readonly [string, ...string[]] {
  const value: unknown = JSON.parse(text ?? "null");
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096 || value.some(item => typeof item !== "string" || item.includes("\0")) || typeof value[0] !== "string" || !isAbsolute(value[0])) {
    throw new Error("stdin_bridge_invalid_argv");
  }
  return [value[0], ...value.slice(1)];
}

export function validStdinToken(actual: Buffer, expected: string): boolean {
  const wanted = Buffer.from(expected, "ascii");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Bounded framing preserves bytes arriving in the same packet after the header. */
export function takeStdinHeader(buffer: Buffer): { header: Buffer; rest: Buffer } | undefined {
  const end = buffer.indexOf(10);
  if (end < 0 && buffer.length <= 256) return undefined;
  if (end < 0 || end > 256) throw new Error("stdin_bridge_invalid_header");
  return { header: buffer.subarray(0, end), rest: buffer.subarray(end + 1) };
}
