export const GENERATED_MEDIA_SCHEMA = "trylo.generated-media.v1";
export type GeneratedMediaArtifact = { readonly path: string; readonly mimeType: string; readonly size: number; readonly sha256: string };
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);

/** Closed wire receipt. Image bytes and signed download URLs stay out of it. */
export function generatedMediaArtifacts(value: unknown): readonly GeneratedMediaArtifact[] | undefined {
  if (typeof value !== "object" || value === null || !("generatedMedia" in value)) return undefined;
  const media = value.generatedMedia;
  if (typeof media !== "object" || media === null || !("schema" in media) || media.schema !== GENERATED_MEDIA_SCHEMA
    || !("artifacts" in media) || !Array.isArray(media.artifacts)) return undefined;
  const result: GeneratedMediaArtifact[] = [];
  for (const item of media.artifacts) {
    if (typeof item !== "object" || item === null || typeof item.path !== "string" || !item.path
      || typeof item.mimeType !== "string" || !TYPES.has(item.mimeType) || !Number.isSafeInteger(item.size) || item.size <= 0
      || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return undefined;
    result.push({ path: item.path, mimeType: item.mimeType, size: item.size, sha256: item.sha256 });
  }
  return result.length ? result : undefined;
}
