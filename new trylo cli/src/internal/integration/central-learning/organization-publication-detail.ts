import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isCentralLearningSubject } from "../../learning/central/runtime/validation.js";
import type { CentralLearningSubject } from "../../learning/central/runtime/contracts.js";
import type { OrganizationPublicationBindings } from "./organization-publication-bindings.js";
import { createOrganizationPublicationCondition, organizationPublicationHeadReadRef,
  type OrganizationPublicationCondition } from "./organization-publication-material.js";

const PREFIX = "organization-publication-rejection:";

export interface OrganizationPublicationRejectionDetail extends OrganizationPublicationCondition {
  readonly conditionRef: string; readonly operationId: string; readonly budgetId: string; readonly decisionRef: string;
  readonly deliveryRef: string; readonly candidateIndex: number; readonly candidateHash: string;
  readonly candidateFactId: string; readonly candidateReadRef: string; readonly verifiedRevision: number;
  readonly currentHead: { readonly factId: string; readonly knowledgeId: string; readonly readRef: string } | null;
  readonly evidenceRevisions: readonly { readonly citedFactId: string; readonly effectiveFactId: string | null }[];
  readonly evidenceCount: number; readonly evidenceReadRefs: readonly string[];
  readonly bindings: OrganizationPublicationBindings;
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fact = (value: unknown): value is string => typeof value === "string" && /^organization-record:[a-f0-9]{64}$/.test(value);
const delivery = (value: unknown): value is string => typeof value === "string" && /^central-deliberation-delivery:[a-f0-9]{64}$/.test(value);
const role = "organization_knowledge_candidate_rejected_not_published";

function readBindings(value: unknown): OrganizationPublicationBindings | undefined {
  if (!fields(value, ["state", "intentIds", "subjects"]) || value.state !== "bound" && value.state !== "unbound"
    || !Array.isArray(value.intentIds) || value.intentIds.length > 128 || !Array.isArray(value.subjects) || value.subjects.length > 128) return undefined;

  const intentIds: string[] = [], subjects: CentralLearningSubject[] = [];

  for (const id of value.intentIds) {
    if (!identity(id)) return undefined;
    intentIds.push(id);
  }

  for (const subject of value.subjects) {
    if (!isCentralLearningSubject(subject)) return undefined;
    subjects.push(subject);
  }

  if (new Set(intentIds).size !== intentIds.length || new Set(subjects.map(canonicalJson)).size !== subjects.length
    || (value.state === "unbound") !== (intentIds.length === 0) || value.state === "unbound" && subjects.length > 0) return undefined;

  return { state: value.state, intentIds, subjects };
}

function readEvidence(value: unknown): OrganizationPublicationRejectionDetail["evidenceRevisions"] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;

  const rows: { citedFactId: string; effectiveFactId: string | null }[] = [];

  for (const row of value) {
    if (!fields(row, ["citedFactId", "effectiveFactId"]) || !identity(row.citedFactId)
      || row.effectiveFactId !== null && !fact(row.effectiveFactId)) return undefined;
    rows.push({ citedFactId: row.citedFactId, effectiveFactId: row.effectiveFactId });
  }

  return rows;
}

export function createOrganizationPublicationRejection(scope: string, value: OrganizationPublicationRejectionDetail): CentralRuntimeMaterial {
  const reads = [...new Set([value.candidateReadRef, ...(value.currentHead === null ? [] : [value.currentHead.readRef]),
    ...value.evidenceReadRefs, ...value.evidenceRevisions.flatMap(row => [row.citedFactId, row.effectiveFactId].filter(fact))])]
    .map(readRef => ({ readRef }));
  const text = canonicalJson({ role, ...value, reads });
  if (text.length > 32768) throw new Error("organization_publication_receipt_capacity");
  return { ref: `${PREFIX}${contentHashOf([scope, text])}`, kind: "organization", text, sourceRefs: [value.deliveryRef] };
}

/** A rejection proves only that this candidate was not published at its checked
 * prefix. It cannot grant knowledge, feedback or an actual-head-read identity. */
