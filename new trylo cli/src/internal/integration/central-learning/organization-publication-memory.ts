import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { sequence } from "../../validation/json-shape.js";
import type { CentralOrganizationOptions } from "./organization-service.js";
import { createOrganizationPublicationProjection } from "./organization-publication-projection.js";

export function organizationPublicationReturnReadRef(resultFactId: string, candidateIndex: number): string {
  const fact = /^organization-publication-result:([a-f0-9]{64})$/.exec(resultFactId);
  if (fact === null || !sequence(candidateIndex) || candidateIndex >= 64) throw new Error("organization_publication_address_invalid");
  return `organization-publication-return:${fact[1]}:${candidateIndex}`;
}

/** Exact reconstruction from the committed result and its original immutable
 * delivery/prefix. Reading a historical refusal does not submit the candidate. */
export async function readOrganizationPublicationReturnMemory(options: CentralOrganizationOptions, ref: string,
  signal: AbortSignal, maximumChars: number): Promise<readonly CentralRuntimeMaterial[] | undefined> {
  const returns = ref.startsWith("organization-publication-return:");
  const evidence = ref.startsWith("organization-publication-evidence:");
  if (!returns && !evidence) return undefined;

  if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 100000) throw new Error("organization_publication_capacity");

  const matched = returns ? /^organization-publication-return:([a-f0-9]{64}):(\d+)$/.exec(ref)
    : /^organization-publication-evidence:([a-f0-9]{64}):(\d+):(\d+)$/.exec(ref);
  if (matched === null) throw new Error("organization_publication_address_invalid");

  const resultFactId = `organization-publication-result:${matched[1]}`, index = Number(matched[2]);
  const offset = returns ? 0 : Number(matched[3]);
  if (organizationPublicationReturnReadRef(resultFactId, index) !== `organization-publication-return:${matched[1]}:${matched[2]}`
    || evidence && (!sequence(offset) || offset < 16 || offset > 112 || offset % 16 !== 0 || String(offset) !== matched[3])) {
    throw new Error("organization_publication_address_invalid");
  }

  const projected = await createOrganizationPublicationProjection(options).read(resultFactId, index, signal);
  if (projected === undefined) throw new Error("organization_publication_missing");

  const page = evidence ? projected.evidence[offset / 16 - 1] : undefined;
  if (evidence && page === undefined) throw new Error("organization_publication_missing");

  const materials = page === undefined ? [projected.condition, projected.detail] : [page];
  const needed = materials.reduce((sum, material) => sum + material.text.length, 0);
  if (needed <= maximumChars) return materials;

  const text = canonicalJson({ role: "organization_publication_not_delivered_capacity", readRef: ref, minimumCharacters: needed,
    instruction: "No complete rejection condition or original evidence body was delivered. Read this exact address with sufficient capacity; this notice grants no correction consumption, knowledge or feedback identity." });
  if (text.length > maximumChars) throw new Error("organization_publication_capacity");

  return [{ ref: `organization-capacity:${contentHashOf(text)}`, kind: "organization", text, sourceRefs: [] }];
}
