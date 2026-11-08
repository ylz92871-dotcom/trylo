import type { JsonObject } from "../../../../../protocol/envelope.js";
import { EXPERIENCE_ASSESSMENT_DIAGNOSES, EXPERIENCE_OBSERVATION_RESULTS, EXPERIENCE_FEEDBACK_LIMITS,
  type ExperienceAssessment, type ExperienceUseFeedback } from "../../../../../protocol/collaboration-experience.js";
import type { BoardState } from "../../../../control/state.js";
import { COLLABORATION_EVALUATION_LIMITS } from "../domain/evaluation.js";
import { isCollaborationExperienceContent } from "./parse.js";

type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim()
  && value.length <= max && !value.includes("\0");
const exact = (value: Row, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length <= EXPERIENCE_FEEDBACK_LIMITS.maxSourceRefs
  && value.every(item => text(item, EXPERIENCE_FEEDBACK_LIMITS.referenceMaxChars)) && unique(value);

export function isExperienceAssessments(value: unknown): value is readonly ExperienceAssessment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EXPERIENCE_FEEDBACK_LIMITS.maxVersionIds) return false;
  return value.every(item => row(item) && exact(item, ["versionId", "diagnosis", "observations"])
    && text(item.versionId, EXPERIENCE_FEEDBACK_LIMITS.referenceMaxChars)
    && EXPERIENCE_ASSESSMENT_DIAGNOSES.some(diagnosis => diagnosis === item.diagnosis)
    && Array.isArray(item.observations) && item.observations.length <= COLLABORATION_EVALUATION_LIMITS.observations
    && item.observations.every(observation => row(observation) && exact(observation, ["expectationId", "result", "sourceRefs"])
      && text(observation.expectationId, COLLABORATION_EVALUATION_LIMITS.observationIdChars)
      && EXPERIENCE_OBSERVATION_RESULTS.some(result => result === observation.result) && refs(observation.sourceRefs)
      && (observation.result === "unknown" || observation.sourceRefs.length > 0))
    && unique(item.observations.map(observation => row(observation) ? observation.expectationId : undefined)))
    && unique(value.map(item => row(item) ? item.versionId : undefined));
}

/** Nested evidence cannot silently escape the feedback's declared sources or actual version set. */
export function experienceAssessmentBindingsValid(value: { readonly assessments?: readonly ExperienceAssessment[];
  readonly versionIds: readonly string[]; readonly sourceRefs: readonly string[] }): boolean {
  return value.assessments === undefined || value.assessments.every(assessment => value.versionIds.includes(assessment.versionId)
    && assessment.observations.every(observation => observation.sourceRefs.every(ref => value.sourceRefs.includes(ref))));
}

/** The shared Board commit owner calls this against immutable published expectations. */
export function experienceAssessmentExpectationsValid(state: BoardState, feedback: ExperienceUseFeedback): boolean {
  return experienceAssessmentBindingsValid(feedback) && (feedback.assessments === undefined || feedback.assessments.every(assessment => {
    const asset = state.assets.find(item => item.versionId === assessment.versionId && item.scope === feedback.scope);
    if (!asset || !isCollaborationExperienceContent(asset.content)) return false;
    const ids = new Set(asset.content.evaluation?.expectedObservations.map(item => item.id) ?? []);
    return assessment.observations.every(observation => ids.has(observation.expectationId));
  }));
}

const stringSchema = (maxLength: number): JsonObject => ({ type: "string", minLength: 1, maxLength });
export const EXPERIENCE_ASSESSMENTS_SCHEMA: JsonObject = {
  type: "array", minItems: 1, maxItems: EXPERIENCE_FEEDBACK_LIMITS.maxVersionIds,
  description: "Optional PA attribution for actual versions. Missing observations remain unknown. This neither verifies quality nor changes a practice's scope or lifecycle.",
  items: { type: "object", required: ["versionId", "diagnosis", "observations"], additionalProperties: false,
    properties: { versionId: stringSchema(EXPERIENCE_FEEDBACK_LIMITS.referenceMaxChars),
      diagnosis: { enum: [...EXPERIENCE_ASSESSMENT_DIAGNOSES] },
      observations: { type: "array", maxItems: COLLABORATION_EVALUATION_LIMITS.observations,
        items: { type: "object", required: ["expectationId", "result", "sourceRefs"], additionalProperties: false,
          properties: { expectationId: stringSchema(COLLABORATION_EVALUATION_LIMITS.observationIdChars),
            result: { enum: [...EXPERIENCE_OBSERVATION_RESULTS] }, sourceRefs: { type: "array", maxItems: EXPERIENCE_FEEDBACK_LIMITS.maxSourceRefs,
              uniqueItems: true, items: stringSchema(EXPERIENCE_FEEDBACK_LIMITS.referenceMaxChars) } } } } } },
};
