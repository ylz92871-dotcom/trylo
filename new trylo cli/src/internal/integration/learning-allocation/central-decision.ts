import { decideCentralLearning } from "../../learning/control/decision/index.js";
import type { CentralDecisionInput, CentralDecisionResult } from "../../learning/control/decision/index.js";
import { buildCentralResponseHistoryFromBoard } from "./response-source.js";
import { centralResponseWindowsOf } from "./response-registration.js";

export { createCentralResponseWindowDraft, centralResponseWindowsOf } from "./response-registration.js";
export type { CentralResponseWindowRegistration } from "./response-registration.js";

export type CentralBoardDecisionInput = Omit<CentralDecisionInput, "prediction"> & {
  readonly prediction: Omit<CentralDecisionInput["prediction"], "history">;
  /** Policies/windows come from the feedback owner's predeclared comparisons.
   * Separate condition policies retain their own eligibility/revision semantics. */
  readonly historySources: readonly Pick<Parameters<typeof buildCentralResponseHistoryFromBoard>[0], "measurementPolicy" | "windows">[];
};

/** One read-only composition from real Board measurement heads to an actionable
 * numerical proposal. No result/adoption linkage, complete window or comparison
 * label is invented to fill a cold start. No runtime loop or storage is created. */
export function decideCentralLearningFromBoard(input: CentralBoardDecisionInput): CentralDecisionResult {
  if (!Array.isArray(input.historySources) || input.historySources.length > 36) {
    return { status: "rejected", reason: "central_decision_history_sources" };
  }

  const history: CentralDecisionInput["prediction"]["history"][number][] = [];

  for (const source of input.historySources) {
    const projected = buildCentralResponseHistoryFromBoard({ ...source, board: input.board, target: input.prediction.target });
    if (projected.status !== "ready") return { status: "rejected", reason: projected.reason };
    history.push(...projected.history);
  }

  return decideCentralLearning({ schemaVersion: input.schemaVersion, board: input.board, candidates: input.candidates,
    prediction: { ...input.prediction, history } });
}

export type RegisteredCentralDecisionInput = Omit<CentralBoardDecisionInput, "historySources"> & {
  readonly measurementPolicies: readonly Parameters<typeof buildCentralResponseHistoryFromBoard>[0]["measurementPolicy"][];
};

/** Preferred host seam: registration time and finite measurement cohorts are read
 * from the existing Board, rather than supplied/backdated in a numerical request. */
export function decideRegisteredCentralLearning(input: RegisteredCentralDecisionInput): CentralDecisionResult {
  if (!Array.isArray(input.measurementPolicies) || input.measurementPolicies.length > 36) {
    return { status: "rejected", reason: "central_decision_measurement_policies" };
  }

  const windows = centralResponseWindowsOf(input.board, input.prediction.target, input.prediction.basis.scope);
  if (windows.status !== "ready") return { status: "rejected", reason: windows.reason };

  const keys = input.measurementPolicies.map(policy => `${policy.scope}:${policy.conditionHash}`);
  if (new Set(keys).size !== keys.length || input.measurementPolicies.some(policy => policy.scope !== input.prediction.basis.scope)) {
    return { status: "rejected", reason: "central_decision_measurement_policy_binding" };
  }

  return decideCentralLearningFromBoard({ schemaVersion: input.schemaVersion, board: input.board,
    prediction: input.prediction, candidates: input.candidates,
    historySources: input.measurementPolicies.map(measurementPolicy => ({ measurementPolicy,
      windows: windows.value.filter(window => window.opportunity.conditionRef === measurementPolicy.conditionHash) })) });
}
