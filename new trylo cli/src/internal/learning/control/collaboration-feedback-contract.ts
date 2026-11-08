import type { JsonObject } from "../../protocol/envelope.js";
import { EXPERIENCE_FEEDBACK_LIMITS as LIMITS, EXPERIENCE_FEEDBACK_OUTCOMES, EXPERIENCE_OWNER_LIMITS } from "../../protocol/collaboration-experience.js";
import { isExperienceOwner } from "../agent/subsystems/collaboration/experience/parse.js";
import { isExperienceAssessments, experienceAssessmentBindingsValid, EXPERIENCE_ASSESSMENTS_SCHEMA } from "../agent/subsystems/collaboration/experience/assessment.js";

const REQUIRED_FIELDS = ["receiptId", "owner", "versionIds", "usageReceiptId", "summary", "sourceRefs", "outcome"] as const;
const FIELDS = [...REQUIRED_FIELDS, "assessments"] as const;

type Row = Record<string, unknown>;

export type ExperienceFeedbackIssue = { readonly field: string; readonly message: string };

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
const refs = (value: unknown, maxItems: number): boolean => Array.isArray(value) && value.length > 0 && value.length <= maxItems
  && value.every(item => text(item, LIMITS.referenceMaxChars)) && new Set(value).size === value.length;

/** One field contract is shared by persisted receipts and the public PA input. */
function fieldIssues(value: Row): ExperienceFeedbackIssue[] {
  const issues: ExperienceFeedbackIssue[] = [];

  for (const field of ["receiptId", "usageReceiptId"] as const) {
    if (!text(value[field], LIMITS.referenceMaxChars)) issues.push({ field, message: `feedback.${field} must be non-empty, contain no NUL and have at most ${LIMITS.referenceMaxChars} characters.` });
  }

  if (!isExperienceOwner(value.owner)) issues.push({ field: "owner", message: "feedback.owner must be an exact expert/personal_agent {kind,experienceKey} or legacy_member {kind,workspace,profileId,memberId} identity from the actual use receipt." });

  for (const [field, maxItems] of [["versionIds", LIMITS.maxVersionIds], ["sourceRefs", LIMITS.maxSourceRefs]] as const) {
    if (!refs(value[field], maxItems)) issues.push({ field, message: `feedback.${field} must contain 1-${maxItems} unique references of 1-${LIMITS.referenceMaxChars} characters each; whitespace-only or NUL-containing references are invalid.` });
  }

  if (!text(value.summary, LIMITS.summaryMaxChars)) issues.push({ field: "summary", message: `feedback.summary must be non-empty, contain no NUL and have at most ${LIMITS.summaryMaxChars} characters.` });

  if (!EXPERIENCE_FEEDBACK_OUTCOMES.includes(value.outcome as typeof EXPERIENCE_FEEDBACK_OUTCOMES[number])) issues.push({ field: "outcome", message: `feedback.outcome must be ${EXPERIENCE_FEEDBACK_OUTCOMES.join("| ")}; use uncertainty when attribution is unproven.` });

  if (value.assessments !== undefined) {
    if (!isExperienceAssessments(value.assessments)) issues.push({ field: "assessments", message: "feedback.assessments must contain unique actual version IDs, valid diagnoses and unique expectation observations; observed/contradicted observations require sources." });
    else if (Array.isArray(value.versionIds) && value.versionIds.every((item): item is string => typeof item === "string")
      && Array.isArray(value.sourceRefs) && value.sourceRefs.every((item): item is string => typeof item === "string")
      && !experienceAssessmentBindingsValid({ assessments: value.assessments, versionIds: value.versionIds, sourceRefs: value.sourceRefs })) {
      issues.push({ field: "assessments", message: "Assessment versions and evidence must belong to feedback.versionIds and feedback.sourceRefs." });
    }
  }

  return issues;
}

export function isExperienceFeedbackFields(value: unknown): boolean { return row(value) && fieldIssues(value).length === 0; }

/** Host-owned receipt metadata is not accepted as model input. */
export function experienceFeedbackInputIssues(value: unknown): readonly ExperienceFeedbackIssue[] {
  if (!row(value)) return [{ field: "feedback", message: "feedback must be an object with the required use-feedback fields." }];
  const unknown = Object.keys(value).filter(key => !(FIELDS as readonly string[]).includes(key));
  return [...fieldIssues(value), ...unknown.map(field => ({ field, message: `feedback.${field} is not an input field; the host supplies receipt metadata.` }))];
}

const TEXT_PATTERN = "^(?![\\s\\S]*\\u0000)[\\s\\S]*\\S[\\s\\S]*$";
const stringSchema = (maxLength: number): JsonObject => ({ type: "string", minLength: 1, maxLength, pattern: TEXT_PATTERN });
const referenceSchema = (maxItems: number): JsonObject => ({ type: "array", minItems: 1, maxItems, uniqueItems: true, items: stringSchema(LIMITS.referenceMaxChars) });
const keyedOwner = (kind: string): JsonObject => ({ type: "object", properties: { kind: { enum: [kind] }, experienceKey: stringSchema(EXPERIENCE_OWNER_LIMITS.experienceKey) }, required: ["kind", "experienceKey"], additionalProperties: false });
export const EXPERIENCE_FEEDBACK_INPUT_SCHEMA: JsonObject = { type: "object", required: [...REQUIRED_FIELDS], additionalProperties: false,
  properties: { receiptId: stringSchema(LIMITS.referenceMaxChars), usageReceiptId: stringSchema(LIMITS.referenceMaxChars),
    owner: { oneOf: [keyedOwner("expert"), keyedOwner("personal_agent"), { type: "object", properties: { kind: { enum: ["legacy_member"] },
      workspace: stringSchema(EXPERIENCE_OWNER_LIMITS.workspace), profileId: stringSchema(EXPERIENCE_OWNER_LIMITS.profileId), memberId: stringSchema(EXPERIENCE_OWNER_LIMITS.memberId) },
      required: ["kind", "workspace", "profileId", "memberId"], additionalProperties: false }] },
    versionIds: referenceSchema(LIMITS.maxVersionIds), summary: stringSchema(LIMITS.summaryMaxChars),
    sourceRefs: { ...referenceSchema(LIMITS.maxSourceRefs), description: "Required actual delivery, collaboration, user or file evidence references; a successful task alone does not prove the experience helped." },
    outcome: { type: "string", enum: [...EXPERIENCE_FEEDBACK_OUTCOMES] }, assessments: EXPERIENCE_ASSESSMENTS_SCHEMA } };
