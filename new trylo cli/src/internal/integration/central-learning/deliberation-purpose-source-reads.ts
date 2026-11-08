import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { identifyDeliveredArchivedIntentClaims } from "../../learning/central/runtime/archived-intents.js";
import { readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { CENTRAL_CHANGE_INPUT_VERSION, type CentralChangeInputVersion } from "./change-input-contract.js";

function originalSourceRefs(intent: CentralLearningIntentDraft, version: CentralChangeInputVersion): readonly string[] {
  // These are retained host-owned dependency locations, not observations. V5/V6
  // receipt menus stay frozen; only V7 exposes the continuation's own sources.
  const continuationRefs = version !== "central-learning-change-input-v7" ? []
    : intent.continuation.kind === "waiting" ? intent.continuation.wait.sourceRefs
      : intent.continuation.kind === "ready" ? intent.continuation.operation.sourceRefs : [];
  return [...new Set([...intent.sourceRefs, ...intent.knowledge.flatMap(row => row.sourceRefs),
    ...(intent.derivation?.parentRefs ?? []), ...(intent.derivation?.citations.map(row => row.evidenceRef) ?? []), ...continuationRefs])];
}

/** Complete originals supplied by the host may locate their original sources.
 * These owner-shaped claims grant only read locations, never original-body
 * proof, citation support or authority to resume an archived purpose. The
 * original source reader still checks existence, scope and permissions. */
export function centralPurposeSourceReads(request: CentralDeliberationRequest,
  version: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): ReadonlyMap<string, readonly string[]> {
  const reads = new Map<string, readonly string[]>();
  for (const claim of identifyDeliveredArchivedIntentClaims(request).values()) {
    reads.set(claim.materialRef, originalSourceRefs(claim.intent, version));
  }
  return reads;
}

/** A complete visible working purpose may locate sources retained in its
 * knowledge even after those business bodies leave this call's context.
 * Unread navigation and incomplete original fragments remain invisible. */
export function centralVisiblePurposeSourceReads(request: CentralDeliberationRequest,
  version: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): ReadonlyMap<string, readonly string[]> {
  return new Map(readActivePurposeDelivery(request).visibleIntents.map(intent => [intent.intentId, originalSourceRefs(intent, version)]));
}
