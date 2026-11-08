import { fields, identity } from "../../validation/json-shape.js";
import type { TopicMeasurementSelector } from "../../learning/domains/shared/topics/empirical-model.js";

/** Source measurement and response-sharing semantics. The family is not the offer's
 * executable policy identity, and bounds do not supply a prior or a future-use model. */
export type CentralResponseProtocol = TopicMeasurementSelector & {
  readonly deltaBounds: { readonly minimum: number; readonly maximum: number; readonly sourceRef: string };
  readonly policyFamilyRef: string;
  readonly familySourceRef: string;
};

export function isCentralResponseProtocol(value: unknown): value is CentralResponseProtocol {
  return fields(value, ["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit", "deltaBounds",
    "policyFamilyRef", "familySourceRef"])
    && [value.scope, value.experimentRef, value.experimentVersion, value.conditionHash, value.utilityUnit,
      value.policyFamilyRef, value.familySourceRef].every(identity)
    && fields(value.deltaBounds, ["minimum", "maximum", "sourceRef"]) && identity(value.deltaBounds.sourceRef)
    && typeof value.deltaBounds.minimum === "number" && Number.isFinite(value.deltaBounds.minimum)
    && typeof value.deltaBounds.maximum === "number" && Number.isFinite(value.deltaBounds.maximum)
    && value.deltaBounds.minimum <= value.deltaBounds.maximum;
}
