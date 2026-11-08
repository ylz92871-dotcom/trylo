import type { BoardState } from "../../learning/control/state.js";
import type { CentralResponseHistory, CentralResponseOpportunity, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { activeEmpiricalTopicSupport, type TopicMeasurementSelector, type TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { topicMeasurements } from "../learning-topics/measurement-source.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isCentralResponseOpportunity, isCentralResponseTarget } from "../../learning/control/decision/prediction-validation.js";
import { isCentralPursuitObservation } from "../../learning/control/decision/pursuit-validation.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";
import { isRewardV2Fact } from "../../learning/reward/v2-facts.js";
import { createCentralPursuitObservationDraft } from "./pursuit-observations.js";

/** Owned by the original stage/feedback host, registered before reading the outcomes.
 * A raw two-arm experiment does not itself establish a policy/deployment contrast. */
export type CentralResponseWindow = {
  readonly opportunity: CentralResponseOpportunity;
  readonly unitId: string;
  readonly registeredAtSequence: number;
  readonly grantId: string;
  readonly measurementIds: readonly string[];
  readonly comparison: { readonly kind: "deployed_learning_vs_frozen_baseline"; readonly resultRef: string;
    readonly adoptionRef: string; readonly registrationRef: string; readonly baselineRuleKey: string }
    | { readonly kind: "learning_policy_vs_frozen_baseline";
      /** Precomputed original pending fact ID; append that fact after this window's registration. */
      readonly assignmentRef: string;
      readonly registrationRef: string; readonly baselineRuleKey: string }
    | { readonly kind: "unqualified"; readonly reason: string };
  readonly boundary: "open" | "complete";
};

export type CentralResponseHistorySourceResult = { readonly status: "ready"; readonly history: readonly CentralResponseHistory[];
  readonly sourceRef: string } | { readonly status: "invalid"; readonly reason: string };

const ASSIGNMENT_PENDING_REASON = "response_assignment_pending";

/** Shared qualification check for partial-support adapters that reread members. */
export function hasPendingCentralResponseAssignment(history: CentralResponseHistory): boolean {
  return history.outcome.kind === "unknown" && history.outcome.reason === ASSIGNMENT_PENDING_REASON;
}

/** Internal source seam: rows/active must already be validated by the original
 * same-family activeEmpiricalTopicSupport resolver. No revision owner is created. */
export function centralResponseMeasurementHead(id: string, rows: readonly TopicPairedMeasurement[], active: readonly TopicPairedMeasurement[]) {
  let current = rows.find(row => row.id === id);

  // activeEmpiricalTopicSupport has already rejected cycles, forks and missing parents.
  while (current !== undefined) {
    const next = rows.find(row => row.supersedes === current!.id);
    if (next === undefined) break;
    current = next;
  }

  const head = current === undefined ? undefined : active.find(row => row.id === current!.id);
  let origin = head;

  while (origin?.supersedes !== undefined) origin = rows.find(row => row.id === origin!.supersedes);

  return { head, origin };
}

export function isCentralResponseWindow(window: unknown, through: number, target: CentralResponseTarget): window is CentralResponseWindow {
  return fields(window, ["opportunity", "unitId", "registeredAtSequence", "grantId", "measurementIds", "comparison", "boundary"])
    && identity(window.unitId) && identity(window.grantId)
    && sequence(window.registeredAtSequence) && window.registeredAtSequence <= through
    && (window.boundary === "open" || window.boundary === "complete")
    && Array.isArray(window.measurementIds) && window.measurementIds.length > 0 && window.measurementIds.length <= 512
    && window.measurementIds.every(identity) && new Set(window.measurementIds).size === window.measurementIds.length
    && isCentralResponseOpportunity(window.opportunity)
    && window.opportunity.targetRef === target.key && window.opportunity.windowRef === target.windowRef
    && (fields(window.comparison, ["kind", "reason"]) && window.comparison.kind === "unqualified"
        && target.estimand !== "learning_policy_response" && identity(window.comparison.reason)
      || fields(window.comparison, ["kind", "resultRef", "adoptionRef", "registrationRef", "baselineRuleKey"])
        && window.comparison.kind === "deployed_learning_vs_frozen_baseline"
        && target.estimand !== "learning_policy_response"
        && [window.comparison.resultRef, window.comparison.adoptionRef, window.comparison.registrationRef].every(identity)
        && window.comparison.baselineRuleKey === target.baselineRuleKey
      || fields(window.comparison, ["kind", "assignmentRef", "registrationRef", "baselineRuleKey"])
        && window.comparison.kind === "learning_policy_vs_frozen_baseline" && target.estimand === "learning_policy_response"
        && [window.comparison.assignmentRef, window.comparison.registrationRef].every(identity)
        && window.comparison.baselineRuleKey === target.baselineRuleKey);
}

type StageAssignment = { readonly status: "confirmed"; readonly sequence: number }
  | { readonly status: "pending" | "invalid" };

/** An assignment is the original writer's initial pending stage unit. It does
 * not require adoption/success, and a later qualification revision cannot turn
 * a previously unassigned unit into an eligible whole-policy observation. The
 * original treatment fingerprint binds policy and resource caps; later grant
 * state cannot reconstruct that frozen input. */
function prospectiveStageAssignment(board: BoardState, window: CentralResponseWindow): StageAssignment {
  if (window.comparison.kind !== "learning_policy_vs_frozen_baseline") return { status: "invalid" };

  const assignmentRef = window.comparison.assignmentRef;
  const fact = board.rewardV2Facts?.find(row => row.id === assignmentRef);
  if (fact === undefined || fact.sequence > board.sequence) return { status: "pending" };

  if (!isRewardV2Fact(fact) || fact.kind !== "feedback" || fact.sequence <= window.registeredAtSequence
    || !["central-pursuit-outcome-v1", "central-pursuit-outcome-v2"].includes(fact.algorithmVersion)) return { status: "invalid" };

  let raw: unknown;

  try { raw = JSON.parse(fact.payloadJson); }
  catch { return { status: "invalid" }; }

  if (!fields(raw, ["schemaVersion", "observation"])) return { status: "invalid" };

  const observation: unknown = Object.assign({}, raw.observation, { sequence: fact.sequence });
  if (!isCentralPursuitObservation(observation) || observation.outcome !== "pending") return { status: "invalid" };

  const { sequence: observedAt, ...input } = observation;
  const draft = createCentralPursuitObservationDraft(input);
  const bound = draft.status === "ready" && draft.value.id === fact.id && draft.value.algorithmVersion === fact.algorithmVersion
    && draft.value.payloadJson === canonicalJson(raw)
    && fact.scope === window.opportunity.scope && observation.scope === window.opportunity.scope
    && observation.unitId === window.unitId && observation.conditionRef === window.opportunity.conditionRef
    && observation.grantId === window.grantId && observation.stageRef === window.opportunity.instanceRef
    && observation.treatmentRef === centralPursuitTreatmentRef(window.opportunity.offer);

  return bound ? { status: "confirmed", sequence: observedAt } : { status: "invalid" };
}

/** Pure read of the existing Board and registered comparison windows. No ledger or IO.
 * Whole-policy windows precede an immutable original pending stage assignment;
 * deployed-only windows retain their result/adoption meaning. Opaque source refs
 * and stage qualification never replace an actual paired utility measurement. */
export function buildCentralResponseHistoryFromBoard(input: {
  readonly board: BoardState;
  readonly target: CentralResponseTarget;
  readonly measurementPolicy: TopicMeasurementSelector;
  readonly windows: readonly CentralResponseWindow[];
}): CentralResponseHistorySourceResult {
  const { board, target, measurementPolicy: policy, windows } = input;

  if (!isCentralResponseTarget(target) || !Array.isArray(windows) || !windows.every(window => isCentralResponseWindow(window, board.sequence, target))
    || new Set(windows.map(window => window.unitId)).size !== windows.length
    || target.utilityUnit !== policy.utilityUnit) return { status: "invalid", reason: "response_window_binding" };

  // Corrupt canonical records are an engineering failure, never a missing response label.
  const rows = topicMeasurements(board.rewardV2Facts ?? [], policy.scope).filter(row => row.sequence <= board.sequence);
  const active = activeEmpiricalTopicSupport(policy, rows, board.sequence);
  if (active === undefined) return { status: "invalid", reason: "response_measurement_revision_conflict" };

  // Walk only the family whose revision graph the canonical resolver validated.
  const family = rows.filter(row => ["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit"]
    .every(key => Reflect.get(row, key) === Reflect.get(policy, key)));
  const used = new Set<string>(), history: CentralResponseHistory[] = [];
  const sourceWindows: readonly CentralResponseWindow[] = windows;

  for (const window of sourceWindows) {
    const grant = board.centralLearningGrants?.find(row => row.grantId === window.grantId);
    const owner = window.opportunity.offer.owner;
    if (grant === undefined || grant.scope !== policy.scope || window.opportunity.scope !== policy.scope
      || owner.plane !== "agent" || (grant.domain ?? "collaboration") !== owner.domain
      || window.opportunity.conditionRef !== policy.conditionHash) return { status: "invalid", reason: "response_investment_binding" };

    const assignment = target.estimand === "learning_policy_response" ? prospectiveStageAssignment(board, window) : null;
    if (assignment?.status === "invalid") {
      return { status: "invalid", reason: "response_assignment_binding" };
    }

    const chains = window.measurementIds.map(id => centralResponseMeasurementHead(id, family, active));

    // Registration must precede the original measurement, not just a late correction.
    if (chains.some(chain => chain.origin !== undefined && chain.origin.sequence <= window.registeredAtSequence)) {
      return { status: "invalid", reason: "response_window_postselected" };
    }

    if (assignment?.status === "confirmed" && chains.some(chain => chain.origin !== undefined && chain.origin.sequence <= assignment.sequence)) {
      return { status: "invalid", reason: "response_assignment_postselected" };
    }

    const selected = chains.map(chain => chain.head);

    for (const row of selected) {
      if (row === undefined) continue;
      if (used.has(row.id)) return { status: "invalid", reason: "response_window_reused_measurement" };
      used.add(row.id);
    }

    const complete = selected.every((row): row is Extract<TopicPairedMeasurement, { kind: "measured" }> => row?.kind === "measured");
    const outcome: CentralResponseHistory["outcome"] = assignment?.status === "pending"
      ? { kind: "unknown", reason: ASSIGNMENT_PENDING_REASON }
      : window.comparison.kind === "unqualified"
        ? { kind: "unknown", reason: window.comparison.reason }
        : window.boundary !== "complete" ? { kind: "unknown", reason: "response_window_open" }
          : !complete ? { kind: "unknown", reason: "response_window_feedback_missing" }
            : { kind: "paired_window", candidateUtility: selected.reduce((sum, row) => sum + row.candidateUtility, 0),
              baselineUtility: selected.reduce((sum, row) => sum + row.baselineUtility, 0) };
    const sourceRef = `response-window:${contentHashOf({ window, selected, sequence: board.sequence })}`;

    history.push({ ...window.opportunity, unitId: window.unitId, sourceRef,
      sequence: Math.max(window.registeredAtSequence, assignment?.status === "confirmed" ? assignment.sequence : 0,
        ...selected.map(row => row?.sequence ?? 0)),
      // Stable episode order is separate from the latest label's as-of boundary.
      episodeSequence: Math.max(window.registeredAtSequence, ...chains.map(chain => chain.origin?.sequence ?? 0)),
      revisionRef: sourceRef, outcome });
  }

  return { status: "ready", history, sourceRef: `response-history:${contentHashOf({ target, policy, windows, history, sequence: board.sequence })}` };
}
