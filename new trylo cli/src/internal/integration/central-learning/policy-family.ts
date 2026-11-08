import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralStagePreparation } from "./contracts.js";

type PolicyFamily = NonNullable<Extract<CentralStagePreparation, { status: "ready" }>["policyFamily"]>;

/** The original semantic protocol defines the family. Actual known model
 * configuration refines it; exact resource treatment remains in the offer. */
export function centralStagePolicyFamily(protocol: string, modelRef?: string): PolicyFamily {
  return { ref: modelRef === undefined ? protocol : `central-policy-family:${contentHashOf({ protocol, modelRef })}`,
    sourceRef: protocol, response: "shared_or_exact_treatment" };
}
