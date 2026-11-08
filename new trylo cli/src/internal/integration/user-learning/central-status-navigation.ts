import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { UserPeerProgress } from "../../learning/domains/user/learning-cycle-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields } from "../../validation/json-shape.js";
import { CENTRAL_USER_PEER_STATUS_ROLE, CENTRAL_USER_PEER_STATUS_PREFIX } from "../../learning/central/runtime/user-peer-status-contract.js";

export const USER_PEER_STATUS_READ_CONTRACT_VERSION = "user-peer-status-read-v1";
export const USER_PEER_STATUS_READ_CONTRACT = Object.freeze({
  version: USER_PEER_STATUS_READ_CONTRACT_VERSION,
  read: "report_or_source_prefix_returns_peer_status_only",
  ledgerAndQuestion: "private_peer_identities_not_body_read_addresses",
  consult: "existing_native_User_subject_returns_status_and_advice_not_private_evidence",
  dispatch: "existing_User_subject_or_central_subject_with_explicit_User_destination_hands_research_to_User_under_original_permissions_and_funds",
  publicBusiness: "use_only_actual_advertised_public_session_references_under_original_collection_and_scope",
});

interface UserPeerStatus {
  readonly ledgerRef: string;
  readonly questionRef: string;
  readonly sourcePrefixRef: string;
  readonly hasEvidence: boolean;
  readonly policyRefs: readonly string[];
  readonly progress?: UserPeerProgress | undefined;
}

/** A host status view, never a disclosure of the private User evidence/model. */
export function createUserPeerStatusMaterial(state: UserPeerStatus, originalStatusRef?: string): CentralRuntimeMaterial {
  const text = canonicalJson({ role: CENTRAL_USER_PEER_STATUS_ROLE, owner: "user_learning",
    ledgerRef: state.ledgerRef, questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef,
    hasEvidence: state.hasEvidence, policyRefs: state.policyRefs,
    ...(state.progress === undefined ? {} : { progress: state.progress }),
    ...(originalStatusRef === undefined ? {} : { originalStatusRef }),
    readContract: USER_PEER_STATUS_READ_CONTRACT,
    interpretation: "Peer availability/status only, not private evidence or a business source body. Reading the current report or its prefix returns status again. User retains autonomous learning; consult or dispatch are optional, not instructions. Ledger/question identities grant no body read. Public business evidence must come from actual advertised session references." });
  const material = { kind: "source" as const, text, sourceRefs: [state.sourcePrefixRef] };

  return { ref: `${CENTRAL_USER_PEER_STATUS_PREFIX}${contentHashOf(material)}`, ...material };
}

/** The view is complete status, not an address promising a private source read. */
export function isUserPeerStatusNavigation(material: CentralRuntimeMaterial): boolean {
  if (material.kind !== "source" || material.sourceRefs.length !== 1
    || material.ref !== `${CENTRAL_USER_PEER_STATUS_PREFIX}${contentHashOf({ kind: material.kind, text: material.text, sourceRefs: material.sourceRefs })}`) return false;
  let body: unknown;
  try { body = JSON.parse(material.text); } catch { return false; } // Not a canonical host status envelope.
  return typeof body === "object" && body !== null && "role" in body && body.role === CENTRAL_USER_PEER_STATUS_ROLE
    && "sourcePrefixRef" in body && body.sourcePrefixRef === material.sourceRefs[0];
}

/** Only the exact original six-field host availability report qualifies.
 * Consult/progress reports, session text, reordered JSON and extra fields do not.
 */
function legacyAvailability(material: CentralRuntimeMaterial): UserPeerStatus | undefined {
  if (material.kind !== "source" || material.sourceRefs.length !== 1
    || material.ref !== `user-report:${contentHashOf({ kind: material.kind, text: material.text, sourceRefs: material.sourceRefs })}`) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; } // Prose is not the closed host status contract.

  if (!fields(body, ["owner", "ledgerRef", "questionRef", "sourcePrefixRef", "hasEvidence", "policyRefs"])
    || body.owner !== "user_learning" || typeof body.ledgerRef !== "string" || !/^user-ledger_[a-f0-9]{16}$/.test(body.ledgerRef)
    || typeof body.questionRef !== "string" || body.questionRef !== `user-question_${body.ledgerRef.slice("user-ledger_".length)}`
    || typeof body.sourcePrefixRef !== "string" || !/^user-source:[a-f0-9]{64}$/.test(body.sourcePrefixRef)
    || material.sourceRefs[0] !== body.sourcePrefixRef || typeof body.hasEvidence !== "boolean"
    || !Array.isArray(body.policyRefs) || body.policyRefs.length > 1
    || !body.policyRefs.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 512)) return undefined;

  const status = { ledgerRef: body.ledgerRef, questionRef: body.questionRef, sourcePrefixRef: body.sourcePrefixRef,
    hasEvidence: body.hasEvidence, policyRefs: body.policyRefs };

  return material.text === JSON.stringify({ owner: "user_learning", ...status }) ? status : undefined;
}

/** Only input-v5 presentation calls this. Do not mutate old requests/archives. */
export function projectUserPeerStatusMaterials(materials: readonly CentralRuntimeMaterial[]): readonly CentralRuntimeMaterial[] {
  return materials.map(material => {
    const status = legacyAvailability(material);
    return status === undefined ? material : createUserPeerStatusMaterial(status, material.ref);
  });
}
