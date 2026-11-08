import { fields, identity, sequence } from "../../../validation/json-shape.js";
import type { LearningAllocationOffer } from "../allocation-contract.js";
import { contentHashOf } from "../hash.js";
import { betaMoments, rebuildBetaGroups } from "../prediction/beta.js";
import { normalizeLogWeights } from "../prediction/mixture.js";

export type CentralPursuitResourceObservation = { readonly treatmentRef: string;
  readonly outcome: "qualified" | "closed_no_result" | "pending" };

export type CentralPursuitResourceBelief = {
  readonly treatmentRef: string;
  readonly shared: { readonly alpha: number; readonly beta: number; readonly logWeight: number };
  readonly separate: { readonly logWeight: number; readonly groups: readonly { readonly treatmentRef: string; readonly alpha: number; readonly beta: number }[] };
  readonly pending: readonly { readonly treatmentRef: string; readonly count: number }[];
};

export type CentralPursuitResourceModelResult = { readonly status: "ready"; readonly belief: CentralPursuitResourceBelief;
  readonly mean: number; readonly variance: number; readonly pendingMeanRange: readonly [number, number]; readonly sourceRefs: readonly string[] }
  | { readonly status: "invalid" | "unsupported"; readonly reason: string };

const SOURCE = "research:central-decision-continuation-20261104/pursuit-resource-model-notes.md";
const HALF = 1 / 2;
const sharedGroup = "central-pursuit-shared-response";

/** Source instances and offer IDs do not define resource treatment. The original
 * executable policy and all envelope dimensions do; none is silently equated. */
export function centralPursuitTreatmentRef(offer: LearningAllocationOffer): string {
  return `central-pursuit-treatment:${contentHashOf({ policyRef: offer.policyRef, reserve: offer.reserve, maxPromptChars: offer.maxPromptChars })}`;
}

function properHalf(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= HALF && value % 1 === HALF
    && Number.isSafeInteger(value - HALF);
}

function validBelief(value: unknown): value is CentralPursuitResourceBelief {
  if (!fields(value, ["treatmentRef", "shared", "separate", "pending"]) || !identity(value.treatmentRef)
    || !fields(value.shared, ["alpha", "beta", "logWeight"]) || !properHalf(value.shared.alpha) || !properHalf(value.shared.beta)
    || typeof value.shared.logWeight !== "number" || !Number.isFinite(value.shared.logWeight)
    || !fields(value.separate, ["logWeight", "groups"]) || typeof value.separate.logWeight !== "number" || !Number.isFinite(value.separate.logWeight)
    || !Array.isArray(value.separate.groups)
    || !value.separate.groups.every(row => fields(row, ["treatmentRef", "alpha", "beta"])
      && identity(row.treatmentRef) && properHalf(row.alpha) && properHalf(row.beta))
    || !Array.isArray(value.pending) || !value.pending.every(row =>
      fields(row, ["treatmentRef", "count"]) && identity(row.treatmentRef) && sequence(row.count) && row.count > 0)) return false;
  return new Set(value.separate.groups.map(row => row.treatmentRef)).size === value.separate.groups.length
    && new Set(value.pending.map(row => row.treatmentRef)).size === value.pending.length
    && Number.isSafeInteger(value.pending.reduce((sum, row) => sum + row.count, 0));
}

function freezeBelief(belief: CentralPursuitResourceBelief): CentralPursuitResourceBelief {
  return Object.freeze({ treatmentRef: belief.treatmentRef, shared: Object.freeze({ ...belief.shared }),
    separate: Object.freeze({ logWeight: belief.separate.logWeight, groups: Object.freeze(belief.separate.groups.map(row => Object.freeze({ ...row }))) }),
    pending: Object.freeze(belief.pending.map(row => Object.freeze({ ...row }))) });
}

/** Nonnegative log-sum, retaining every hypothesis in the belief even if its
 * floating contribution to this one reported moment is below representability. */
