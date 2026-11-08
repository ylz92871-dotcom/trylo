import type { OrganizationKnowledge, OrganizationStored } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { isOrganizationKnowledge } from "../../learning/central/organization/validation.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";

const KNOWLEDGE_ROLE = "original_organization_knowledge_not_business_evidence";
const KNOWLEDGE_PREFIX = "organization-knowledge-view:";
const DELIVERY = /^central-deliberation-delivery:([a-f0-9]{64})$/;
const FACT = /^organization-record:([a-f0-9]{64})$/;
const indexValid = (index: number) => sequence(index) && index < CENTRAL_RUNTIME_LIMITS.knowledge;
const FRAGMENT_ROLE = "organization_publication_fragment_not_read_body";
const LOCATOR_ROLE = "organization_knowledge_revision_locator_not_read_body";
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fragmentText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768
  && [...value].every(character => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });

export interface OrganizationPublicationFragment {
  readonly originalRef: string;
  readonly originalReadRef: string;
  readonly sourceHash: string;
  readonly start: number;
  readonly end: number;
  readonly totalChars: number;
  readonly text: string;
  readonly nextRef: string | null;
}

/** One renderer also lets a revision locator check the exact fragment envelope. */
export function createOrganizationPublicationFragment(scope: string, body: OrganizationPublicationFragment,
  sourceRefs: readonly string[]): CentralRuntimeMaterial {
  const text = canonicalJson({ role: FRAGMENT_ROLE, ...body });
  return { ref: `organization-publication-fragment:${contentHashOf({ scope, text })}`, kind: "organization", text, sourceRefs };
}

export function organizationPublicationCandidateReadRef(deliveryRef: string, index: number, start = 0): string {
  const delivery = DELIVERY.exec(deliveryRef);
  if (delivery === null || !indexValid(index) || !sequence(start)) throw new Error("organization_publication_address_invalid");
  return `organization-publication-proposal:${delivery[1]}:${index}:${start}`;
}

export function organizationPublicationHeadReadRef(factId: string, start = 0): string {
  const fact = FACT.exec(factId);
  if (fact === null || !sequence(start)) throw new Error("organization_publication_address_invalid");
  return `organization-publication-head:${fact[1]}:${start}`;
}

function knowledgeView(scope: string, factId: string, value: OrganizationKnowledge): CentralRuntimeMaterial {
  if (buildOrganizationRecord(scope, value).id !== factId) throw new Error("organization_knowledge_view_fact_mismatch");
  // Sequence is a Board coordinate, not the immutable body's identity.
  const text = canonicalJson({ role: KNOWLEDGE_ROLE, factId, value });
  return { ref: `${KNOWLEDGE_PREFIX}${contentHashOf({ scope, text })}`, kind: "organization", text, sourceRefs: [factId] };
}

/** A complete original knowledge body. Its claim remains an organizing hypothesis. */
export function createOrganizationKnowledgeView(scope: string, stored: OrganizationStored<OrganizationKnowledge>): CentralRuntimeMaterial {
  return knowledgeView(scope, stored.factId, stored.value);
}

/** Only the complete canonical view proves its original knowledge identity.
 * A fragment or a navigation address does not establish that the body was read. */
export function readOrganizationKnowledgeView(material: CentralRuntimeMaterial, scope: string):
  { readonly factId: string; readonly value: OrganizationKnowledge } | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith(KNOWLEDGE_PREFIX)) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); }
  catch { return undefined; }

  if (!fields(body, ["role", "factId", "value"]) || body.role !== KNOWLEDGE_ROLE
    || !identity(body.factId) || !isOrganizationKnowledge(body.value)) return undefined;

  try {
    if (canonicalJson(material) !== canonicalJson(knowledgeView(scope, body.factId, body.value))) return undefined;
  } catch { return undefined; }

  return { factId: body.factId, value: body.value };
}

