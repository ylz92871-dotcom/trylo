import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationRecallPacket } from "../../learning/central/organization/contracts.js";
import { isOrganizationRecallPacket, isOrganizationRecallQuery } from "../../learning/central/organization/validation.js";
import { fields } from "../../validation/json-shape.js";
import { createCentralOrganizationService, type CentralOrganizationOptions } from "./organization-service.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { readOrganizationPublicationMemory } from "./organization-publication-read.js";
import { readOrganizationPublicationReturnMemory } from "./organization-publication-memory.js";
import { readCentralOrganizationEvidence } from "./runtime-organization-evidence.js";

const PREFIX = "central-organization-known:";

/** A manual read retains its actual query with the delivered body. Reconstruct
 * only the public packet; the original organization writer still verifies it
 * against the authoritative source prefix before freezing any claimed use. */
export function deliveredOrganizationRecallPacket(material: CentralRuntimeMaterial, scope: string,
  delivered: readonly CentralRuntimeMaterial[] = []): OrganizationRecallPacket | undefined {
  if (material.kind !== "organization") return undefined;

  let raw: unknown;

  try { raw = JSON.parse(material.text); }
  catch { return undefined; } // Prose and incomplete pages establish no packet.

  if (typeof raw !== "object" || raw === null || !("entries" in raw)
    || !("role" in raw) || raw.role !== "organization_hypotheses_not_business_evidence") return undefined;

  for (const context of delivered) {
    if (context.kind !== "organization" || context.ref !== `organization-query:${contentHashOf(context.text)}`) continue;

    let query: unknown;

    try { query = JSON.parse(context.text); }
    catch { continue; } // An incomplete query page cannot bind the recall body.

    if (!fields(query, ["role", "query", "recallRef"]) || query.role !== "organization_retrieval_context_not_business_evidence"
      || query.recallRef !== material.ref || !isOrganizationRecallQuery(query.query)) continue;

    const packet = { schemaVersion: "schemaVersion" in raw ? raw.schemaVersion : 1, scope, recallRef: material.ref, query: query.query, entries: raw.entries,
      materialJson: material.text, interpretation: raw.role, ...("navigation" in raw ? { navigation: raw.navigation } : {}),
      ...("evidencePolicy" in raw ? { evidencePolicy: raw.evidencePolicy } : {}),
      ...("knowledgeBodyRequired" in raw ? { knowledgeBodyRequired: raw.knowledgeBodyRequired } : {}) };
    if (isOrganizationRecallPacket(packet)) return packet;
  }

  return undefined;
}

export function organizationRecallMaterialMatches(packet: OrganizationRecallPacket, material: CentralRuntimeMaterial): boolean {
  return material.kind === "organization" && material.ref === packet.recallRef
    && material.text === packet.materialJson;
}

/** A short purpose is a bounded read request, never a cached packet or evidence. */
export function centralOrganizationQueryRef(purpose: string, offset = 0): string {
  if (purpose.trim().length === 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > 4096) {
    throw new Error("central_organization_query_invalid");
  }
  const ref = `${PREFIX}${offset}:${encodeURIComponent(purpose)}`;
  if (ref.length > 512) throw new Error("central_organization_query_capacity");
  return ref;
}

export function organizationRecallNavigationMaterial(): CentralRuntimeMaterial {
  const text = canonicalJson({ role: "organization_hypothesis_navigation_not_business_evidence",
    instruction: "To search more organization experience, read central-organization-known:<offset>:<URI-encoded short purpose>. Start offset at 0; use the returned navigation.nextQuery.offset to continue. Use a short current purpose, including conditions or exceptions you want to inspect. Text resemblance only navigates hypotheses; compare original conditions, counterexamples and effective corrections before use.",
    exampleReadRef: centralOrganizationQueryRef("tool parameter contract uncertainty") });
  return { ref: `organization-navigation:${contentHashOf(text)}`, kind: "organization", text, sourceRefs: [] };
}