function positiveMoment(terms: readonly { readonly logWeight: number; readonly value: number }[]): number {
  const logs = terms.filter(row => row.value > 0).map(row => row.logWeight + Math.log(row.value));
  if (logs.length === 0) return 0;
  const maximum = Math.max(...logs);
  return Math.exp(maximum + Math.log(logs.reduce((sum, value) => sum + Math.exp(value - maximum), 0)));
}

function prediction(belief: CentralPursuitResourceBelief): CentralPursuitResourceModelResult {
  const weights = normalizeLogWeights([belief.shared.logWeight, belief.separate.logWeight], 2);
  if (weights.status !== "ready") return { status: weights.status, reason: weights.reason };

  const current = belief.separate.groups.find(row => row.treatmentRef === belief.treatmentRef) ?? { alpha: HALF, beta: HALF };
  const shared = betaMoments(belief.shared.alpha, belief.shared.beta), separate = betaMoments(current.alpha, current.beta);
  if (shared.status !== "ready") return { status: shared.status, reason: shared.reason };

  if (separate.status !== "ready") return { status: separate.status, reason: separate.reason };

  const components = [shared.value, separate.value].map((row, index) => ({ ...row, logWeight: weights.value.logWeights[index]! }));
  const mean = positiveMoment(components.map(row => ({ logWeight: row.logWeight, value: row.mean })));
  const variance = positiveMoment(components.flatMap(row => [{ logWeight: row.logWeight, value: row.variance },
    { logWeight: row.logWeight, value: (row.mean - mean) ** 2 }]));
  if (![mean, variance].every(Number.isFinite) || mean <= 0 || mean >= 1 || variance <= 0) {
    return { status: "unsupported", reason: "central_pursuit_resource_numeric_range" };
  }

  const pendingTotal = belief.pending.reduce((sum, row) => sum + row.count, 0);
  const pendingLocal = belief.pending.find(row => row.treatmentRef === belief.treatmentRef)?.count ?? 0;
  const sharedTotal = belief.shared.alpha + belief.shared.beta + pendingTotal, localTotal = current.alpha + current.beta + pendingLocal;
  if (!Number.isSafeInteger(pendingTotal) || !Number.isSafeInteger(sharedTotal) || !Number.isSafeInteger(localTotal)) {
    return { status: "unsupported", reason: "central_pursuit_resource_numeric_range" };
  }

  const range: readonly [number, number] = pendingTotal === 0 ? [mean, mean]
    : [Math.min(belief.shared.alpha / sharedTotal, current.alpha / localTotal),
      Math.max((belief.shared.alpha + pendingTotal) / sharedTotal, (current.alpha + pendingLocal) / localTotal)];

  return { status: "ready", belief: freezeBelief({ ...belief,
    shared: { ...belief.shared, logWeight: weights.value.logWeights[0]! },
    separate: { ...belief.separate, logWeight: weights.value.logWeights[1]! } }), mean, variance,
    pendingMeanRange: Object.freeze(range), sourceRefs: Object.freeze([SOURCE]) };
}

/** Shared-rate versus exact-treatment reference models have symmetric 1/2 prior
 * mass. Each declared rate has a proper Jeffreys Beta(1/2,1/2) prior. Pending
 * observations contribute neither a failure nor likelihood evidence. */
