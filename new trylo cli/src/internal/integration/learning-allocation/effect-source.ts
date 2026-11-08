import type { BoardState } from "../../learning/control/state.js";
import type { CentralResponseHistory, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { CentralEffectMeasurement, CentralEffectSupport, CentralEffectWindow } from "../../learning/control/decision/effect-support-contract.js";
import { summarizeCentralEffectSupport } from "../../learning/control/decision/effect-support.js";
import { isCentralResponseTarget } from "../../learning/control/decision/prediction-validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { activeEmpiricalTopicSupport, type TopicMeasurementSelector, type TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { topicMeasurements } from "../learning-topics/measurement-source.js";
import { centralResponseRegistrationsOf } from "./response-registration.js";
import { buildCentralResponseHistoryFromBoard, centralResponseMeasurementHead, hasPendingCentralResponseAssignment } from "./response-source.js";
import type { CentralResponseWindow } from "./response-source.js";

/** Accepts the minimal source protocol and legacy full empirical policies. Only
 * selector/bounds fields are read; no priorStrength or futureUses is required. */
export type CentralEffectSourcePolicy = TopicMeasurementSelector & {
  readonly deltaBounds: { readonly minimum: number; readonly maximum: number; readonly sourceRef?: string };
};

export type CentralEffectSourceInput = {
  /** Already decoded by the canonical Board reader; this projection performs no IO. */
  readonly board: BoardState;
  readonly target: CentralResponseTarget;
  readonly measurementPolicy: CentralEffectSourcePolicy;
  /** Canonical registration unit IDs selected for this exact protocol. Omitted
   * keeps the legacy condition-only projection. IDs cannot introduce new windows. */
  readonly windowIds?: readonly string[];
};

export type CentralEffectSourceProjection = {
  readonly status: "ready";
  readonly sourceRef: string;
  readonly boardSequence: number;
  readonly registeredWindowCount: number;
  /** Other conditions belong to their own source/model; no transport is inferred. */
  readonly otherConditionWindowIds: readonly string[];
  readonly qualifiedWindowIds: readonly string[];
  readonly unqualifiedWindows: readonly { readonly unitId: string; readonly reason: string; readonly sourceRef: string }[];
  /** Null means no eligible registered learning-effect population, not zero effect. */
  readonly effectSupport: CentralEffectSupport | null;
} | { readonly status: "invalid" | "unsupported"; readonly reason: string };

function isSourcePolicy(value: unknown): value is CentralEffectSourcePolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit"].every(key => identity(Reflect.get(value, key)))) return false;

  const bounds: unknown = Reflect.get(value, "deltaBounds");

  return (fields(bounds, ["minimum", "maximum"]) || fields(bounds, ["minimum", "maximum", "sourceRef"]))
    && typeof bounds.minimum === "number" && Number.isFinite(bounds.minimum)
    && typeof bounds.maximum === "number" && Number.isFinite(bounds.maximum) && bounds.minimum <= bounds.maximum
    && (bounds.sourceRef === undefined || identity(bounds.sourceRef));
}

function selectEffectWindows(windows: readonly CentralResponseWindow[], history: readonly CentralResponseHistory[],
  family: readonly TopicPairedMeasurement[], active: readonly TopicPairedMeasurement[]) {
  const qualified: CentralEffectWindow[] = [];
  const unqualifiedWindows: { readonly unitId: string; readonly reason: string; readonly sourceRef: string }[] = [];

  for (const window of windows) {
    const projected = history.find(row => row.unitId === window.unitId)!;

    if (window.comparison.kind === "unqualified") {
      unqualifiedWindows.push({ unitId: window.unitId, reason: window.comparison.reason, sourceRef: projected.sourceRef });
      continue;
    }

    const measurements: CentralEffectMeasurement[] = [];

    // The registered unit remains in the denominator. Its outcome members are
    // unusable until the original prospective assignment is actually recorded.
    for (const id of hasPendingCentralResponseAssignment(projected) ? [] : window.measurementIds) {
      const { head } = centralResponseMeasurementHead(id, family, active);
      if (head === undefined) continue;
      measurements.push({ comparisonId: id, revisionRef: head.id, sourceRef: head.sourceRef,
        outcome: head.kind === "measured" ? { kind: "measured", candidateUtility: head.candidateUtility, baselineUtility: head.baselineUtility }
          : { kind: "unknown", reason: head.reason } });
    }

    qualified.push({ unitId: window.unitId, revisionRef: projected.revisionRef, sourceRef: projected.sourceRef,
      comparisonIds: window.measurementIds, measurements });
  }

  return { qualified, unqualifiedWindows };
}