export function readCentralOrganizationQueryRef(ref: string): { readonly purpose: string; readonly offset: number } | undefined {
  if (!ref.startsWith(PREFIX)) return undefined;

  const address = /^(\d+):(.+)$/.exec(ref.slice(PREFIX.length));
  if (address === null) throw new Error("central_organization_query_invalid");

  let purpose: string;

  try { purpose = decodeURIComponent(address[2]!); }
  catch { throw new Error("central_organization_query_invalid"); }

  const offset = Number(address[1]);
  if (centralOrganizationQueryRef(purpose, offset) !== ref) throw new Error("central_organization_query_invalid");

  return { purpose, offset };
}

/** Production source reader delegates to the original organization Board owner.
 * Search creates no fact, reservation, wake notice, memory database or permission. */
export async function readCentralOrganizationMemory(options: CentralOrganizationOptions, ref: string,
  signal: AbortSignal, maximumChars = 100000): Promise<readonly CentralRuntimeMaterial[] | undefined> {
  const evidence = await readCentralOrganizationEvidence(options, ref, signal, maximumChars);
  if (evidence !== undefined) return evidence;

  const returned = await readOrganizationPublicationReturnMemory(options, ref, signal, maximumChars);
  if (returned !== undefined) return returned;

  const publication = await readOrganizationPublicationMemory(options, ref, signal, maximumChars);
  if (publication !== undefined) return publication;

  if (ref.startsWith("organization-record:")) {
    if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 100000) throw new Error("central_organization_query_capacity");

    const loaded = await createCentralOrganizationService(options).readFeedback(ref, signal);
    if (loaded.status !== "ready") throw new Error(loaded.status === "rejected" ? loaded.reason : "organization_disabled");

    if (loaded.feedback === null) return undefined;

    const material = createOrganizationFeedbackMaterial(options.scope, loaded.feedback.factId, loaded.feedback.value);
    if (material.text.length <= maximumChars) return [material];

    const text = canonicalJson({ role: "organization_feedback_not_delivered_capacity", readRef: ref,
      minimumCharacters: material.text.length, explanation: "No original feedback body was delivered. Read the original fact with sufficient maximumChars; this notice grants no feedback support identity." });
    if (text.length > maximumChars) throw new Error("central_organization_query_capacity");

    return [{ ref: `organization-capacity:${contentHashOf(text)}`, kind: "organization", text, sourceRefs: [] }];
  }

  const address = readCentralOrganizationQueryRef(ref);
  if (address === undefined) return undefined;

  if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 100000) throw new Error("central_organization_query_capacity");

  const { purpose, offset } = address;
  const recalled = await createCentralOrganizationService(options).prepareRecall({ purpose, conditionKeys: [], sourceRefs: [],
    maximumEntries: 8, maximumCharacters: 24000, offset }, signal);
  if (recalled.status !== "ready") throw new Error(recalled.status === "rejected" ? recalled.reason : "organization_disabled");

  const queryText = canonicalJson({ role: "organization_retrieval_context_not_business_evidence",
    query: recalled.packet.query, recallRef: recalled.packet.recallRef });
  const needed = queryText.length + recalled.packet.materialJson.length;
  if (needed > maximumChars) {
    const text = canonicalJson({ role: "organization_recall_not_delivered_capacity", readRef: ref, minimumCharacters: needed,
      explanation: "No organization entry or evidence was delivered. Read this query with sufficient maximumChars to receive a complete packet; fragments cannot establish actual experience use." });
    if (text.length > maximumChars) throw new Error("central_organization_query_capacity");
    return [{ ref: `organization-capacity:${contentHashOf(text)}`, kind: "organization", text, sourceRefs: [] }];
  }

  return [{ ref: `organization-query:${contentHashOf(queryText)}`, kind: "organization", text: queryText, sourceRefs: [] },
    { ref: recalled.packet.recallRef, kind: "organization", text: recalled.packet.materialJson,
      sourceRefs: [recalled.packet.recallRef, ...recalled.packet.entries.map(entry => entry.factId)] }];
}
