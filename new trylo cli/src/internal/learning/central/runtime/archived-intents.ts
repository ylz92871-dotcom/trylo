import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { fields } from "../../../validation/json-shape.js";
import { isCentralLearningIntent } from "./validation.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "./contracts.js";
import type { CentralRuntimeHistory } from "./records.js";

export interface DeliveredArchivedIntentClaim {
  readonly materialRef: string;
  readonly factRef: string;
  readonly intentHash: string;
  readonly intent: CentralLearningIntentDraft;
}

function originalLookup(ref: string, intentId: string, factRef: string): boolean {
  if (ref === intentId) return true;

  if (!ref.startsWith("central-runtime-archive:")) return false;

  let value: unknown;

  try { value = JSON.parse(decodeURIComponent(ref.slice("central-runtime-archive:".length))); }
  catch { return false; } // An invalid caller address establishes no original owner.

  const optional = typeof value === "object" && value !== null && Object.hasOwn(value, "factRef") ? ["factRef"] : [];

  return fields(value, ["kind", "intentId", ...optional]) && value.kind === "ended_intent" && value.intentId === intentId
    && (!Object.hasOwn(value, "factRef") || value.factRef === factRef);
}

function ownerClaim(material: CentralRuntimeMaterial): DeliveredArchivedIntentClaim | undefined {
  if (material.kind !== "work_result") return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; } // Partial text/prose is not a complete original body.

  if (!fields(body, ["role", "factRef", "value"]) || typeof body.factRef !== "string"
    || !/^central-runtime-state:[a-f0-9]{64}$/.test(body.factRef) || !isCentralLearningIntent(body.value)
    || body.value.continuation.kind !== "ended" || canonicalJson(body) !== material.text) return undefined;

  const intent = body.value, factRef = body.factRef;

  if (body.role === "exact_original_ended_learning_purpose_not_new_evidence") {
    if (material.ref !== `central-runtime-purpose-record:${contentHashOf([intent.intentId, factRef])}`
      || canonicalJson(material.sourceRefs) !== canonicalJson([intent.intentId, factRef])) return undefined;
  } else if (body.role === "exact_original_runtime_archive_not_new_evidence") {
    if (material.ref !== `central-runtime-archived:${contentHashOf([factRef, intent])}` || material.sourceRefs.length !== 2
      || material.sourceRefs[0] !== factRef || !originalLookup(material.sourceRefs[1]!, intent.intentId, factRef)) return undefined;
  } else return undefined;

  return { materialRef: material.ref, factRef, intentHash: contentHashOf(intent), intent };
}

/** Identify only complete owner-shaped originals actually in this delivery.
 * This is a semantic claim, never final writer authority or fresh evidence.
 * Checkpoint-carried bodies, directories and fragments confer no such claim. */
export function identifyDeliveredArchivedIntentClaims(request: CentralDeliberationRequest):
  ReadonlyMap<string, DeliveredArchivedIntentClaim> {
  const claims = new Map<string, DeliveredArchivedIntentClaim>(), conflicts = new Set<string>();

  for (const material of [...request.materials, ...request.organization]) {
    const claim = ownerClaim(material);
    if (claim === undefined || request.state.intents.some(row => row.intentId === claim.intent.intentId)) continue;
    const id = claim.intent.intentId, prior = claims.get(id);
    if (prior !== undefined && (prior.factRef !== claim.factRef || prior.intentHash !== claim.intentHash)) conflicts.add(id);
    else claims.set(id, claim);
  }

  for (const id of conflicts) claims.delete(id);

  return claims;
}

/** Final authorization uses the original writer's verified latest head. The
 * same ID/locator alone cannot authorize a substituted or superseded body. */
export function deliveredArchivedIntents(request: CentralDeliberationRequest, history?: CentralRuntimeHistory):
  ReadonlyMap<string, CentralLearningIntentDraft> {
  const result = new Map<string, CentralLearningIntentDraft>();

  if (history === undefined) return result;

  for (const [id, claim] of identifyDeliveredArchivedIntentClaims(request)) {
    const head = history.purposeHeads?.find(row => row.intentId === id);
    if (head?.scope === request.scope && head.kind === "ended" && head.factRef === claim.factRef && head.intentHash === claim.intentHash) {
      result.set(id, claim.intent);
    }
  }

  return result;
}
