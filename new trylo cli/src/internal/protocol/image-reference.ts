import { isImageDetail, MAX_IMAGE_BYTES, type ImageDetail } from "./media.js";

/** Durable identity, never image bytes. A new process must revalidate the
 * workspace file and digest before sending it; changed/missing bytes refuse.
 */
export type ImageReference = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly detail: ImageDetail;
};

export function isImageReferences(value: unknown): value is ReadonlyArray<ImageReference> {
  return Array.isArray(value) && value.length <= 16 && value.every(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;

    const ref = item as Record<string, unknown>;

    return Object.keys(ref).sort().join(",") === "bytes,detail,path,sha256"
      && typeof ref.path === "string" && ref.path.trim().length > 0 && ref.path.length <= 32768
      && typeof ref.sha256 === "string" && /^[a-f0-9]{64}$/.test(ref.sha256)
      && typeof ref.bytes === "number" && Number.isInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= MAX_IMAGE_BYTES
      && typeof ref.detail === "string" && isImageDetail(ref.detail);
  });
}
