import type { BoardState } from "../../learning/control/state.js";
import type { LearningAllocationBasis } from "../../learning/control/allocation-contract.js";
import { isAllocationBasis } from "../../learning/control/allocation-shape.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralResponseForecast, CentralResponseForecastInput, CentralResponseHistory } from "../../learning/control/decision/prediction-input.js";
import { centralReferenceResponseKey } from "../../learning/control/decision/prediction-reference.js";
import type { CentralResponseFamilyBinding, CentralResponseReference } from "../../learning/control/decision/prediction-reference.js";
import { isCentralResponseOpportunity, isCentralResponseTarget } from "../../learning/control/decision/prediction-validation.js";
import { CENTRAL_RESPONSE_KERNEL_MAX_OBSERVATIONS } from "../../learning/control/decision/prediction-intercept.js";
import type { CentralEffectSupport } from "../../learning/control/decision/effect-support-contract.js";
import { addToSum, emptySum } from "../../learning/reward/explanation/residual-boundary.js";
import type { TopicMeasurementSelector } from "../../learning/domains/shared/topics/empirical-model.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { topicMeasurements } from "../learning-topics/measurement-source.js";
import { centralResponseRegistrationsOf, type CentralResponseRegistration } from "./response-registration.js";
import { isCentralResponseProtocol, type CentralResponseProtocol } from "./response-protocol.js";
import { buildCentralResponseHistoryFromBoard } from "./response-source.js";
import { projectCentralEffectSupportFromBoard } from "./effect-source.js";
import { centralResponseLegacySelector, type CentralResponseDiscoveryGroup } from "./response-discovery.js";
import { createCentralEvidencePredictor, type CentralEvidencePredictor } from "./response-forecast-predict.js";

export type CentralResponseEvidenceForecastInput = { readonly board: BoardState; readonly basis: LearningAllocationBasis;
  readonly group: CentralResponseDiscoveryGroup };

type Failure = { readonly status: "invalid" | "unsupported"; readonly reason: string };

export type CentralResponseEvidenceForecastResult = { readonly status: "ready"; readonly input: CentralResponseForecastInput;
  readonly forecast: CentralResponseForecast; readonly sourceRefs: readonly string[]; readonly identifiedOpportunityIds: readonly string[];
  /** Internal pure source closure. Never serialized; financial-prefix rebinding is
   * allowed, while new actual feedback requires rebuilding this source projection. */
  readonly predict: CentralEvidencePredictor } | Failure;

type Batch = { readonly selector: TopicMeasurementSelector; readonly protocol: CentralResponseProtocol | null;
  readonly records: CentralResponseRegistration[] };

const SELECTOR_FIELDS = ["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit"];

function validProtocol(value: unknown, scope: string, utilityUnit: string): boolean {
  if (!fields(value, ["selector", "protocol"]) || !fields(value.selector, SELECTOR_FIELDS)) return false;
  const selector = value.selector, protocol = value.protocol;
  return Object.values(selector).every(identity) && selector.scope === scope && selector.utilityUnit === utilityUnit
    && (protocol === null || isCentralResponseProtocol(protocol)
      && SELECTOR_FIELDS.every(key => Reflect.get(protocol, key) === Reflect.get(selector, key)));
}

function validInput(input: CentralResponseEvidenceForecastInput): boolean {
  if (!fields(input, ["board", "basis", "group"]) || !sequence(input.board?.sequence) || !isAllocationBasis(input.basis)
    || input.board.sequence !== input.basis.boardSequence || !fields(input.group, ["target", "protocols", "registrations", "opportunities", "familyBindings"])
    || !isCentralResponseTarget(input.group.target) || input.group.target.utilityUnit !== input.basis.utilityUnit) return false;

  const group = input.group;

  return Array.isArray(group.protocols) && group.protocols.every(row =>
    validProtocol(row, input.basis.scope, group.target.utilityUnit))
    && Array.isArray(group.registrations)
    && group.registrations.every(row => fields(row, ["target", "window", "protocol", "factId"]) && identity(row.factId))
    && Array.isArray(group.opportunities) && group.opportunities.length <= 36 && group.opportunities.every(row =>
      isCentralResponseOpportunity(row) && row.scope === input.basis.scope && row.targetRef === group.target.key && row.windowRef === group.target.windowRef)
    && Array.isArray(group.familyBindings) && group.familyBindings.every(row =>
      fields(row, ["instanceRef", "familyRef", "sourceRef"]) && Object.values(row).every(identity));
}