export function fitCentralPursuitResourceModel(history: readonly CentralPursuitResourceObservation[],
  queryTreatmentRef: string): CentralPursuitResourceModelResult {
  if (!identity(queryTreatmentRef) || !Array.isArray(history)
    || !history.every(row => fields(row, ["treatmentRef", "outcome"]) && identity(row.treatmentRef)
      && (row.outcome === "qualified" || row.outcome === "closed_no_result" || row.outcome === "pending"))) {
    return { status: "invalid", reason: "central_pursuit_resource_history" };
  }

  const treatments = [...new Set(history.map(row => row.treatmentRef))].sort();
  const known = history.filter(row => row.outcome !== "pending").map(row => ({ treatmentRef: row.treatmentRef,
    outcome: row.outcome === "qualified" ? 1 as const : 0 as const }));
  const shared = rebuildBetaGroups([{ groupId: sharedGroup, alpha: HALF, beta: HALF }], known.map(row => ({ groupId: sharedGroup, outcome: row.outcome })));
  const separate = rebuildBetaGroups(treatments.map(groupId => ({ groupId, alpha: HALF, beta: HALF })),
    known.map(row => ({ groupId: row.treatmentRef, outcome: row.outcome })));

  if (shared.status !== "ready") return { status: shared.status, reason: shared.reason };

  if (separate.status !== "ready") return { status: separate.status, reason: separate.reason };

  const weights = normalizeLogWeights([Math.log(HALF) + shared.value.logEvidence, Math.log(HALF) + separate.value.logEvidence], 2);
  if (weights.status !== "ready") return { status: weights.status, reason: weights.reason };

  const pending = new Map<string, number>();

  for (const row of history) if (row.outcome === "pending") pending.set(row.treatmentRef, (pending.get(row.treatmentRef) ?? 0) + 1);

  const rate = shared.value.groups[0]!;

  return prediction({ treatmentRef: queryTreatmentRef, shared: { alpha: rate.alpha, beta: rate.beta, logWeight: weights.value.logWeights[0]! },
    separate: { logWeight: weights.value.logWeights[1]!, groups: separate.value.groups.map(row => ({ treatmentRef: row.groupId, alpha: row.alpha, beta: row.beta })) },
    pending: [...pending].map(([treatmentRef, count]) => ({ treatmentRef, count })) });
}

export function predictCentralPursuitResourceModel(belief: CentralPursuitResourceBelief,
  queryTreatmentRef?: string): CentralPursuitResourceModelResult {
  if (!validBelief(belief)) return { status: "invalid", reason: "central_pursuit_resource_belief" };
  const treatmentRef = queryTreatmentRef ?? belief.treatmentRef;
  return identity(treatmentRef) ? prediction({ ...belief, treatmentRef }) : { status: "invalid", reason: "central_pursuit_resource_belief" };
}

/** A pure hypothetical next observation updates both rates and the structural h
 * weights. It creates no source fact and never resolves an older pending label. */
export function advanceCentralPursuitResourceModel(belief: CentralPursuitResourceBelief,
  observation: { readonly treatmentRef: string; readonly outcome: 0 | 1 }): CentralPursuitResourceModelResult {
  if (!validBelief(belief) || !fields(observation, ["treatmentRef", "outcome"]) || !identity(observation.treatmentRef)
    || (observation.outcome !== 0 && observation.outcome !== 1)) return { status: "invalid", reason: "central_pursuit_resource_advance" };

  const shared = rebuildBetaGroups([{ groupId: sharedGroup, alpha: belief.shared.alpha, beta: belief.shared.beta }],
    [{ groupId: sharedGroup, outcome: observation.outcome }]);
  const priors = belief.separate.groups.map(row => ({ groupId: row.treatmentRef, alpha: row.alpha, beta: row.beta }));
  if (!priors.some(row => row.groupId === observation.treatmentRef)) priors.push({ groupId: observation.treatmentRef, alpha: HALF, beta: HALF });

  const separate = rebuildBetaGroups(priors, [{ groupId: observation.treatmentRef, outcome: observation.outcome }]);

  if (shared.status !== "ready") return { status: shared.status, reason: shared.reason };

  if (separate.status !== "ready") return { status: separate.status, reason: separate.reason };

  const weights = normalizeLogWeights([belief.shared.logWeight + shared.value.logEvidence, belief.separate.logWeight + separate.value.logEvidence], 2);
  if (weights.status !== "ready") return { status: weights.status, reason: weights.reason };

  const rate = shared.value.groups[0]!;
  const updated = { treatmentRef: belief.treatmentRef, shared: { alpha: rate.alpha, beta: rate.beta, logWeight: weights.value.logWeights[0]! },
    separate: { logWeight: weights.value.logWeights[1]!, groups: separate.value.groups.map(row => ({ treatmentRef: row.groupId, alpha: row.alpha, beta: row.beta })) },
    pending: belief.pending };

  return validBelief(updated) ? prediction(updated) : { status: "unsupported", reason: "central_pursuit_resource_numeric_range" };
}
