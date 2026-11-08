import { canonicalJson, contentHashOf } from "../../../control/hash.js";
import { identity } from "./json-shape.js";
import { readInformationModel, type InformationModel } from "./information-model.js";

/** A domain objective, not a probability or reward supplied by the language model. */
export type EmpiricalTopicPolicy = {
  readonly scope: string;
  readonly experimentRef: string;
  readonly experimentVersion: string;
  readonly conditionHash: string;
  readonly utilityUnit: string;
  readonly futureUses: number;
  readonly utilityScale: number;
  readonly experimentUnits: number;
  /** Lower bounds from the task objective, not invented means for an unseen sample class. */
  readonly deltaBounds: { readonly minimum: number; readonly maximum: number };
  /** Host-declared Dirichlet concentration; outcome weights are not model-written scores. */
  readonly priorStrength: number;
  readonly priorWeights: readonly number[];
};

/** Canonical measurement-family selector. Resolving revisions requires no prior,
 * value model, future-use assumption or experiment budget. */
export type TopicMeasurementSelector = Pick<EmpiricalTopicPolicy,
  "scope" | "experimentRef" | "experimentVersion" | "conditionHash" | "utilityUnit">;

type MeasurementIdentity = TopicMeasurementSelector & {
  readonly id: string;
  readonly sequence: number;
  readonly sourceRef: string;
  readonly supersedes?: string;
  readonly provenanceJson?: string;
  readonly provenanceHash?: string;
  readonly deploymentAction?: number;
  readonly decisionBasisHash?: string;
};

/** Created only by the host after reading the real checker and complete study costs. */
export type TopicPairedMeasurement = MeasurementIdentity & (
  | { readonly kind: "measured"; readonly baselineUtility: number; readonly candidateUtility: number;
      readonly fullStudyCost: number }
  | { readonly kind: "unknown"; readonly reason: string }
);

/** Exact domain replay of each real scenario at the current domain knowledge state. */
export type EmpiricalDecisionProjection = {
  readonly currentAction: number;
  readonly projections: readonly { readonly measurementId: string; readonly nextAction: number }[];
  readonly basisHash?: string;
};

export type EmpiricalOutcomeClass = { readonly utilityClass: number; readonly deploymentAction: number };

export type EmpiricalTopicModel =
  | { readonly status: "unvalued"; readonly reason: "topic_empirical_policy" | "topic_empirical_support"
      | "topic_empirical_conflict" | "topic_empirical_unknown" | "topic_empirical_out_of_model" | "topic_empirical_decision" }
  | { readonly status: "ready"; readonly modelJson: string; readonly outcomes: readonly EmpiricalOutcomeClass[]; readonly provenance: {
      readonly estimator: "paired-dirichlet-domain-v2"; readonly policyHash: string; readonly supportHash: string;
      readonly supportIds: readonly string[]; readonly boardSequence: number;
      readonly positive: number; readonly nonpositive: number;
      readonly outcomeCounts: readonly number[];
      readonly decisionHash: string;
      readonly assumptions: readonly string[];
    } };

/**
 * Builds the existing finite decision model from actual paired outcomes. The posterior
 * models one fresh comparison and a subsequent deployment outcome under the same
 * conditional protocol. Their Dirichlet joint predictive law is exact for the declared
 * model; exchangeability, the objective and frozen class magnitudes still need calibration.
 */
