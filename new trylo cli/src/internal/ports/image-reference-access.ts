import type { ImageReference } from "../protocol/image-reference.js";

/** A snapshot capability, never a general filesystem grant or journal field. */
export type ImageReferenceAccess = {
  resolve(reference: ImageReference): string | undefined;
};

export type ValidatedImageReferenceSink = (reference: ImageReference, absolutePath: string) => void;

/** The prepared run owns issuance and clearing; providers receive resolve only. */
export type ImageReferenceRegistry = ImageReferenceAccess & {
  readonly register: ValidatedImageReferenceSink;
  clear(): void;
};
