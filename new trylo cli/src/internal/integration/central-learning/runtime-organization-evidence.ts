import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { readOrganizationEvidenceRef, readOrganizationKnowledgeHeadRef } from "../../learning/central/organization/addresses.js";
import { createCentralOrganizationService, type CentralOrganizationOptions } from "./organization-service.js";
import { createOrganizationEvidenceMaterial } from "./organization-evidence-material.js";
import { readOrganizationPublicationMemory } from "./organization-publication-read.js";
import { organizationPublicationHeadReadRef } from "./organization-publication-view.js";

/** Core recall addresses delegate to the same original Board/head owners. The
 * requested address is not reused as the identity of a changing bounded body. */
export async function readCentralOrganizationEvidence(options: CentralOrganizationOptions, ref: string,
  signal: AbortSignal, maximumChars: number): Promise<readonly CentralRuntimeMaterial[] | undefined> {
  const head = readOrganizationKnowledgeHeadRef(ref);
  if (head !== undefined) return readOrganizationPublicationMemory(options, organizationPublicationHeadReadRef(head.factId, head.start), signal, maximumChars);

  const address = readOrganizationEvidenceRef(ref);
  if (address === undefined) return undefined;

  const loaded = await createCentralOrganizationService(options).readRecallEvidence({ ...address,
    maximumCharacters: Math.min(24000, maximumChars) }, signal);
  if (loaded.status !== "ready") throw new Error(loaded.status === "rejected" ? loaded.reason : "organization_disabled");

  return [createOrganizationEvidenceMaterial(options.scope, loaded.page)];
}