function protocolBatches(input: CentralResponseEvidenceForecastInput): readonly Batch[] | Failure {
  const decoded = centralResponseRegistrationsOf(input.board, input.basis.scope);
  if (decoded.status !== "ready") return decoded;

  const byFactId = new Map(decoded.value.map(record => [record.factId, record]));
  const batches: Batch[] = input.group.protocols.map(row => ({ ...row, records: [] }));
  const seen = new Set<string>();
  const legacyRows = input.group.registrations.some(row => row.protocol === null)
    ? topicMeasurements(input.board.rewardV2Facts ?? [], input.basis.scope) : [];

  for (const record of input.group.registrations) {
    const original = byFactId.get(record.factId);
    if (original === undefined || canonicalJson(original) !== canonicalJson(record) || seen.has(record.factId)
      || canonicalJson(record.target) !== canonicalJson(input.group.target)) return { status: "invalid", reason: "response_forecast_registration_binding" };

    seen.add(record.factId);
    const selector = record.protocol === null ? centralResponseLegacySelector(record, legacyRows, input.board.sequence) : record.protocol;
    if (selector === undefined) return { status: "invalid", reason: "response_legacy_selector_unidentified" };

    const matched = batches.filter(row => canonicalJson(row.protocol) === canonicalJson(record.protocol)
      && SELECTOR_FIELDS.every(key => Reflect.get(row.selector, key) === Reflect.get(selector, key)));
    if (matched.length !== 1) return { status: "invalid", reason: "response_forecast_protocol_binding" };

    matched[0]!.records.push(record);
  }

  if (batches.some(row => row.records.length === 0)) return { status: "invalid", reason: "response_forecast_empty_protocol" };

  return batches;
}

/** Protocol metadata may differ while the actual observation family is identical.
 * Qualify that whole family together so revision aliases cannot become separate
 * independent windows merely by crossing a bounds/family metadata boundary. */
function qualifyComparisons(input: CentralResponseEvidenceForecastInput, batches: readonly Batch[]):
  { readonly historyByUnit: ReadonlyMap<string, CentralResponseHistory> } | Failure {
  const comparisons = new Set<string>();
  const selectors = new Map<string, { readonly selector: TopicMeasurementSelector; readonly records: CentralResponseRegistration[] }>();

  for (const batch of batches) {
    const key = canonicalJson(batch.selector), group = selectors.get(key) ?? { selector: batch.selector, records: [] };

    for (const record of batch.records) {
      for (const id of record.window.measurementIds) {
        if (comparisons.has(id)) return { status: "invalid", reason: "response_forecast_registration_comparison_reused" };
        comparisons.add(id);
      }
      group.records.push(record);
    }

    selectors.set(key, group);
  }

  const historyByUnit = new Map<string, CentralResponseHistory>();

  for (const group of selectors.values()) {
    const qualified = buildCentralResponseHistoryFromBoard({ board: input.board, target: input.group.target,
      measurementPolicy: group.selector, windows: group.records.map(record => record.window) });
    if (qualified.status !== "ready") return qualified;

    for (const row of qualified.history) {
      if (historyByUnit.has(row.unitId)) return { status: "invalid", reason: "response_forecast_unit_conflict" };
      historyByUnit.set(row.unitId, row);
    }
  }

  return { historyByUnit };
}

function combineSupport(parts: readonly CentralEffectSupport[]): CentralEffectSupport | undefined {
  if (parts.length === 0) return undefined;

  if (parts.length === 1) return parts[0]!;

  let low = emptySum(), high = emptySum();
  const windows = parts.flatMap(part => part.windows), population = windows.length;

  for (const part of parts) {
    low = addToSum(low, part.totalGrossSupport[0]);
    high = addToSum(high, part.totalGrossSupport[1]);
  }

  const mean = [low.value / population, high.value / population] as const;
  if (mean[0] > mean[1] || low.value !== 0 && mean[0] === 0 || high.value !== 0 && mean[1] === 0) throw new RangeError("residual_sum_numeric_range");

  return { schemaVersion: 1, target: parts[0]!.target, supportRef: `combined-effect-support:${contentHashOf(parts.map(part => part.supportRef))}`,
    interpretation: "actual_registered_window_support", numericScope: "ordinary_double_not_directed_rounding", population,
    completeWindows: parts.reduce((sum, part) => sum + part.completeWindows, 0), pendingWindows: parts.reduce((sum, part) => sum + part.pendingWindows, 0),
    registeredComparisons: parts.reduce((sum, part) => sum + part.registeredComparisons, 0),
    knownComparisons: parts.reduce((sum, part) => sum + part.knownComparisons, 0), unknownComparisons: parts.reduce((sum, part) => sum + part.unknownComparisons, 0),
    windows, totalGrossSupport: [low.value, high.value], actualMeanSupport: mean,
    sourceRefs: [...new Set(parts.flatMap(part => [part.supportRef, ...part.sourceRefs]))] };
}

