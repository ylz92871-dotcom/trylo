import type { ExperienceContext, ExperienceDecision, ExperienceReview } from "../experience-port.js";
import { isScopeHypothesis, isScopePredicate, type ScopeHypothesis, type ScopePredicate } from "./scope-learning.js";
import { isMethodFeatures, MAX_OBSERVATION_ID_CHARS } from "./inference-observations.js";
import { MAX_SCOPE_DESCRIPTION_CHARS } from "./scope-description.js";
import { isCompiledProcedure } from "./procedure.js";
import { isMethodExecutionTrace, type MethodExecutionTrace } from "./execution-trace.js";
import { isAdoptionWindow, type AdoptionWindow } from "./adoption-window.js";

type FactBase = { readonly factId: string; readonly versionId: string; readonly sequence: number };

export const MAX_METHOD_EXPERIENCE_FACTS = 20_000;
export const MAX_METHOD_EVIDENCE_REVISIONS = 10_000;

export type ExperienceSourceBinding = { readonly versionId: string; readonly scopeId: string; readonly compilationId: string;
  readonly snapshotId: string; readonly evidenceRevisions: readonly string[] };

/** Structural learning facts only. Actual helpful observations remain in Board MethodFeedback. */
export type MethodExperienceFact = FactBase & (
  | { readonly kind: "scope"; readonly hypothesis: ScopeHypothesis; readonly description: string }
  | { readonly kind: "scope_retired"; readonly scopeId: string; readonly reason: string }
  | { readonly kind: "decision"; readonly context: ExperienceContext; readonly decision: ExperienceDecision }
  | { readonly kind: "restriction"; readonly scopeId: string; readonly predicate: ScopePredicate; readonly reason: string }
  | { readonly kind: "review"; readonly scopeId: string; readonly snapshotId: string;
      readonly evidenceRevisions: readonly string[]; readonly review: ExperienceReview;
      readonly contextKey?: string;
      readonly knownCounterexampleRevisions?: readonly string[];
      readonly reconsideration?: { readonly compilationId: string; readonly evidenceRevisions: readonly string[];
        readonly semanticRevisions?: readonly string[] };
      readonly relatedBindings?: readonly ExperienceSourceBinding[] }
  | { readonly kind: "execution"; readonly trace: MethodExecutionTrace }
  | { readonly kind: "adoption_window_closed"; readonly window: AdoptionWindow }
  | { readonly kind: "compilation_exit"; readonly scopeId: string; readonly compilationId: string; readonly reason: string }
  | { readonly kind: "exit"; readonly scopeId?: string; readonly mode: "scope" | "stable" | "archive";
      readonly reason: string }
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bounded(value: unknown, max = 1000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isContext(value: unknown): value is ExperienceContext {
  return isRecord(value) && bounded(value.taskId, MAX_OBSERVATION_ID_CHARS) && bounded(value.opportunityId, MAX_OBSERVATION_ID_CHARS) &&
    bounded(value.situation, 1000) && isMethodFeatures(value.features);
}

export function isDecision(value: unknown): value is ExperienceDecision {
  return isRecord(value) && bounded(value.versionId, 200) && bounded(value.scopeId, 200) &&
    ["adopt", "deviate", "block"].includes(String(value.action)) && bounded(value.reason, 1000) &&
    (value.compilationId === undefined || bounded(value.compilationId, 200)) &&
    (value.step === undefined || bounded(value.step, 500)) && (value.facts === undefined || bounded(value.facts, 2000));
}

export function isExperienceReview(value: unknown): value is ExperienceReview {
  if (!isRecord(value) || !Object.keys(value).every(key => ["decision", "score", "reason", "compact", "procedure", "scopes", "revisedMethod", "sources"].includes(key)) ||
    !["promote", "defer", "expression", "narrow", "behavior", "core_invalid"].includes(String(value.decision)) ||
    typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1 ||
    !bounded(value.reason, 2000) || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 8 ||
    !value.sources.every(item => bounded(item, 200))) return false;

  if (value.compact !== undefined && (!isRecord(value.compact) || !Object.keys(value.compact).every(key => ["when", "action", "exceptions"].includes(key)) || !bounded(value.compact.when, 500) ||
    !bounded(value.compact.action, 600) || !bounded(value.compact.exceptions, 500))) return false;

  return (value.procedure === undefined || isCompiledProcedure(value.procedure)) &&
    (value.scopes === undefined || (Array.isArray(value.scopes) && value.scopes.length <= 4 && value.scopes.every(isScopeHypothesis))) &&
    (value.revisedMethod === undefined || bounded(value.revisedMethod, 200));
}

export function isMethodExperienceFact(value: unknown): value is MethodExperienceFact {
  if (!isRecord(value) || !bounded(value.factId, 200) || !bounded(value.versionId, 200) ||
    !Number.isSafeInteger(value.sequence) || typeof value.sequence !== "number" || value.sequence < 1) return false;
  switch (value.kind) {
    case "scope": return isScopeHypothesis(value.hypothesis) && value.hypothesis.versionId === value.versionId && bounded(value.description, MAX_SCOPE_DESCRIPTION_CHARS);
    case "scope_retired": return bounded(value.scopeId, 200) && bounded(value.reason, 2000);
    case "decision": return isContext(value.context) && isDecision(value.decision) && value.decision.versionId === value.versionId;
    case "execution": return isMethodExecutionTrace(value.trace);
    case "adoption_window_closed": return isAdoptionWindow(value.window);
    case "compilation_exit": return bounded(value.scopeId, 200) && bounded(value.compilationId, 200) && bounded(value.reason, 2000);
    case "restriction": return bounded(value.scopeId, 200) && isScopePredicate(value.predicate) && bounded(value.reason, 2000);
    case "review": return bounded(value.scopeId, 200) && bounded(value.snapshotId, 200) &&
      Array.isArray(value.evidenceRevisions) && value.evidenceRevisions.length <= MAX_METHOD_EVIDENCE_REVISIONS &&
      value.evidenceRevisions.every(item => bounded(item, 250)) && isExperienceReview(value.review) &&
      (value.contextKey === undefined || bounded(value.contextKey, 200)) &&
      (value.knownCounterexampleRevisions === undefined || (Array.isArray(value.knownCounterexampleRevisions) &&
        value.knownCounterexampleRevisions.length <= MAX_METHOD_EVIDENCE_REVISIONS && value.knownCounterexampleRevisions.every(item => bounded(item, 250)))) &&
      (value.reconsideration === undefined || (isRecord(value.reconsideration) && bounded(value.reconsideration.compilationId, 200) &&
        Array.isArray(value.reconsideration.evidenceRevisions) && value.reconsideration.evidenceRevisions.length <= MAX_METHOD_EVIDENCE_REVISIONS &&
        value.reconsideration.evidenceRevisions.every(item => bounded(item, 250)) &&
        (value.reconsideration.semanticRevisions === undefined || (Array.isArray(value.reconsideration.semanticRevisions) &&
          value.reconsideration.semanticRevisions.length <= MAX_METHOD_EVIDENCE_REVISIONS &&
          value.reconsideration.semanticRevisions.every(item => bounded(item, 250)))))) &&
      (value.relatedBindings === undefined || (Array.isArray(value.relatedBindings) && value.relatedBindings.length <= 7 &&
        value.relatedBindings.every(isSourceBinding)));
    case "exit": return ["scope", "stable", "archive"].includes(String(value.mode)) && bounded(value.reason, 2000) &&
      (value.scopeId === undefined || bounded(value.scopeId, 200));
    default: return false;
  }
}

function isSourceBinding(value: unknown): value is ExperienceSourceBinding {
  return isRecord(value) && [value.versionId, value.scopeId, value.compilationId, value.snapshotId].every(item => bounded(item, 200)) &&
    Array.isArray(value.evidenceRevisions) && value.evidenceRevisions.length <= MAX_METHOD_EVIDENCE_REVISIONS && value.evidenceRevisions.every(item => bounded(item, 250));
}
