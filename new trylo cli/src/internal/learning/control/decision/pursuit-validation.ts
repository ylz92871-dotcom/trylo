import { fields, identity, sequence } from "../../../validation/json-shape.js";
import type { CentralPursuitObjective, CentralPursuitObservation } from "./pursuit-contract.js";

/** Qualification definitions and sampling families are source declarations, never
 * consequences of a provider's completed status or a model-written reward score. */
export function isCentralPursuitObjective(value: unknown): value is CentralPursuitObjective {
  return (fields(value, ["instanceId", "criterion", "definitionRef", "familyRef", "familySourceRef"])
      || fields(value, ["instanceId", "criterion", "definitionRef", "familyRef", "familySourceRef", "resourceModel"]))
    && [value.instanceId, value.definitionRef, value.familyRef, value.familySourceRef].every(identity)
    && (value.criterion === "proposal_delivered" || value.criterion === "checker_verified" || value.criterion === "adopted")
    && (!Object.hasOwn(value, "resourceModel") || (fields(value.resourceModel, ["kind", "sourceRef"])
      && value.resourceModel.kind === "shared_or_exact_treatment" && identity(value.resourceModel.sourceRef)));
}

/** One effective source observation. Arrival sequence belongs to the original Board. */
export function isCentralPursuitObservation(value: unknown): value is CentralPursuitObservation {
  const keys = ["unitId", "scope", "conditionRef", "objective", "grantId", "stageRef", "sourceRef", "revisionRef", "sequence", "outcome"];
  return (fields(value, keys) || fields(value, [...keys, "treatmentRef"]))
    && [value.unitId, value.scope, value.conditionRef, value.grantId, value.stageRef, value.sourceRef, value.revisionRef].every(identity)
    && isCentralPursuitObjective(value.objective) && sequence(value.sequence) && value.sequence > 0
    && (!Object.hasOwn(value, "treatmentRef") || identity(value.treatmentRef))
    && (value.objective.resourceModel === undefined || identity(value.treatmentRef))
    && (value.outcome === "qualified" || value.outcome === "closed_no_result" || value.outcome === "pending");
}
