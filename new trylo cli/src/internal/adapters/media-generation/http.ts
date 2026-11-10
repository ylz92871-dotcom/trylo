import type { MediaConnection } from "./config.js";

export class MediaFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export type MediaHttp = { readonly fetch: typeof globalThis.fetch };
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
export function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

export function headers(connection: MediaConnection): Record<string, string> {
  return connection.apiKey ? connection.protocol === "gemini-images"
    ? { "x-goog-api-key": connection.apiKey } : { Authorization: `Bearer ${connection.apiKey}` } : {};
}

/** POSTs are issued once. A lost create receipt is not permission to resubmit. */
export async function mediaJson(http: MediaHttp, url: string, connection: MediaConnection, signal: AbortSignal,
  body?: unknown, extraHeaders?: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  const response = await http.fetch(url, { method: body === undefined ? "GET" : "POST", signal, redirect: "error",
    headers: { ...headers(connection), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new MediaFailure(`media_http_${response.status}`);
  let value: unknown;
  try { value = await response.json(); } catch { throw new MediaFailure("invalid_media_response"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MediaFailure("invalid_media_response");
  return record(value);
}

export type ImageSource = { readonly kind: "bytes"; readonly bytes: Uint8Array } | { readonly kind: "url"; readonly url: string };
export function imageUrl(value: unknown): ImageSource | undefined {
  const url = text(value);
  if (!url) return undefined;
  if (url.startsWith("data:image/")) {
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
    if (!match) throw new MediaFailure("invalid_media_response");
    return { kind: "bytes", bytes: Buffer.from(match[1]!, "base64") };
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new MediaFailure("invalid_media_response"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new MediaFailure("invalid_media_response");
  return { kind: "url", url };
}