export function buildEmpiricalTopicModel(input: {
  readonly policy: EmpiricalTopicPolicy;
  readonly questionId: string;
  readonly boardSequence: number;
  readonly measurements: readonly TopicPairedMeasurement[];
  readonly decision: EmpiricalDecisionProjection;
}): EmpiricalTopicModel {
  const { policy } = input;

  if (!isEmpiricalTopicPolicy(policy) || !identity(input.questionId) || !count(input.boardSequence)
    || !Array.isArray(input.measurements) || input.measurements.length > 512) {
    return { status: "unvalued", reason: "topic_empirical_policy" };
  }

  const support = activeEmpiricalTopicSupport(policy, input.measurements, input.boardSequence);
  if (support === undefined) return { status: "unvalued", reason: "topic_empirical_conflict" };

  if (support.some(row => row.kind === "unknown")) return { status: "unvalued", reason: "topic_empirical_unknown" };

  const measured = support.filter((row): row is Extract<TopicPairedMeasurement, { kind: "measured" }> => row.kind === "measured");
  const positive = measured.filter(row => row.candidateUtility > row.baselineUtility);
  const nonpositive = measured.filter(row => row.candidateUtility <= row.baselineUtility);

  if (measured.length === 0) return { status: "unvalued", reason: "topic_empirical_support" };

  const projections = readDecision(input.decision, measured);
  if (projections === undefined) return { status: "unvalued", reason: "topic_empirical_decision" };

  if (measured.some(row => row.candidateUtility - row.baselineUtility < policy.deltaBounds.minimum
    || row.candidateUtility - row.baselineUtility > policy.deltaBounds.maximum)) {
    return { status: "unvalued", reason: "topic_empirical_out_of_model" };
  }

  // Each cell has real support and a single successor action under the domain's rule.
  // Missing cells are outside this empirical model, not fabricated successful samples.
  const cells = new Map<string, { label: EmpiricalOutcomeClass; rows: typeof measured }>();

  for (const row of measured) {
    const utilityClass = pairedUtilityOutcome(policy, row.candidateUtility - row.baselineUtility);
    const deploymentAction = projections.get(row.id)!;
    const key = `${utilityClass}:${deploymentAction}`, cell = cells.get(key) ?? { label: { utilityClass, deploymentAction }, rows: [] };
    cell.rows.push(row);
    cells.set(key, cell);
  }

  const ordered = [...cells.values()].sort((a, b) => a.label.utilityClass - b.label.utilityClass || a.label.deploymentAction - b.label.deploymentAction);
  const groups = ordered.map(cell => cell.rows), outcomes = ordered.map(cell => Object.freeze(cell.label));
  const counts = groups.map(rows => rows.length);
  const classCounts = [0, 1, 2, 3].map(utilityClass => measured.filter(row =>
    pairedUtilityOutcome(policy, row.candidateUtility - row.baselineUtility) === utilityClass).length);
  const priorMass = classCounts.reduce((sum, count, index) => sum + (count === 0 ? 0 : policy.priorWeights[index]!), 0);
  const alpha = counts.map((count, index) => count + policy.priorStrength
    * policy.priorWeights[outcomes[index]!.utilityClass]! / priorMass * count / classCounts[outcomes[index]!.utilityClass]!);
  const total = alpha.reduce((sum, value) => sum + value, 0);
  const prior = alpha.map(a => a / total);
  const means = groups.map(rows => rows.reduce((sum, row) => sum + row.candidateUtility - row.baselineUtility, 0) / rows.length);
  const utilities = means.map(mean => policy.futureUses * mean / policy.utilityScale);
  const model: InformationModel = { schemaVersion: 2, prior,
    utilities: [outcomes.map(() => 0), utilities],
    questions: [{ id: input.questionId, units: policy.experimentUnits,
      cost: measured.reduce((sum, row) => sum + row.fullStudyCost, 0) / measured.length / policy.utilityScale,
      // z is a subsequent deployment outcome, y the new study outcome. Integrating
      // the same Dirichlet parameter gives P(y|z,D)=(alpha_y+1[y=z])/(A+1).
      likelihood: alpha.map((_, z) => alpha.map((a, y) => (a + (z === y ? 1 : 0)) / (total + 1))) }],
    decision: { initialState: "current", states: [
      { id: "current", action: input.decision.currentAction,
        transitions: [{ questionId: input.questionId, next: outcomes.map((_, index) => `observed:${index}`) }] },
      ...outcomes.map((outcome, index) => ({ id: `observed:${index}`, action: outcome.deploymentAction, transitions: [] })),
    ] } };
  const modelJson = canonicalJson(model);
  if (!readInformationModel(modelJson).ok) return { status: "unvalued", reason: "topic_empirical_out_of_model" };

  return { status: "ready", modelJson, outcomes: Object.freeze(outcomes), provenance: Object.freeze({ estimator: "paired-dirichlet-domain-v2" as const,
    policyHash: contentHashOf(policy), supportHash: contentHashOf(support),
    supportIds: Object.freeze(measured.map(row => row.id)), boardSequence: input.boardSequence,
    positive: positive.length, nonpositive: nonpositive.length,
    outcomeCounts: Object.freeze(counts),
    decisionHash: contentHashOf(input.decision),
    assumptions: Object.freeze(["same conditional paired protocol", "exchangeable future paired outcomes",
      "Dirichlet law conditional on frozen observed joint utility/action support; unseen cells are not covered",
      "host prior mass is restricted to observed support; cell utility means are frozen approximations",
      "current and successor actions use the same domain rule; no free terminal action choice",
      "complete comparable study cost; no hidden cross-topic benefit"]) }) };
}

