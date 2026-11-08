import { contentHashOf } from "../../../../../control/hash.js";
import { checkerExposureFingerprints } from "../../domain/v2/exposure.js";
import type { CheckInput } from "../../domain/v2/contracts.js";
import type { CheckerCatalog } from "./contracts.js";

/** Expand legacy full-input hashes without rewriting immutable records, including unassessed public experiences. */
export function checkerExposureHistory(catalog: CheckerCatalog, scope: string, requirementRef: string, requirementDigest: string): ReadonlySet<string> {
  const exposed = new Set<string>();
  const matches = (input: CheckInput) => input.task.requirementRef === requirementRef && input.task.requirementDigest === requirementDigest;
  const add = (input: CheckInput) => { for (const fingerprint of checkerExposureFingerprints(input)) exposed.add(fingerprint); };
  const addRefs = (refs: readonly string[]) => {
    for (const entry of catalog.experiences) if (refs.includes(entry.versionId) && entry.value.scope === scope && matches(entry.value.facts)) add(entry.value.facts);
  };

  for (const entry of catalog.versions) if (entry.value.checker.applicability.scope === scope && entry.value.requirements.ref === requirementRef
    && entry.value.requirements.digest === requirementDigest) {
    for (const fingerprint of entry.value.generation.exposedInputs ?? []) exposed.add(fingerprint);
    addRefs(entry.value.experienceRefs);
  }

  for (const started of catalog.generationStarts) if (started.scope === scope && started.requirementRef === requirementRef
    && started.requirementDigest === requirementDigest) {
    for (const fingerprint of started.exposedInputs) exposed.add(fingerprint);
    addRefs(started.experienceRefs);
  }

  for (const entry of catalog.experiences) if (entry.value.scope === scope && matches(entry.value.facts)
    && exposed.has(contentHashOf(entry.value.facts))) add(entry.value.facts);

  for (const run of catalog.runs) if (run.scope === scope && matches(run.input) && exposed.has(run.inputDigest)) add(run.input);

  return exposed;
}
