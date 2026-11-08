import { canonicalObservations, evidenceOf, type EvidenceSummary, type MethodObservation, type MethodExecutionBasis } from "./inference-observations.js";
import { logMarginalOf, posteriorOf, type BetaPosterior } from "./inference.js";

export const MAX_SCOPE_HYPOTHESES = 4;
export const MAX_SCOPE_LITERALS = 6;

export type ScopeLiteral = { readonly feature: string; readonly value: string };

export type ScopePredicate = {
  readonly all: ReadonlyArray<ScopeLiteral>;
  /** Each known matching literal is a local exclusion. Missing facts fail closed. */
  readonly exclude: ReadonlyArray<ScopeLiteral>;
};

/** A missing predicate input is a question for the model, never an observed fact. */
export type UnresolvedScopeCondition = {
  readonly relation: "required" | "excluded";
  readonly feature: string;
  readonly expectedValue: string;
};

export type ScopeHypothesis = {
  readonly id: string;
  readonly versionId: string;
  readonly scopeId: string;
  readonly predicate: ScopePredicate;
  /** Frozen original-use sequence, never reset by feedback arrival or correction. */
  readonly proposedSequence: number;
};

export type ScopeHypothesisPosterior = {
  readonly hypothesisId: string;
  readonly posteriorWeight: number;
  readonly priorWeight: number;
  readonly inside: BetaPosterior;
  readonly outside: BetaPosterior;
  readonly predictiveInside: number;
  readonly predictiveOutside: number;
};

export function isScopeHypothesis(value: unknown): value is ScopeHypothesis {
  if (!isRecord(value)) return false;
  return boundedText(value["id"], 160) && boundedText(value["versionId"], 160) &&
    boundedText(value["scopeId"], 160) && Number.isSafeInteger(value["proposedSequence"]) &&
    typeof value["proposedSequence"] === "number" && value["proposedSequence"] >= 0 &&
    isScopePredicate(value["predicate"]);
}

export function isScopePredicate(value: unknown): value is ScopePredicate {
  if (!isRecord(value)) return false;

  const all = value["all"];
  const exclude = value["exclude"];
  if (!Array.isArray(all) || !Array.isArray(exclude)) return false;

  const literals = [...all, ...exclude];
  if (literals.length < 1 || literals.length > MAX_SCOPE_LITERALS || !literals.every(isLiteral)) return false;

  const seen = new Set<string>();

  for (const literal of literals) {
    const key = JSON.stringify([literal.feature, literal.value]);
    if (seen.has(key)) return false;
    seen.add(key);
  }

  // The conjunction cannot require two different values for the same feature.
  return new Set(all.map((literal: ScopeLiteral) => literal.feature)).size === all.length;
}

export function scopeMatch(predicate: ScopePredicate, features: Readonly<Record<string, string>>): "matched" | "unknown" | "mismatch" {
  if (knownScopeConflict(predicate, features)) return "mismatch";
  return scopeInputsKnown(predicate, features) ? "matched" : "unknown";
}

export function matchesScope(predicate: ScopePredicate, features: Readonly<Record<string, string>>): boolean {
  return scopeMatch(predicate, features) === "matched";
}

/** Return only absent inputs with their original predicate relationship. No
 * situation text, keyword inference or expected value is promoted into truth.
 */
export function unresolvedScopeConditions(predicate: ScopePredicate,
  features: Readonly<Record<string, string>>): ReadonlyArray<UnresolvedScopeCondition> {
  if (knownScopeConflict(predicate, features)) return [];
  const missing = (literals: ReadonlyArray<ScopeLiteral>, relation: UnresolvedScopeCondition["relation"]) => literals
    .filter(literal => !Object.hasOwn(features, literal.feature))
    .map(literal => ({ relation, feature: literal.feature, expectedValue: literal.value }));
  return [...missing(predicate.all, "required"), ...missing(predicate.exclude, "excluded")];
}

function knownScopeConflict(predicate: ScopePredicate, features: Readonly<Record<string, string>>): boolean {
  return predicate.all.some(literal => Object.hasOwn(features, literal.feature) && features[literal.feature] !== literal.value) ||
    predicate.exclude.some(literal => Object.hasOwn(features, literal.feature) && features[literal.feature] === literal.value);
}

function scopeInputsKnown(predicate: ScopePredicate, features: Readonly<Record<string, string>>): boolean {
  return [...predicate.all, ...predicate.exclude].every(literal => Object.hasOwn(features, literal.feature));
}

/** One stable identity for registration, replay, synthesis and batch inference.
 * Conjunction/exclusion order is immaterial; moving a literal between the two
 * groups changes its meaning. Tuple encoding also removes object-key order.
 */
export function scopePredicateKey(predicate: ScopePredicate): string {
  const ordered = (literals: ReadonlyArray<ScopeLiteral>) => [...literals].sort(literalOrder)
    .map(literal => [literal.feature, literal.value]);
  return JSON.stringify({ all: ordered(predicate.all), exclude: ordered(predicate.exclude) });
}

