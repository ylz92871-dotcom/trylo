import { contentHashOf } from "../../../../../control/hash.js";
import type { CheckSample } from "../../domain/v2/contracts.js";
import type { CheckerCatalog, CheckerVersion } from "./contracts.js";
import { checkerExperienceHasSharedOracle } from "./feedback.js";

export type CheckerVersionQualification = "working" | "supported" | "rejected" | "evidence_withdrawn";

/** Read-time qualification only. The original report and its historical supersession remain immutable. */
export function deriveCheckerVersionQualification(catalog: CheckerCatalog, version: CheckerVersion): CheckerVersionQualification {
  if (version.evaluation === undefined) return "working";
  if (version.validationSamples?.some(sample => usesWithdrawnLabel(catalog, version, sample))) return "evidence_withdrawn";
  return version.evaluation.status === "supported" ? "supported" : "rejected";
}

function usesWithdrawnLabel(catalog: CheckerCatalog, version: CheckerVersion, sample: CheckSample): boolean {
  if (sample.oracle.kind !== "user_correction") return false;
  return catalog.experiences.some(entry => {
    const experience = entry.value, assessment = experience.assessment;

    // A manual independent label for the same output is a separate source of evidence.
    if (experience.id !== sample.id || experience.scope !== version.checker.applicability.scope || assessment === undefined
      || assessment.kind !== sample.oracle.kind || assessment.sourceRef !== sample.oracle.sourceRef
      || experience.requirements.ref !== version.requirements.ref || experience.requirements.digest !== version.requirements.digest
      || sample.oracle.requirementDigest !== experience.requirements.digest
      || contentHashOf(experience.facts) !== contentHashOf(sample.input)) return false;

    return !checkerExperienceHasSharedOracle(catalog, experience);
  });
}
