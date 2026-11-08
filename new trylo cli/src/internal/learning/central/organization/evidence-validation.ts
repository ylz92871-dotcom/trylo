import { fields, identity, list, sequence } from "../../../validation/json-shape.js";
import { isOrganizationFeedback } from "./validation.js";
import { organizationEvidenceReadRef } from "./addresses.js";
import type { OrganizationEvidencePage, OrganizationEvidenceRole } from "./retrieval-evidence.js";

export function isOrganizationEvidenceRole(value: unknown): value is OrganizationEvidenceRole {
  return value === "registered_support" || value === "registered_counterexample"
    || value === "exact_exposure_context" || value === "same_decision_related_not_causal";
}

const roles = (value: unknown) => list(value, 1, 4) && value.every(isOrganizationEvidenceRole) && new Set(value).size === value.length;
const citations = (value: unknown) => list(value, 0, 128) && value.every(identity) && new Set(value).size === value.length;

/** Shape only. The transport owner separately rebuilds each complete original
 * fact and the canonical material identity before granting any citation. */
export function isOrganizationEvidencePage(value: unknown): value is OrganizationEvidencePage {
  if (!fields(value, ["schemaVersion", "role", "knowledgeFactId", "asOfSequence", "offset", "total", "items", "notDelivered", "nextReadRef", "interpretation"])) return false;

  const asOfSequence = value.asOfSequence;
  if (!sequence(asOfSequence) || value.schemaVersion !== 1 || value.role !== "organization_feedback_evidence_page_not_quality_verdict"
    || !identity(value.knowledgeFactId) || !sequence(value.offset) || !sequence(value.total)
    || !list(value.items, 0, 64) || !value.items.every(row => fields(row, ["factId", "sequence", "value", "roles", "citedFactIds"])
      && identity(row.factId) && sequence(row.sequence) && row.sequence <= asOfSequence
      && isOrganizationFeedback(row.value) && roles(row.roles) && citations(row.citedFactIds))
    || !list(value.notDelivered, 0, 64) || value.items.length + value.notDelivered.length > 64
    || !value.notDelivered.every(row => fields(row, ["factId", "readRef", "originalCharacters", "roles", "citedFactIds"])
      && identity(row.factId) && row.readRef === row.factId && sequence(row.originalCharacters) && row.originalCharacters > 0
      && roles(row.roles) && citations(row.citedFactIds))
    || value.interpretation !== "unread_is_unknown_adoption_is_exposure_not_validation") return false;

  const through = value.offset + value.items.length + value.notDelivered.length;
  if (through > value.total || through < value.total && through === value.offset) return false;

  try { return value.nextReadRef === (through < value.total ? organizationEvidenceReadRef(value.knowledgeFactId, asOfSequence, through) : null); }
  catch { return false; }
}