function readDecision(decision: EmpiricalDecisionProjection, measured: readonly TopicPairedMeasurement[]): Map<string, number> | undefined {
  if (decision === null || typeof decision !== "object" || (decision.currentAction !== 0 && decision.currentAction !== 1)
    || !Array.isArray(decision.projections) || decision.projections.length !== measured.length
    || (decision.basisHash !== undefined && !/^[a-f0-9]{64}$/.test(decision.basisHash))) return undefined;

  const ids = new Set(measured.map(row => row.id)), result = new Map<string, number>();

  for (const row of decision.projections) {
    if (!ids.has(row.measurementId) || result.has(row.measurementId) || (row.nextAction !== 0 && row.nextAction !== 1)) return undefined;
    result.set(row.measurementId, row.nextAction);
  }

  return result;
}

export function isEmpiricalTopicPolicy(policy: EmpiricalTopicPolicy): boolean {
  if (policy === null || typeof policy !== "object") return false;
  return [policy.scope, policy.experimentRef, policy.experimentVersion, policy.utilityUnit].every(identity)
    && /^[a-f0-9]{64}$/.test(policy.conditionHash) && Number.isFinite(policy.futureUses) && policy.futureUses > 0 && policy.futureUses <= 1000000
    && Number.isFinite(policy.utilityScale) && policy.utilityScale > 0
    && count(policy.experimentUnits) && policy.experimentUnits >= 1 && policy.experimentUnits <= 6
    && policy.deltaBounds !== null && typeof policy.deltaBounds === "object"
    && Number.isFinite(policy.deltaBounds.minimum) && policy.deltaBounds.minimum <= 0
    && Number.isFinite(policy.deltaBounds.maximum) && policy.deltaBounds.maximum > 0
    && Number.isFinite(policy.priorStrength) && policy.priorStrength > 0 && policy.priorStrength <= 1000000
    && Array.isArray(policy.priorWeights) && policy.priorWeights.length === 4
    && policy.priorWeights.every(p => typeof p === "number" && Number.isFinite(p) && p > 0)
    && Math.abs(policy.priorWeights.reduce((a, b) => a + b, 0) - 1) <= 64 * Number.EPSILON
    && policy.futureUses * Math.max(-policy.deltaBounds.minimum, policy.deltaBounds.maximum) <= policy.utilityScale;
}

/** One correction chain contributes one current outcome; conflicts must not become extra samples. */
export function activeEmpiricalTopicSupport(policy: TopicMeasurementSelector, rows: readonly TopicPairedMeasurement[], through: number) {
  const kept = new Map<string, TopicPairedMeasurement>(), replaced = new Set<string>();

  for (const row of rows) {
    if (row === null || typeof row !== "object" || !identity(row.id) || !count(row.sequence) || row.sequence === 0
      || !identity(row.sourceRef) || !/^(checker|execution):/.test(row.sourceRef)) return undefined;

    if (row.sequence > through) continue;

    if (row.scope !== policy.scope || row.experimentRef !== policy.experimentRef || row.experimentVersion !== policy.experimentVersion
      || row.conditionHash !== policy.conditionHash || row.utilityUnit !== policy.utilityUnit) continue;

    if (row.kind !== "measured" && row.kind !== "unknown") return undefined;

    if (row.kind === "measured" && (![row.baselineUtility, row.candidateUtility, row.fullStudyCost].every(Number.isFinite)
      || row.fullStudyCost < 0)) return undefined;

    if (row.kind === "unknown" && !identity(row.reason)) return undefined;

    const previous = kept.get(row.id);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(row)) return undefined;

    kept.set(row.id, row);
  }

  for (const row of kept.values()) {
    if (row.supersedes === undefined) continue;
    const previous = kept.get(row.supersedes);
    if (!identity(row.supersedes) || previous === undefined || previous.sequence >= row.sequence || replaced.has(previous.id)) return undefined;
    replaced.add(previous.id);
  }

  return [...kept.values()].filter(row => !replaced.has(row.id)).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

/** Four fixed objective intervals; the model cannot label its own measurement. */
export function pairedUtilityOutcome(policy: EmpiricalTopicPolicy, delta: number): number {
  if (delta < policy.deltaBounds.minimum / 2) return 0;
  if (delta <= 0) return 1;
  if (delta <= policy.deltaBounds.maximum / 2) return 2;
  return 3;
}

function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
