import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationEvidencePage } from "../../learning/central/organization/retrieval-evidence.js";
import { isOrganizationEvidencePage } from "../../learning/central/organization/evidence-validation.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";

export function createOrganizationEvidenceMaterial(scope: string, page: OrganizationEvidencePage): CentralRuntimeMaterial {
  const text = canonicalJson(page);
  return { ref: `organization-evidence-page:${contentHashOf({ scope, text })}`, kind: "organization", text,
    sourceRefs: [...new Set([page.knowledgeFactId, ...page.items.map(row => row.factId)])] };
}

/** Directory refs, registered citation lists and undelivered bodies never enter
 * the delivered feedback set. Only these complete rebuilt original facts do. */
export function readOrganizationEvidenceMaterial(material: CentralRuntimeMaterial, scope: string): OrganizationEvidencePage | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith("organization-evidence-page:")) return undefined;

  let page: unknown;

  try { page = JSON.parse(material.text); } catch { return undefined; }

  if (!isOrganizationEvidencePage(page)) return undefined;

  try {
    if (page.items.some(row => buildOrganizationRecord(scope, row.value).id !== row.factId)
      || canonicalJson(material) !== canonicalJson(createOrganizationEvidenceMaterial(scope, page))) return undefined;
  } catch { return undefined; }

  return page;
}
