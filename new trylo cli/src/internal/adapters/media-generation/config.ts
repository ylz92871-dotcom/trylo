export const IMAGE_PROTOCOLS = ["openai-images", "dashscope-images", "gemini-images"] as const;
export const VIDEO_PROTOCOLS = ["ark-video", "dashscope-video", "replicate-video"] as const;
export type MediaProtocol = typeof IMAGE_PROTOCOLS[number] | typeof VIDEO_PROTOCOLS[number];
export type MediaConnection = {
  readonly enabled: boolean;
  readonly protocol: MediaProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
};
export type MediaConfiguration = {
  readonly image?: MediaConnection;
  readonly video?: MediaConnection;
  readonly browserFallback: boolean;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connection(value: unknown, protocols: readonly string[]): MediaConnection | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || typeof value.enabled !== "boolean" || typeof value.protocol !== "string" || !protocols.includes(value.protocol)
    || typeof value.endpoint !== "string" || typeof value.model !== "string" || typeof value.apiKey !== "string") throw new Error("invalid_media_configuration");
  if (value.enabled) {
    let url: URL;
    try { url = new URL(value.endpoint); } catch { throw new Error("invalid_media_endpoint"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !value.model.trim()) {
      throw new Error("invalid_media_configuration");
    }
  }
  return { enabled: value.enabled, protocol: value.protocol as MediaProtocol, endpoint: value.endpoint.replace(/\/+$/, ""),
    model: value.model.trim(), apiKey: value.apiKey.trim() };
}

/** Versioned child input. Credentials never join a prompt, argv or diagnostic. */
export function readMediaConfiguration(text: string | undefined): MediaConfiguration | undefined {
  if (!text) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid_media_configuration"); }
  if (!object(value) || value.version !== 1 || typeof value.browserFallback !== "boolean") throw new Error("invalid_media_configuration");
  const image = connection(value.image, IMAGE_PROTOCOLS), video = connection(value.video, VIDEO_PROTOCOLS);
  return { browserFallback: value.browserFallback, ...(image === undefined ? {} : { image }), ...(video === undefined ? {} : { video }) };
}

export function mediaApiUrl(connection: MediaConnection, suffix: string): string {
  return connection.endpoint + "/" + suffix.replace(/^\/+/, "");
}