export function readOrganizationPublicationRejection(material: CentralRuntimeMaterial, scope: string): OrganizationPublicationRejectionDetail | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith(PREFIX)) return undefined;

  let raw: unknown;

  try { raw = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(raw, ["role", "knowledgeId", "currentHeadFactId", "reason", "conditionRef", "operationId", "budgetId", "decisionRef",
    "deliveryRef", "candidateIndex", "candidateHash", "candidateFactId", "candidateReadRef", "verifiedRevision", "currentHead",
    "evidenceRevisions", "evidenceCount", "evidenceReadRefs", "reads", "bindings"]) || raw.role !== role
    || !identity(raw.knowledgeId) || !identity(raw.operationId) || !identity(raw.budgetId) || !identity(raw.decisionRef)
    || !delivery(raw.deliveryRef) || !sequence(raw.candidateIndex) || raw.candidateIndex >= 64
    || !hash(raw.candidateHash) || !fact(raw.candidateFactId) || !sequence(raw.verifiedRevision)
    || raw.currentHeadFactId !== null && !fact(raw.currentHeadFactId)
    || raw.reason !== "organization_knowledge_revision_conflict" && raw.reason !== "organization_knowledge_source_not_current"
    || raw.candidateReadRef !== `organization-publication-proposal:${raw.deliveryRef.slice("central-deliberation-delivery:".length)}:${raw.candidateIndex}:0`
    || !Array.isArray(raw.evidenceRevisions) || raw.evidenceRevisions.length > 16
    || !raw.evidenceRevisions.every(row => fields(row, ["citedFactId", "effectiveFactId"])
      && identity(row.citedFactId) && (row.effectiveFactId === null || fact(row.effectiveFactId)))
    || !sequence(raw.evidenceCount) || raw.evidenceCount < raw.evidenceRevisions.length || raw.evidenceCount > 128
    || !Array.isArray(raw.evidenceReadRefs) || raw.evidenceReadRefs.length > 7
    || !raw.evidenceReadRefs.every(ref => typeof ref === "string" && /^organization-publication-evidence:[a-f0-9]{64}:\d+:\d+$/.test(ref))) return undefined;

  const condition: OrganizationPublicationCondition = { knowledgeId: raw.knowledgeId, currentHeadFactId: raw.currentHeadFactId, reason: raw.reason };
  const conditionRef = createOrganizationPublicationCondition(scope, condition).ref;
  const evidenceRevisions = readEvidence(raw.evidenceRevisions);
  const bindings = readBindings(raw.bindings);
  if (evidenceRevisions === undefined || bindings === undefined || raw.conditionRef !== conditionRef
    || raw.currentHeadFactId === null && raw.currentHead !== null
    || raw.currentHeadFactId !== null && (!fields(raw.currentHead, ["factId", "knowledgeId", "readRef"])
      || raw.currentHead.factId !== raw.currentHeadFactId || raw.currentHead.knowledgeId !== raw.knowledgeId
      || raw.currentHead.readRef !== organizationPublicationHeadReadRef(raw.currentHeadFactId))) return undefined;

  const parsed: OrganizationPublicationRejectionDetail = { ...condition, conditionRef,
    operationId: raw.operationId, budgetId: raw.budgetId, decisionRef: raw.decisionRef,
    deliveryRef: raw.deliveryRef, candidateIndex: raw.candidateIndex, candidateHash: raw.candidateHash,
    candidateFactId: raw.candidateFactId,
    candidateReadRef: `organization-publication-proposal:${raw.deliveryRef.slice("central-deliberation-delivery:".length)}:${raw.candidateIndex}:0`,
    verifiedRevision: raw.verifiedRevision, currentHead: raw.currentHeadFactId === null ? null : {
      factId: raw.currentHeadFactId, knowledgeId: raw.knowledgeId, readRef: organizationPublicationHeadReadRef(raw.currentHeadFactId) },
    evidenceRevisions, evidenceCount: raw.evidenceCount, bindings,
    evidenceReadRefs: raw.evidenceReadRefs.flatMap(ref => typeof ref === "string" ? [ref] : []) };

  try { return canonicalJson(createOrganizationPublicationRejection(scope, parsed)) === canonicalJson(material) ? parsed : undefined; }
  catch { return undefined; }
}

export function createOrganizationPublicationEvidence(scope: string, input: { readonly conditionRef: string; readonly deliveryRef: string;
  readonly candidateIndex: number; readonly offset: number; readonly total: number;
  readonly evidenceRevisions: OrganizationPublicationRejectionDetail["evidenceRevisions"] }): CentralRuntimeMaterial {
  const reads = [...new Set(input.evidenceRevisions.flatMap(row => [row.citedFactId, row.effectiveFactId].filter(fact)))].map(readRef => ({ readRef }));
  const text = canonicalJson({ role: "organization_knowledge_candidate_rejection_evidence_not_business_evidence", ...input, reads });
  if (text.length > 32768) throw new Error("organization_publication_receipt_capacity");
  return { ref: `organization-publication-evidence:${contentHashOf([scope, text])}`, kind: "organization", text, sourceRefs: [input.deliveryRef] };
}
