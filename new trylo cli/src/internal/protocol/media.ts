/**
 * Canonical media contracts (WP19.1: C25, C26, L10).
 *
 * One owner for "what an image is" in Trylo: the MIME allowlist, the detail
 * vocabulary, the byte ceiling, and the shape a validated image takes into a
 * provider request. Adapters may translate this shape to a wire format, but
 * they may not invent a second one.
 *
 * Reuse (mechanical layer only, types stay Trylo-owned):
 * - Codex `utils/image/src/lib.rs` — `data_url_from_bytes`, the
 *   png/jpeg/gif/webp passthrough set (`can_preserve_source_bytes`), the
 *   `high`/`original` detail split, `MAX_DIMENSION 2048`;
 * - legacy `FileReadTool.ts:188` (`IMAGE_EXTENSIONS`), `:250` (image media
 *   types), `constants/apiLimits.ts:22` (5 MiB base64 hard limit, from which
 *   the raw cap below is derived).
 */

export const IMAGE_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageMime = (typeof IMAGE_MIME_ALLOWLIST)[number];

export function isImageMime(value: string): value is ImageMime {
  return (IMAGE_MIME_ALLOWLIST as readonly string[]).includes(value);
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export function isImageExtension(value: string): value is ImageExtension {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(value.toLowerCase());
}

/** Extension -> MIME for the allowlisted set only; nothing else is mapped. */
export function extensionMime(extension: string): ImageMime | undefined {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/**
 * How much of the image the model may spend budget on. `high` is the default
 * resized view; `original` spends the full patch budget. Anything else is a
 * refusal, not a guess — Codex rejects unknown detail strings the same way
 * (`view_image.rs`: only `high`/`original` parse).
 */
export const IMAGE_DETAILS = ["high", "original"] as const;

export type ImageDetail = (typeof IMAGE_DETAILS)[number];

export function isImageDetail(value: string): value is ImageDetail {
  return (IMAGE_DETAILS as readonly string[]).includes(value);
}

/**
 * Largest raw image accepted. Equals the legacy pipeline's own post-resize
 * ceiling (`IMAGE_TARGET_RAW_SIZE = 5*1024*1024*3/4 = 3 932 160` in
 * `constants/apiLimits.ts`): its base64 lands exactly on the 5 MiB
 * (`5*1024*1024`) wire hard limit, so anything larger is refused with
 * `too_large` rather than silently truncated: a half-image presented as a
 * whole one would be a wrong answer, not a shorter one.
 *
 * WP19 复核订正 (F4): an earlier value of 3_748_800 claimed the same
 * derivation but matched neither baseline and mis-stated the 5 MiB
 * arithmetic; it erred on the tight side (never over the wire cap).
 */
export const MAX_IMAGE_BYTES = 3_932_160;

/**
 * Largest image edge accepted without a resize step (WP19 复核订正 F1).
 *
 * Enforced, not advisory: this package ships no resizer, and a 5000px PNG
 * passed through unchanged would either be refused far away at the provider
 * or billed as a full patch budget the sender never approved. A valid image
 * over this edge is refused with `too_large` (naming its dimensions) until a
 * resize helper lands — fail closed at the boundary that can see the bytes.
 * Matches Codex `MAX_DIMENSION 2048` and the legacy ~2000px pipeline.
 */
export const MAX_IMAGE_DIMENSION = 2048;

/**
 * A validated image travelling with a provider message. `dataBase64` is the
 * full payload (never logged, never persisted as a session fact in v1);
 * `bytes` is the raw length it was validated at.
 */
export type ProviderImageAttachment = {
  readonly mediaType: ImageMime;
  readonly dataBase64: string;
  readonly bytes: number;
  readonly detail: ImageDetail;
  readonly width?: number;
  readonly height?: number;
};

/** Why an image input was refused. Each code is a distinct model action. */
export const IMAGE_REFUSAL_CODES = [
  "empty_file",
  "too_large",
  "invalid_image",
  "unsupported_detail",
  "bytes_unavailable",
] as const;

export type ImageRefusalCode = (typeof IMAGE_REFUSAL_CODES)[number];

export type ImageValidation =
  | { readonly ok: true; readonly attachment: Omit<ProviderImageAttachment, "detail"> }
  | { readonly ok: false; readonly code: ImageRefusalCode; readonly message: string };
