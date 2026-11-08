import type { ExperienceContext } from "../experience-port.js";
import { isMethodFeatures, MAX_OBSERVATION_ID_CHARS } from "./inference-observations.js";
import type { MethodExperienceFact } from "./experience-facts.js";
import { isCompilationApplied } from "./compilation-review.js";

/** The exact plan and business context delivered by one provider request.
 * Missing bindings on legacy exposures remain unknown; a later context must
 * never retroactively describe an earlier request. */
export type ExperienceExposureBinding = {
  readonly compilationId?: string;
  /** High-water in the canonical transcript for this exact planning request. */
  readonly requestBoundarySequence?: number;
  readonly context: ExperienceContext;
};

export function isExposureBinding(value: unknown): value is ExperienceExposureBinding {
  if (!record(value) || (value.compilationId !== undefined && !text(value.compilationId, 200)) || !record(value.context)) return false;
  const context = value.context;
  return (value.requestBoundarySequence === undefined || typeof value.requestBoundarySequence === "number" &&
    Number.isSafeInteger(value.requestBoundarySequence) && value.requestBoundarySequence >= 0) &&
    text(context.taskId, MAX_OBSERVATION_ID_CHARS) && text(context.opportunityId, MAX_OBSERVATION_ID_CHARS) &&
    text(context.situation, 1000) && isMethodFeatures(context.features);
}

/** Prove that a compiled plan existed when this exposure was actually sent.
 * Later invalidation cannot erase the send; later effects cannot justify it. */
export function validCompilationExposure(facts: readonly MethodExperienceFact[], exposure: {
  readonly versionId: string; readonly scope: string; readonly binding?: ExperienceExposureBinding;
}, beforeSequence: number): boolean {
  const id = exposure.binding?.compilationId;
  return id === undefined || facts.some(fact => fact.kind === "review" && fact.factId === id &&
    fact.versionId === exposure.versionId && fact.scopeId === exposure.scope &&
    isCompilationApplied(facts, fact, beforeSequence));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}
