import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";
import type { CentralFundedStage, CentralStageObservation } from "./contracts.js";
import { centralStageUnitId } from "./stage-unit.js";

/** The original Board stores the decision owner's observation schema. Original
 * artifact/receipt references remain its evidence; no second effect/usage ledger. */
export async function recordCentralStageObservation(options: {
  readonly boardRoot: string; readonly enabled: () => boolean;
  readonly candidate: CentralPursuitCandidate; readonly input: CentralFundedStage;
  readonly observed: CentralStageObservation;
  /** An assignment is recorded before execution; it cannot downgrade an
   * already observed original stage when another caller retries submission. */
  readonly mode?: "initial" | "update";
}) {
  if (!options.enabled()) return { status: "disabled" as const };

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return { status: "rejected" as const, reason: loaded.reason };

  const { candidate, input, observed } = options;
  const existing = readCentralPursuitObservations(loaded.state, candidate.opportunity.scope);
  if (existing.status !== "ready") return { status: "rejected" as const, reason: existing.reason };

  const unitId = centralStageUnitId(input.grantId, input.stageRef);
  if (options.mode === "initial" && existing.heads.some(row => row.unitId === unitId)) return { status: "previous" as const };

  const revisionRef = `central-stage-evidence:${contentHashOf(observed)}`;
  if (existing.observations.some(row => row.unitId === unitId && row.revisionRef === revisionRef)) return { status: "previous" as const };

  const prior = existing.heads.find(row => row.unitId === unitId);

  // An ordinary observer may have finished reading before a concurrent worker
  // confirmed the original delivery. Its stale pending view cannot undo that
  // terminal answer. A genuine original-criterion correction uses the owner's
  // explicit qualification revision contract, not this dispatch observation.
  if (existing.observations.some(row => row.unitId === unitId && row.outcome !== "pending")) {
    return { status: "previous" as const };
  }

  const draft = createCentralPursuitObservationDraft({ unitId, scope: candidate.opportunity.scope,
    conditionRef: candidate.opportunity.conditionRef, objective: candidate.objective, grantId: input.grantId,
    stageRef: input.stageRef, sourceRef: observed.resultRefs[0] ?? observed.sourceRefs[0] ?? input.sourceBindingRef,
    ...(candidate.objective.resourceModel === undefined ? {} : { treatmentRef: centralPursuitTreatmentRef(input.offer) }),
    revisionRef, outcome: observed.outcome, ...(prior === undefined ? {} : { supersedes: prior.factId }) });
  if (draft.status !== "ready") return { status: "rejected" as const, reason: draft.reason };

  return createRewardV2BoardPort(options.boardRoot, options.enabled).append(loaded.state.sequence, draft.value);
}
