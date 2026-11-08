import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { isOrganizationFeedback, isOrganizationKnowledge } from "../../learning/central/organization/validation.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { fields, sequence } from "../../validation/json-shape.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { readOrganizationEvidenceMaterial } from "./organization-evidence-material.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { readOrganizationKnowledgeRevisionLocator, readOrganizationKnowledgeView } from "./organization-publication-view.js";
import { deliveredOrganizationRecallPacket } from "./runtime-organization-memory.js";

/** The same exact-material conflict rule used when packing the delivered request. */
export function centralInputMaterials(request: CentralDeliberationRequest): readonly CentralRuntimeMaterial[] {
  const materials = new Map<string, CentralRuntimeMaterial>();

  for (const material of [...request.materials, ...request.organization, ...request.state.materials]) {
    const before = materials.get(material.ref);
    if (before !== undefined && canonicalJson(before) !== canonicalJson(material)) {
      throw new CentralDeliberationError("central_deliberation_material_identity_conflict");
    }
    materials.set(material.ref, material);
  }

  return [...materials.values()];
}

/** Original provenance inventory shared by input rendering and output binding. */
export function centralOrganizationInputInventory(request: CentralDeliberationRequest): {
  feedback: Set<string>; knowledge: Map<string, string>; recalls: Map<string, Set<string>>;
  knowledgeBodies: Map<string, OrganizationKnowledge>;
  byMaterial: Map<string, { feedback: ReadonlySet<string>; knowledge: ReadonlySet<string>; recalls: ReadonlySet<string> }>;
} {
  const feedback = new Set<string>(), knowledge = new Map<string, string>(), recalls = new Map<string, Set<string>>();
  const knowledgeBodies = new Map<string, OrganizationKnowledge>();
  const byMaterial = new Map<string, { feedback: Set<string>; knowledge: Set<string>; recalls: Set<string> }>();
  const delivered = [...request.organization, ...request.materials, ...request.state.materials];

  for (const material of delivered) {
    if (material.kind !== "organization") continue;

    const links = byMaterial.get(material.ref) ?? { feedback: new Set<string>(), knowledge: new Set<string>(), recalls: new Set<string>() };
    const addFeedback = (factId: string): void => {
      feedback.add(factId);
      links.feedback.add(factId);
      byMaterial.set(material.ref, links);
    };
    const setKnowledgeBody = (factId: string, value: OrganizationKnowledge): void => {
      knowledgeBodies.set(factId, value);
      links.knowledge.add(factId);
      byMaterial.set(material.ref, links);
    };
    const setRecall = (entries: Set<string>): void => {
      recalls.set(material.ref, entries);
      links.recalls.add(material.ref);
      byMaterial.set(material.ref, links);
    };

    if (material.ref.startsWith("organization-evidence-page:")) {
      const page = readOrganizationEvidenceMaterial(material, request.scope);
      if (page !== undefined) for (const row of page.items) addFeedback(row.factId);
      continue; // An unread descriptor or citation list is not a feedback body.
    }

    if (material.ref.startsWith("organization-knowledge-view:")) {
      const head = readOrganizationKnowledgeView(material, request.scope);
      if (head !== undefined) {
        knowledge.set(head.factId, head.value.knowledgeId);
        setKnowledgeBody(head.factId, head.value);
      }
      continue; // Only this complete canonical head may supply its revision identity.
    }

    if (material.ref.startsWith("organization-knowledge-revision-locator:")) {
      const locator = readOrganizationKnowledgeRevisionLocator(material, request.scope, delivered);
      if (locator !== undefined) knowledge.set(locator.factId, locator.knowledgeId);
      continue; // Paired actual page locates supersedes, never feedback or full experience use.
    }

    if (["organization-candidate-view:", "organization-publication-condition:", "organization-publication-rejection:",
      "organization-publication-evidence:", "organization-publication-fragment:"].some(prefix => material.ref.startsWith(prefix))) continue;

    const presented = readOrganizationFeedbackMaterial(material, request.scope);

    if (material.ref.startsWith("organization-feedback-material:")) {
      if (presented !== undefined) addFeedback(presented.factId);
      continue; // A malformed canonical view cannot borrow a legacy fact identity.
    }

    let body: unknown;

    try { body = JSON.parse(material.text); }
    catch { continue; } // Non-JSON public prose grants no organization evidence identity.

    if (typeof body === "object" && body !== null && "schemaVersion" in body && body.schemaVersion === 2) {
      const packet = deliveredOrganizationRecallPacket(material, request.scope, delivered);
      if (packet?.schemaVersion === 2) {
        const entries = new Set<string>();

        for (const entry of packet.entries) {
          entries.add(entry.factId);
          knowledge.set(entry.factId, entry.knowledge.knowledgeId);
          setKnowledgeBody(entry.factId, entry.knowledge);
          for (const row of entry.evidence) addFeedback(row.factId);
        }

        setRecall(entries);
      }

      continue; // V2 must pass the closed canonical packet; never borrow V1 privileges.
    }

    if (isOrganizationFeedback(body)) addFeedback(material.ref);

    if (fields(body, ["role", "factId", "sequence", "value"])
      && body.role === "source_bound_organization_feedback_not_identified_economic_gain" && body.factId === material.ref
      && sequence(body.sequence) && isOrganizationFeedback(body.value)) addFeedback(material.ref);

    const recallMetadata = typeof body === "object" && body !== null
      ? ["navigation", "omittedForCapacity", "costInterpretation", "retrievalGuidance"].filter(key => Object.hasOwn(body, key)) : [];
    if (fields(body, ["role", "entries", ...recallMetadata])
      && body.role === "organization_hypotheses_not_business_evidence" && Array.isArray(body.entries)) {
      const entries = new Set<string>();

      for (const entry of body.entries) {
        if (typeof entry !== "object" || entry === null || !("factId" in entry) || typeof entry.factId !== "string"
          || !("knowledge" in entry) || !isOrganizationKnowledge(entry.knowledge) || !("evidence" in entry) || !Array.isArray(entry.evidence)) continue;

        entries.add(entry.factId);
        knowledge.set(entry.factId, entry.knowledge.knowledgeId);
        setKnowledgeBody(entry.factId, entry.knowledge);

        for (const fact of entry.evidence) {
          if (typeof fact === "object" && fact !== null && "factId" in fact && typeof fact.factId === "string"
            && "value" in fact && isOrganizationFeedback(fact.value)) addFeedback(fact.factId);
        }
      }

      setRecall(entries);
    }
  }

  return { feedback, knowledge, recalls, knowledgeBodies, byMaterial };
}
