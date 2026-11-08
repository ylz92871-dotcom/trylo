import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ExpertAuthorizationAction, ExpertRequest, ExpertVersion } from "./contracts.js";
import { EXPERT_APPROVAL_REVIEW_MAX_BYTES, ExpertLibraryError } from "./contracts.js";

/** One exact-action formula for lifecycle approval and trusted UI gesture binding. */
export function expertRequestAuthorizationAction(request: ExpertRequest, stage: ExpertAuthorizationAction["stage"]): ExpertAuthorizationAction {
  const reviewJson = review(request);
  return { requestId: request.requestId, stage, fingerprint: sha256Hex(reviewJson), reviewJson,
    summary: `${stage}: ${request.configuration?.displayName ?? request.instruction}`.slice(0, 4000) };
}

export function expertArchiveAuthorizationAction(expert: ExpertVersion): ExpertAuthorizationAction {
  const reviewJson = review(expert);
  return { requestId: expert.requestId, stage: "archive", fingerprint: sha256Hex(reviewJson), reviewJson,
    summary: `Archive ${expert.configuration.displayName}` };
}

function review(value: ExpertRequest | ExpertVersion): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > EXPERT_APPROVAL_REVIEW_MAX_BYTES) {
    throw new ExpertLibraryError("invalid_input", "Expert approval review exceeds the supported size; reduce the configuration before submitting it");
  }
  return json;
}
