import { decideCentralLearningPursuit } from "../../learning/control/decision/pursuit-model.js";
import type { CentralPursuitInput, CentralPursuitResult } from "../../learning/control/decision/pursuit-contract.js";
import { readCentralPursuitObservations } from "./pursuit-observations.js";

export { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "./pursuit-observations.js";
export type { CentralPursuitObservationDraft } from "./pursuit-observations.js";
export type { CentralPursuitInput, CentralPursuitCandidate, CentralPursuitObjective,
  CentralPursuitObservation, CentralPursuitResult } from "../../learning/control/decision/pursuit-contract.js";

/** Normal host seam: no mature effect history, private statistical DTO, numeric
 * world model, second store or model-written fact is required for a first stage. */
export function decideCentralLearningPursuitFromBoard(input: Omit<CentralPursuitInput, "observations">): CentralPursuitResult {
  const observations = readCentralPursuitObservations(input.board, input.basis.scope);
  if (observations.status !== "ready") return { status: "rejected", reason: observations.reason };
  return decideCentralLearningPursuit({ ...input, observations: observations.observations });
}