function collect(input: CentralResponseEvidenceForecastInput, batches: readonly Batch[], qualified: ReadonlyMap<string, CentralResponseHistory>) {
  const history = [...qualified.values()], parts: CentralEffectSupport[] = [], boundedInstances: string[] = [];
  const families = new Map<string, CentralResponseFamilyBinding>(input.group.familyBindings.map(row => [row.instanceRef, row]));
  const familyWindowCounts = new Map<string, number>();
  const boundSources: { protocol: CentralResponseProtocol; comparisons: number }[] = [];
  let minimum = Infinity, maximum = -Infinity;

  for (const batch of batches) {
    if (batch.protocol === null) continue;

    const protocol = batch.protocol, comparisons = batch.records[0]!.window.measurementIds.length;
    if (!batch.records.every(row => row.window.measurementIds.length === comparisons)) return { status: "invalid" as const, reason: "response_forecast_window_definition" };

    for (const record of batch.records) {
      if (record.window.comparison.kind === "unqualified") continue;

      const instanceRef = record.window.opportunity.instanceRef, previous = families.get(instanceRef);
      if (previous !== undefined && previous.familyRef !== protocol.policyFamilyRef) return { status: "invalid" as const, reason: "response_forecast_family_conflict" };

      families.set(instanceRef, previous ?? { instanceRef, familyRef: protocol.policyFamilyRef, sourceRef: protocol.familySourceRef });
      const key = centralReferenceResponseKey(record.window.opportunity, families), previousCount = familyWindowCounts.get(key);

      // Gross is the complete fixed-window sum, not a per-comparison rate. A
      // response-equivalent class cannot silently change that window definition.
      if (previousCount !== undefined && previousCount !== comparisons) return {
        status: "invalid" as const, reason: "response_forecast_family_window_definition" };

      familyWindowCounts.set(key, comparisons);
      boundedInstances.push(instanceRef);
    }

    const low = comparisons * protocol.deltaBounds.minimum, high = comparisons * protocol.deltaBounds.maximum;
    if (![low, high].every(Number.isFinite)) return { status: "unsupported" as const, reason: "response_forecast_bound_numeric_range" };

    minimum = Math.min(minimum, low);
    maximum = Math.max(maximum, high);
    boundSources.push({ protocol, comparisons });
    const effect = projectCentralEffectSupportFromBoard({ board: input.board, target: input.group.target,
      measurementPolicy: protocol, windowIds: batch.records.map(row => row.window.unitId) });
    if (effect.status !== "ready") return effect;

    if (effect.effectSupport !== null) parts.push(effect.effectSupport);
  }

  const reference: CentralResponseReference | null = boundSources.length === 0 ? null : { minimum, maximum,
    sourceRef: `response-source-bounds:${contentHashOf({ target: input.group.target, boundSources })}` };

  return { target: input.group.target, history, partialSupport: combineSupport(parts), reference,
    familyBindings: [...families.values()], boundedKeys: [...new Set(history.filter(row => boundedInstances.includes(row.instanceRef))
      .map(row => centralReferenceResponseKey(row, families)))] };
}

/** Canonical discovery -> original history qualification -> actual partial bounds
 * -> original fit/predict. No full policy, guessed legacy bounds, best-Q DTO,
 * execution identity rewrite, ledger or host-supplied function is introduced. */
export function buildCentralResponseEvidenceForecast(source: CentralResponseEvidenceForecastInput): CentralResponseEvidenceForecastResult {
  if (!validInput(source)) return { status: "invalid", reason: "response_forecast_source_input" };

  const batches = protocolBatches(source);
  if ("status" in batches) return batches;

  const qualified = qualifyComparisons(source, batches);
  if ("status" in qualified) return qualified;

  let collected: ReturnType<typeof collect>;

  try { collected = collect(source, batches, qualified.historyByUnit); }
  catch (error) {
    if (error instanceof RangeError && error.message === "residual_sum_numeric_range") return { status: "unsupported", reason: "response_forecast_support_numeric_range" };
    throw error;
  }

  if ("status" in collected) return collected;

  const input: CentralResponseForecastInput = { basis: source.basis, target: source.group.target,
    opportunities: source.group.opportunities, history: collected.history,
    limits: { maxObservations: CENTRAL_RESPONSE_KERNEL_MAX_OBSERVATIONS, maxQueries: 36, maxLatentDimension: 1, maxComponents: 1 } };
  const predict = createCentralEvidencePredictor(collected), predicted = predict(input);
  if (predicted.status !== "ready") return { status: predicted.status, reason: predicted.reason };

  const sourceRefs = [...new Set([...source.group.registrations.map(row => row.factId), ...collected.history.map(row => row.sourceRef),
    ...collected.familyBindings.map(row => row.sourceRef), ...(collected.reference === null ? [] : [collected.reference.sourceRef]),
    ...(collected.partialSupport?.sourceRefs ?? [])])];
  const completeIds = new Set(collected.history.filter(row => row.outcome.kind === "paired_window").map(row => row.unitId));
  const identifiedOpportunityIds = predicted.value.queries.filter(row => [...row.calibrationUnitIds, ...row.updateUnitIds].some(id => completeIds.has(id)))
    .map(row => row.opportunityId);

  return { status: "ready", input, forecast: predicted.value, sourceRefs, identifiedOpportunityIds, predict };
}