/** A canonical fragment locates its original owner, never attests unseen full text. */
export function readOrganizationPublicationFragment(material: CentralRuntimeMaterial, scope: string): OrganizationPublicationFragment | undefined {
  if (material.kind !== "organization" || material.text.length > 32768 || material.sourceRefs.length !== 1) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(body, ["role", "originalRef", "originalReadRef", "sourceHash", "start", "end", "totalChars", "text", "nextRef"])
    || body.role !== FRAGMENT_ROLE || typeof body.originalRef !== "string"
    || !hash(body.sourceHash) || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars)
    || body.end <= body.start || body.end > body.totalChars || !fragmentText(body.text)
    || body.text.length !== body.end - body.start) return undefined;

  const sourceRef = material.sourceRefs[0]!;

  try {
    let readRef: (start: number) => string;

    if (FACT.test(sourceRef) && /^organization-knowledge-view:[a-f0-9]{64}$/.test(body.originalRef)) {
      readRef = start => organizationPublicationHeadReadRef(sourceRef, start);
    } else if (DELIVERY.test(sourceRef) && /^organization-candidate-view:[a-f0-9]{64}$/.test(body.originalRef)
      && typeof body.originalReadRef === "string") {
      const proposal = /^organization-publication-proposal:([a-f0-9]{64}):(\d+):0$/.exec(body.originalReadRef);
      if (proposal === null) return undefined;
      const index = Number(proposal[2]);
      readRef = start => organizationPublicationCandidateReadRef(sourceRef, index, start);
    } else return undefined;

    const fragment: OrganizationPublicationFragment = { originalRef: body.originalRef,
      originalReadRef: readRef(0), sourceHash: body.sourceHash,
      start: body.start, end: body.end, totalChars: body.totalChars, text: body.text,
      nextRef: body.end < body.totalChars ? readRef(body.end) : null };
    if (canonicalJson(material) !== canonicalJson(createOrganizationPublicationFragment(scope, fragment, [sourceRef]))) return undefined;

    return fragment;
  } catch { return undefined; }
}

function readHeadFragment(material: CentralRuntimeMaterial, scope: string, factId: string): OrganizationPublicationFragment | undefined {
  const fragment = readOrganizationPublicationFragment(material, scope);
  return fragment !== undefined && fragment.totalChars > 32768 && material.sourceRefs[0] === factId
    && FACT.test(factId) ? fragment : undefined;
}

interface RevisionLocator {
  readonly factId: string;
  readonly knowledgeId: string;
  readonly bodyHash: string;
  readonly originalRef: string;
  readonly fragmentRef: string;
  readonly fragmentHash: string;
  readonly pageReadRef: string;
}

function revisionLocator(scope: string, locator: RevisionLocator): CentralRuntimeMaterial {
  const text = canonicalJson({ role: LOCATOR_ROLE, ...locator });
  return { ref: `organization-knowledge-revision-locator:${contentHashOf({ scope, text })}`, kind: "organization", text,
    sourceRefs: [locator.factId] };
}

/** Issued only beside an actual nonempty page of a verified large original head.
 * It locates supersedes; it does not deliver the complete head or its evidence. */
export function createOrganizationKnowledgeRevisionLocator(scope: string, original: CentralRuntimeMaterial,
  fragment: CentralRuntimeMaterial): CentralRuntimeMaterial {
  const knowledge = readOrganizationKnowledgeView(original, scope);
  const page = knowledge === undefined ? undefined : readHeadFragment(fragment, scope, knowledge.factId);
  if (knowledge === undefined || page === undefined || page.originalRef !== original.ref
    || page.sourceHash !== contentHashOf(original.text) || page.totalChars !== original.text.length
    || page.text !== original.text.slice(page.start, page.end)) throw new Error("organization_knowledge_revision_locator_invalid");

  return revisionLocator(scope, { factId: knowledge.factId, knowledgeId: knowledge.value.knowledgeId,
    bodyHash: page.sourceHash, originalRef: original.ref, fragmentRef: fragment.ref,
    fragmentHash: contentHashOf(fragment.text), pageReadRef: organizationPublicationHeadReadRef(knowledge.factId, page.start) });
}

