import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationDecision, OrganizationStored } from "../../learning/central/organization/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";

/** The original stored decision is a control, never independent business evidence. */
export function createOriginalOrganizationDecisionMaterial(row: OrganizationStored<OrganizationDecision>): CentralRuntimeMaterial {
  return { ref: row.factId, kind: "organization",
    text: canonicalJson({ role: "original_organization_decision_not_business_evidence", ...row }), sourceRefs: row.value.sourceRefs };
}
