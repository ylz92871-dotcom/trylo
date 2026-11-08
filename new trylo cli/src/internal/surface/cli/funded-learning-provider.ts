import type { ProviderPort } from "../../ports/provider.js";
import type { ImageReferenceAccess } from "../../ports/image-reference-access.js";
import { buildProvider, type ProviderBuildInput } from "./provider-build.js";

/** A funded stream uses the existing one-request transport policy, while normal work keeps its retries.
 * Caller-owned guards and opaque injected providers retain their own accounting/transport contract. */
export function buildLearningProvider(input: ProviderBuildInput, parent: ProviderPort, images?: ImageReferenceAccess) {
  if (input.requestAttemptPolicy === "single_request") return parent;
  return buildProvider({ ...input, requestAttemptPolicy: "single_request" }, images);
}