/** A locator is usable only for revision addressing and only with its actual
 * same-batch canonical fragment. It grants no feedback or experience-use identity. */
export function readOrganizationKnowledgeRevisionLocator(material: CentralRuntimeMaterial, scope: string,
  deliveredMaterials: readonly CentralRuntimeMaterial[]): { readonly factId: string; readonly knowledgeId: string } | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith("organization-knowledge-revision-locator:")
    || material.text.length > 32768) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(body, ["role", "factId", "knowledgeId", "bodyHash", "originalRef", "fragmentRef", "fragmentHash", "pageReadRef"])
    || body.role !== LOCATOR_ROLE || typeof body.factId !== "string" || !FACT.test(body.factId)
    || !identity(body.knowledgeId) || !hash(body.bodyHash) || !hash(body.fragmentHash)
    || typeof body.originalRef !== "string" || typeof body.fragmentRef !== "string" || typeof body.pageReadRef !== "string") return undefined;

  const fragmentRef = body.fragmentRef;
  const fragments = deliveredMaterials.filter(item => item.ref === fragmentRef), fragment = fragments[0];
  if (fragment === undefined || fragments.some(item => canonicalJson(item) !== canonicalJson(fragment))) return undefined;

  const page = readHeadFragment(fragment, scope, body.factId);
  if (page === undefined || page.originalRef !== body.originalRef || page.sourceHash !== body.bodyHash
    || contentHashOf(fragment.text) !== body.fragmentHash) return undefined;

  try {
    const locator: RevisionLocator = { factId: body.factId, knowledgeId: body.knowledgeId, bodyHash: body.bodyHash,
      originalRef: body.originalRef, fragmentRef: body.fragmentRef, fragmentHash: body.fragmentHash,
      pageReadRef: organizationPublicationHeadReadRef(body.factId, page.start) };
    if (canonicalJson(material) !== canonicalJson(revisionLocator(scope, locator))) return undefined;
  } catch { return undefined; }

  return { factId: body.factId, knowledgeId: body.knowledgeId };
}

/** This is the original model proposal, not a committed knowledge fact or evidence. */
export function createOrganizationCandidateView(scope: string, deliveryRef: string, index: number,
  knowledge: OrganizationKnowledge): CentralRuntimeMaterial {
  organizationPublicationCandidateReadRef(deliveryRef, index);
  const candidateFactId = buildOrganizationRecord(scope, knowledge).id;
  const text = canonicalJson({ role: "organization_knowledge_candidate_not_published", deliveryRef, index,
    candidateFactId, value: knowledge });
  return { ref: `organization-candidate-view:${contentHashOf({ scope, text })}`, kind: "organization", text, sourceRefs: [deliveryRef] };
}

export function readOrganizationCandidateView(material: CentralRuntimeMaterial, scope: string):
  { readonly deliveryRef: string; readonly index: number; readonly candidateFactId: string; readonly value: OrganizationKnowledge } | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith("organization-candidate-view:")) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(body, ["role", "deliveryRef", "index", "candidateFactId", "value"])
    || body.role !== "organization_knowledge_candidate_not_published" || typeof body.deliveryRef !== "string"
    || !sequence(body.index) || !indexValid(body.index) || typeof body.candidateFactId !== "string" || !isOrganizationKnowledge(body.value)) return undefined;

  try {
    const canonical = createOrganizationCandidateView(scope, body.deliveryRef, body.index, body.value);
    if (buildOrganizationRecord(scope, body.value).id !== body.candidateFactId || canonicalJson(canonical) !== canonicalJson(material)) return undefined;
  } catch { return undefined; }

  return { deliveryRef: body.deliveryRef, index: body.index, candidateFactId: body.candidateFactId, value: body.value };
}
