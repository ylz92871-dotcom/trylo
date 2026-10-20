import { isAbsolute } from "node:path";
import { isImageReferences, type ImageReference } from "../../protocol/image-reference.js";
import type { ImageReferenceRegistry } from "../../ports/image-reference-access.js";

function keyOf(reference: ImageReference): string {
  return JSON.stringify([reference.path, reference.sha256, reference.bytes, reference.detail]);
}

/** Issued only after view_image validated a permitted snapshot. Never persisted. */
export function createImageReferenceRegistry(): ImageReferenceRegistry {
  const snapshots = new Map<string, string>();
  return {
    register(reference, absolutePath) {
      if (!isImageReferences([reference]) || !isAbsolute(absolutePath)) throw new Error("invalid_validated_image_reference");
      snapshots.set(keyOf(reference), absolutePath);
    },
    resolve: reference => snapshots.get(keyOf(reference)),
    clear: () => snapshots.clear(),
  };
}
