import type { ExperienceSource, ScopeFact } from "./experience-state.js";
import type { ScopeHypothesis } from "./scope-learning.js";

/** Scope chronology only. Statistical qualification and compilation proofs
 * remain in experience-state; all facts still come from the unique Board. */
export function scopesOf(source: ExperienceSource, versionId?: string): readonly ScopeFact[] {
  const retired = new Set(source.facts.flatMap(fact => fact.kind === "scope_retired" ?
    [JSON.stringify([fact.versionId, fact.scopeId])] : []));
  return source.facts.filter((fact): fact is ScopeFact => fact.kind === "scope" &&
    (versionId === undefined || fact.versionId === versionId) && !retired.has(JSON.stringify([fact.versionId, fact.hypothesis.scopeId])));
}

export function hasScopeHistory(source: ExperienceSource, versionId: string): boolean {
  return source.facts.some(fact => fact.kind === "scope" && fact.versionId === versionId);
}

export function epochOf(source: ExperienceSource, versionId: string, scopeId: string): number {
  return Math.max(0, ...source.facts.filter(fact => fact.kind === "exit" && fact.versionId === versionId &&
    (fact.scopeId === undefined || fact.scopeId === scopeId)).map(fact => fact.sequence));
}

export function archived(source: ExperienceSource, versionId: string): boolean {
  return source.facts.some(fact => fact.kind === "exit" && fact.versionId === versionId && fact.mode === "archive");
}

export function scopeEnabled(source: ExperienceSource, scope: ScopeHypothesis): boolean {
  return !source.facts.some(fact => fact.kind === "exit" && fact.versionId === scope.versionId &&
    (fact.mode === "archive" || (fact.mode === "scope" && fact.scopeId === scope.scopeId)));
}

export function scopePermanentlyClosed(source: ExperienceSource, scope: ScopeHypothesis): boolean {
  return source.facts.some(fact => fact.kind === "exit" && fact.mode === "scope" &&
    fact.versionId === scope.versionId && fact.scopeId === scope.scopeId);
}

export function effectivePredicate(source: ExperienceSource, scope: ScopeHypothesis) {
  const latest = [...source.facts].reverse().find(item => item.kind === "restriction" &&
    item.versionId === scope.versionId && item.scopeId === scope.scopeId);
  return latest?.kind === "restriction" ? latest.predicate : scope.predicate;
}
