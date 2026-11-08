import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { organizationPublicationHeadReadRef } from "./organization-publication-view.js";

export { organizationPublicationHeadReadRef } from "./organization-publication-view.js";

export const ORGANIZATION_PUBLICATION_CONDITION_PREFIX = "organization-publication-condition:";
export const ORGANIZATION_PUBLICATION_CONDITION_ROLE = "organization_knowledge_publication_condition_not_published";

export type OrganizationCandidateRejectionReason = "organization_knowledge_revision_conflict" | "organization_knowledge_source_not_current";

export interface OrganizationPublicationCondition {
  readonly knowledgeId: string;
  readonly currentHeadFactId: string | null;
  readonly reason: OrganizationCandidateRejectionReason;
}

const factId = (value: unknown): value is string => typeof value === "string" && /^organization-record:[a-f0-9]{64}$/.test(value);
const rejectionReason = (value: unknown): value is OrganizationCandidateRejectionReason =>
  value === "organization_knowledge_revision_conflict" || value === "organization_knowledge_source_not_current";

/** One stable repair condition, independent of proposal wording, citation order,
 * delivery identity or unrelated Board arrivals. It asserts no head-body read. */
export function createOrganizationPublicationCondition(scope: string, value: OrganizationPublicationCondition): CentralRuntimeMaterial {
  if (!identity(value.knowledgeId) || value.currentHeadFactId !== null && !factId(value.currentHeadFactId) || !rejectionReason(value.reason)) {
    throw new Error("organization_publication_condition_invalid");
  }

  const text = canonicalJson({ role: ORGANIZATION_PUBLICATION_CONDITION_ROLE, knowledgeId: value.knowledgeId,
    currentHeadFactId: value.currentHeadFactId, reason: value.reason,
    readRef: value.currentHeadFactId === null ? null : organizationPublicationHeadReadRef(value.currentHeadFactId),
    instruction: "An original organization knowledge candidate was not published. Inspect its associated rejection details, original proposal, current knowledge head and effective feedback before choosing a correction. Retain knowledgeId and explicitly cite the verified prior fact when revising; never infer that this notice delivered the head body, supplied business evidence or published knowledge. The same condition does not authorize repeated paid repair." });

  return { ref: `${ORGANIZATION_PUBLICATION_CONDITION_PREFIX}${contentHashOf([scope, value.knowledgeId, value.currentHeadFactId, value.reason])}`,
    kind: "organization", text, sourceRefs: [] };
}

export function readOrganizationPublicationCondition(material: CentralRuntimeMaterial, scope: string): OrganizationPublicationCondition | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith(ORGANIZATION_PUBLICATION_CONDITION_PREFIX)) return undefined;

  let raw: unknown;

  try { raw = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(raw, ["role", "knowledgeId", "currentHeadFactId", "reason", "readRef", "instruction"])
    || raw.role !== ORGANIZATION_PUBLICATION_CONDITION_ROLE || !identity(raw.knowledgeId)
    || raw.currentHeadFactId !== null && !factId(raw.currentHeadFactId) || !rejectionReason(raw.reason)) return undefined;

  const value = { knowledgeId: raw.knowledgeId, currentHeadFactId: raw.currentHeadFactId, reason: raw.reason };

  return canonicalJson(createOrganizationPublicationCondition(scope, value)) === canonicalJson(material) ? value : undefined;
}