/** Reads the existing registrations and effective paired feedback. The original
 * response-source remains the authority for grant, comparison and known-at checks.
 * Partial qualified windows keep their observed members and their full denominator;
 * unqualified strategy comparisons are listed but never promoted to learning effects. */
export function projectCentralEffectSupportFromBoard(input: CentralEffectSourceInput): CentralEffectSourceProjection {
  if ((!fields(input, ["board", "target", "measurementPolicy"]) && !fields(input, ["board", "target", "measurementPolicy", "windowIds"]))
    || !sequence(input.board?.sequence)
    || !isCentralResponseTarget(input.target) || !isSourcePolicy(input.measurementPolicy)
    || input.target.utilityUnit !== input.measurementPolicy.utilityUnit
    || input.windowIds !== undefined && (!Array.isArray(input.windowIds)
      || !input.windowIds.every(identity) || new Set(input.windowIds).size !== input.windowIds.length)) {
    return { status: "invalid", reason: "central_effect_source_input" };
  }

  const { board, target, measurementPolicy: policy } = input;
  const registered = centralResponseRegistrationsOf(board, policy.scope);
  if (registered.status !== "ready") return registered;

  const targetRecords = registered.value.filter(record => canonicalJson(record.target) === canonicalJson(target));
  const candidates = targetRecords.filter(record => record.window.opportunity.conditionRef === policy.conditionHash);
  if (input.windowIds !== undefined && input.windowIds.some(id => !candidates.some(record => record.window.unitId === id))) {
    return { status: "invalid", reason: "central_effect_source_window_selection" };
  }

  const selected = input.windowIds === undefined ? candidates : candidates.filter(record => input.windowIds!.includes(record.window.unitId));
  if (selected.some(record => record.protocol !== null && !["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit"]
    .every(key => Reflect.get(record.protocol!, key) === Reflect.get(policy, key)))) {
    return { status: "invalid", reason: "central_effect_source_protocol_selection" };
  }

  const windows = selected.map(record => record.window);
  const gate = buildCentralResponseHistoryFromBoard({ board, target, measurementPolicy: policy, windows });
  if (gate.status !== "ready") return gate;

  // The shared head selector only walks this family, validated by the original
  // canonical revision resolver; there is no second revision ledger here.
  const rows = topicMeasurements(board.rewardV2Facts ?? [], policy.scope).filter(row => row.sequence <= board.sequence);
  const active = activeEmpiricalTopicSupport(policy, rows, board.sequence);
  if (active === undefined) return { status: "invalid", reason: "response_measurement_revision_conflict" };

  const family = rows.filter(row => ["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit"]
    .every(key => Reflect.get(row, key) === Reflect.get(policy, key)));
  const { qualified, unqualifiedWindows } = selectEffectWindows(windows, gate.history, family, active);
  let effectSupport: CentralEffectSupport | null = null;

  if (qualified.length > 0) {
    const comparisonsPerWindow = qualified[0]!.comparisonIds.length;
    if (!qualified.every(window => window.comparisonIds.length === comparisonsPerWindow)) {
      return { status: "invalid", reason: "central_effect_source_window_definition" };
    }

    const support = summarizeCentralEffectSupport({ target, comparisonsPerWindow, windows: qualified,
      deltaBounds: { ...policy.deltaBounds, sourceRef: policy.deltaBounds.sourceRef ?? `central-effect-bounds:${contentHashOf({
        scope: policy.scope, experimentRef: policy.experimentRef, experimentVersion: policy.experimentVersion,
        conditionHash: policy.conditionHash, utilityUnit: policy.utilityUnit, deltaBounds: policy.deltaBounds })}` } });
    if (support.status !== "ready") return support;

    effectSupport = support.value;
  }

  const value = { boardSequence: board.sequence, registeredWindowCount: windows.length,
    otherConditionWindowIds: targetRecords.filter(record => record.window.opportunity.conditionRef !== policy.conditionHash).map(record => record.window.unitId),
    qualifiedWindowIds: qualified.map(window => window.unitId), unqualifiedWindows, effectSupport };

  return { status: "ready", ...value, sourceRef: `central-effect-source:${contentHashOf({ target, policy, source: gate.sourceRef, ...value })}` };
}
