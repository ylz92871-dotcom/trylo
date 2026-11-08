import type { CentralRuntimeMaterial } from "./contracts.js";
import { contentHashOf } from "../../control/hash.js";
import { fields, sequence } from "../../../validation/json-shape.js";
import { CENTRAL_USER_PEER_STATUS_ROLE, CENTRAL_USER_PEER_STATUS_PREFIX } from "./user-peer-status-contract.js";
import { isCentralAdvisoryContextMaterial } from "./advisory-material.js";

export const CENTRAL_AGENT_CAPABILITY_ROLE = "central_agent_research_capabilities_not_business_evidence";
export const CENTRAL_AGENT_CAPABILITY_PREFIX = "central-agent-research-capabilities:";

/** Only the exact host control envelope receives mandatory delivery priority. */
export function isCentralAgentResearchCapabilityMaterial(material: CentralRuntimeMaterial): boolean {
  if (material.kind !== "source" || material.sourceRefs.length !== 0
    || material.ref !== `${CENTRAL_AGENT_CAPABILITY_PREFIX}${contentHashOf(material.text)}`) return false;

  let value: unknown;

  try { value = JSON.parse(material.text); } catch { return false; }

  return fields(value, ["schemaVersion", "role", "interpretation", "input", "context", "capabilities", "boundary"])
    && value.schemaVersion === 1 && value.role === CENTRAL_AGENT_CAPABILITY_ROLE
    && typeof value.interpretation === "string" && typeof value.input === "string" && typeof value.context === "string"
    && Array.isArray(value.capabilities) && typeof value.boundary === "string";
}

const unreadRoles = new Set(["central_active_purpose_navigation", "central_source_body_not_delivered", "host_normal_turn_source_catalog_not_read_body",
  CENTRAL_AGENT_CAPABILITY_ROLE,
  CENTRAL_USER_PEER_STATUS_ROLE,
  "original_report_catalog_not_read_body", "original_domain_feedback_catalog_not_read_body",
  "original_native_feedback_change_catalog_not_read_body", "original_ended_purpose_navigation_not_new_evidence",
  "organization_feedback_relationship_catalog_not_read_body",
  "organization_feedback_not_delivered_capacity", "organization_recall_not_delivered_capacity",
  "organization_knowledge_publication_condition_not_published", "organization_knowledge_candidate_rejected_not_published",
  "organization_knowledge_candidate_not_published", "organization_knowledge_candidate_rejection_evidence_not_business_evidence",
  "organization_knowledge_revision_locator_not_read_body", "organization_publication_fragment_not_read_body",
  "PA_current_constraint_not_business_evidence"]);
const unreadPrefixes = [CENTRAL_AGENT_CAPABILITY_PREFIX, "central-active-purpose-catalog:", "central-source-navigation:", "central-runtime-catalog:", "central-runtime-domain-catalog:", "central-business-catalog:",
  "central-output-capacity-increase-feedback:",
  CENTRAL_USER_PEER_STATUS_PREFIX,
  "central-runtime-native-catalog:", "central-runtime-manifest:", "central-runtime-purpose-navigation:", "central-runtime-constraint:",
  "organization-feedback-relations:", "organization-capacity:", "organization-publication-condition:",
  "organization-publication-rejection:", "organization-publication-evidence:", "organization-candidate-view:",
  "organization-knowledge-revision-locator:", "organization-publication-fragment:"];
const transportPrefixes = ["central-runtime-fragment:", "central-source-page:", "central-page:"];
const isUnreadAddress = (value: unknown): boolean => typeof value === "string"
  && [...unreadPrefixes, ...transportPrefixes].some(prefix => value.startsWith(prefix));

/** Recognize only host-authenticated outer transport objects. Their text is
 * never parsed for roles: an ordinary source can quote any JSON it likes. */
function transportsNavigation(material: CentralRuntimeMaterial, value: unknown): boolean {
  if (material.ref.startsWith("central-runtime-fragment:")) {
    if (!(fields(value, ["originalRef", "start", "end", "totalChars", "text", "nextRef"])
    && typeof value.originalRef === "string" && typeof value.text === "string"
    && sequence(value.start) && sequence(value.end) && sequence(value.totalChars)
    && value.end > value.start && value.end - value.start === value.text.length && value.end <= value.totalChars
    && (value.nextRef === null || typeof value.nextRef === "string")
    && material.ref === `central-runtime-fragment:${contentHashOf([value.originalRef, value.start, value.text])}`)) return true;
    return isUnreadAddress(value.originalRef);
  }

  if (!material.ref.startsWith("central-source-page:")) return false;

  if (typeof value !== "object" || value === null) return true;

  const optional = ["nextRef", "originalSource"].filter(key => Object.hasOwn(value, key));
  if (!fields(value, ["role", "ref", "originalRef", "origin", "originalScope", "start", "end", "totalChars", "text",
    "sourceHash", "coordinate", "owner", "complete", ...optional]) || value.role !== "actual_source_fragment_not_full_source"
    || typeof value.ref !== "string" || typeof value.originalRef !== "string" || typeof value.text !== "string"
    || typeof value.originalScope !== "string" || typeof value.origin !== "string"
    || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || !["session", "board", "feedback", "domain_feedback"].includes(String(value.owner))
    || !fields(value.coordinate, ["runId", "sequence"]) || typeof value.coordinate.runId !== "string" || !sequence(value.coordinate.sequence)
    || !sequence(value.start) || !sequence(value.end) || !sequence(value.totalChars)
    || value.end <= value.start || value.end - value.start !== value.text.length || value.end > value.totalChars
    || value.complete !== (value.start === 0 && value.end === value.totalChars)
    || Object.hasOwn(value, "nextRef") && typeof value.nextRef !== "string") return true;

  const { role: _role, complete: _complete, nextRef: _nextRef, ...page } = value;

  return material.ref !== `central-source-page:${contentHashOf(page)}` || isUnreadAddress(value.originalRef) || isUnreadAddress(value.ref);
}

/** A directory may identify an unread source or a constraint, but cannot supply
 * an original-body quotation. Do not inspect nested raw user text for roles or
 * confuse an actual knowledge body with proof of quality or learning gain. */
export function isCentralUnreadNavigationMaterial(material: CentralRuntimeMaterial): boolean {
  if (isCentralAdvisoryContextMaterial(material)) return true;
  if (unreadPrefixes.some(prefix => material.ref.startsWith(prefix))) return true;
  let value: unknown;
  try { value = JSON.parse(material.text); } catch { return transportPrefixes.some(prefix => material.ref.startsWith(prefix)); }
  return transportsNavigation(material, value) || typeof value === "object" && value !== null && "role" in value
    && typeof value.role === "string" && unreadRoles.has(value.role);
}