/** Scope registration never lets a retrospectively chosen success subset inherit A. */
export function scopeEvidenceOf(hypothesis: ScopeHypothesis, input: ReadonlyArray<MethodObservation>, options: {
  readonly sinceSequence?: number; readonly source?: MethodObservation["source"];
  readonly executionBasis?: MethodExecutionBasis;
} = {}): EvidenceSummary {
  // Version belongs to canonical identity. Feature/outcome filters must remain
  // after revision validation so a conflicting revision cannot disappear.
  return evidenceOf(canonicalObservations(input.filter(item => item.versionId === hypothesis.versionId))
    .filter(item => matchesScope(hypothesis.predicate, item.features)), {
    versionId: hypothesis.versionId, sinceSequence: Math.max(hypothesis.proposedSequence, options.sinceSequence ?? -1),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.executionBasis === undefined ? {} : { executionBasis: options.executionBasis }),
  });
}

/**
 * Compare a fixed, bounded batch against H0 on the same prospective observations.
 * H0 has one Bernoulli rate; Hj has independent inside/outside Beta(1,1) rates.
 * Integrating each ordered sequence gives B(s+1,f+1). Its sequential predictive
 * product is exactly the same likelihood. This is conditional on selected task
 * features, not the strong-sampling size principle from concept learning.
 */
export function scopePosteriorOf(hypotheses: ReadonlyArray<ScopeHypothesis>, input: ReadonlyArray<MethodObservation>, options: {
  readonly sinceSequence?: number; readonly source?: MethodObservation["source"];
  readonly executionBasis?: MethodExecutionBasis;
} = {}): { readonly baselineWeight: number; readonly commonAfterSequence: number; readonly observationCount: number;
  readonly hypotheses: ReadonlyArray<ScopeHypothesisPosterior> } {
  validateBatch(hypotheses);
  const commonAfterSequence = Math.max(options.sinceSequence ?? -1, ...hypotheses.map(item => item.proposedSequence));
  const versionId = hypotheses[0]?.versionId;
  if (versionId === undefined) return { baselineWeight: 1, commonAfterSequence, observationCount: 0, hypotheses: [] };

  const observations = evidenceOf(input, { versionId, sinceSequence: commonAfterSequence,
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.executionBasis === undefined ? {} : { executionBasis: options.executionBasis }) }).observations.filter(item =>
    // Model comparison retains the same complete-case cohort for every H.
    // Logical non-applicability alone does not claim all covariates observed.
    hypotheses.every(hypothesis => scopeInputsKnown(hypothesis.predicate, item.features)));
  const total = countsOf(observations);
  const baselineLog = logMarginalOf(total);
  const scored = hypotheses.map(hypothesis => scoreHypothesis(hypothesis, observations));
  const maxLog = Math.max(baselineLog, ...scored.map(item => item.logWeight));
  const normalizer = Math.exp(baselineLog - maxLog) + scored.reduce((sum, item) => sum + Math.exp(item.logWeight - maxLog), 0);

  return { baselineWeight: Math.exp(baselineLog - maxLog) / normalizer, commonAfterSequence,
    observationCount: observations.length, hypotheses: scored.map(item => ({ ...item.posterior,
      posteriorWeight: Math.exp(item.logWeight - maxLog) / normalizer })) };
}

function scoreHypothesis(hypothesis: ScopeHypothesis, observations: ReadonlyArray<MethodObservation>): {
  readonly logWeight: number; readonly posterior: Omit<ScopeHypothesisPosterior, "posteriorWeight">;
} {
  const inside = countsOf(observations.filter(item => matchesScope(hypothesis.predicate, item.features)));
  const outside = countsOf(observations.filter(item => !matchesScope(hypothesis.predicate, item.features)));
  const priorWeight = 2 ** -(hypothesis.predicate.all.length + hypothesis.predicate.exclude.length);
  const insidePosterior = posteriorOf(inside);
  const outsidePosterior = posteriorOf(outside);

  return { logWeight: Math.log(priorWeight) + logMarginalOf(inside) + logMarginalOf(outside),
    posterior: { hypothesisId: hypothesis.id, priorWeight, inside: insidePosterior, outside: outsidePosterior,
      predictiveInside: insidePosterior.mean, predictiveOutside: outsidePosterior.mean } };
}

function validateBatch(hypotheses: ReadonlyArray<ScopeHypothesis>): void {
  if (hypotheses.length > MAX_SCOPE_HYPOTHESES || !hypotheses.every(isScopeHypothesis) ||
    new Set(hypotheses.map(item => item.id)).size !== hypotheses.length ||
    new Set(hypotheses.map(item => item.versionId)).size > 1) throw new RangeError("invalid_scope_batch");
  const signatures = hypotheses.map(item => scopePredicateKey(item.predicate));
  if (new Set(signatures).size !== signatures.length) throw new RangeError("duplicate_scope_hypothesis");
}

function literalOrder(a: ScopeLiteral, b: ScopeLiteral): number {
  return compareText(a.feature, b.feature) || compareText(a.value, b.value);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countsOf(observations: ReadonlyArray<MethodObservation>): { readonly successes: number; readonly failures: number } {
  const successes = observations.filter(item => item.outcome === "helped").length;
  return { successes, failures: observations.length - successes };
}

function isLiteral(value: unknown): value is ScopeLiteral {
  return isRecord(value) && boundedText(value["feature"], 64) && boundedText(value["value"], 160);
}

function boundedText(value: unknown, cap: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= cap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
