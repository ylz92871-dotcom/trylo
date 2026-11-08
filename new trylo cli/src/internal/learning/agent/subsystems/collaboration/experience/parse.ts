import type { ExpertIdentity } from "../../../../../subagent/experts/index.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationExperienceContent, ExperienceConditions, ExperienceOwner, PublishExperienceInput, PrepareExperienceInput } from "./contracts.js";
import { EXPERIENCE_CARD_MAX_CHARS, EXPERIENCE_RESPONSIBILITY_LIMITS } from "./contracts.js";
import { isExperienceResponsibility } from "./context.js";
import { renderExperience } from "./render.js";
import { EXPERIENCE_OWNER_LIMITS } from "../../../../../protocol/collaboration-experience.js";
import { isCollaborationEvaluation } from "../domain/evaluation.js";

type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const exact = (value: Row, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));
const strings = (value: unknown, maxItems: number, maxChars: number): value is string[] => Array.isArray(value)
  && value.length > 0 && value.length <= maxItems && value.every(item => text(item, maxChars));
const useScope = (value: unknown): boolean => row(value) && exact(value, ["workspaceId", "taskId"])
  && text(value.workspaceId, 512) && text(value.taskId, 512);
const draft = (value: unknown): boolean => row(value) && exact(value, ["requestId", "revision"])
  && text(value.requestId, 512) && integer(value.revision);

export function isExperienceOwner(value: unknown): value is ExperienceOwner {
  return row(value) && ((["expert", "personal_agent"].includes(String(value.kind)) && exact(value, ["kind", "experienceKey"])
    && text(value.experienceKey, EXPERIENCE_OWNER_LIMITS.experienceKey)) || (value.kind === "legacy_member" && exact(value, ["kind", "workspace", "profileId", "memberId"])
      && text(value.workspace, EXPERIENCE_OWNER_LIMITS.workspace) && text(value.profileId, EXPERIENCE_OWNER_LIMITS.profileId) && text(value.memberId, EXPERIENCE_OWNER_LIMITS.memberId)));
}

export function isExpertIdentityReference(value: unknown): value is ExpertIdentity {
  return row(value) && exact(value, ["expertId", "version", "experienceKey", "draft"])
    && text(value.expertId, 512) && integer(value.version) && text(value.experienceKey, 512)
    && (value.draft === undefined || draft(value.draft));
}

export function isExperienceConditions(value: unknown): value is ExperienceConditions {
  return row(value) && exact(value, ["surface", "taskFamily", "dependency", "responsibility", "expertDraft", "useScope"])
    && (value.surface === undefined || value.surface === "code" || value.surface === "work")
    && (value.taskFamily === undefined || text(value.taskFamily, 200) && value.taskFamily !== "unknown")
    && (value.dependency === undefined || ["artifact", "independent", "shared_state"].includes(String(value.dependency)))
    && (value.responsibility === undefined || isExperienceResponsibility(value.responsibility))
    && (value.expertDraft === undefined || draft(value.expertDraft) && useScope(value.useScope))
    && (value.useScope === undefined || useScope(value.useScope));
}

function fields(value: Row): boolean {
  return text(value.issueId, 512) && isExperienceOwner(value.owner) && text(value.familyId, 200)
    && text(value.situation, 240) && strings(value.responsibilities, 8, 120) && text(value.practice, 1200)
    && strings(value.sourceRefs, 32, 512) && (value.expertVersion === undefined || integer(value.expertVersion))
    && (value.evaluation === undefined || isCollaborationEvaluation(value.evaluation));
}

function expertBinding(owner: ExperienceOwner, identity: unknown, version: unknown, conditions: ExperienceConditions): boolean {
  if (owner.kind !== "expert") return identity === undefined && version === undefined && conditions.expertDraft === undefined;
  if (!isExpertIdentityReference(identity) || identity.experienceKey !== owner.experienceKey
    || (version !== undefined && identity.version !== version)) return false;
  return identity.draft === undefined ? conditions.expertDraft === undefined
    : conditions.expertDraft !== undefined && contentHashOf(identity.draft) === contentHashOf(conditions.expertDraft) && useScope(conditions.useScope);
}

export function isPublishExperienceInput(value: unknown): value is PublishExperienceInput {
  if (!row(value) || !exact(value, ["issueId", "owner", "familyId", "situation", "responsibilities", "practice", "sourceRefs",
    "parentVersion", "expertIdentity", "expertVersion", "conditions", "evaluation"]) || !fields(value) || !isExperienceOwner(value.owner)) return false;

  const conditions = value.conditions ?? {};

  return isExperienceConditions(conditions) && expertBinding(value.owner, value.expertIdentity, value.expertVersion, conditions)
    && (value.parentVersion === undefined || text(value.parentVersion, 512))
    && typeof value.situation === "string" && strings(value.responsibilities, 8, 120) && typeof value.practice === "string"
    && renderExperience({ situation: value.situation, responsibilities: value.responsibilities, practice: value.practice }).length <= EXPERIENCE_CARD_MAX_CHARS;
}

export function isCollaborationExperienceContent(value: unknown): value is CollaborationExperienceContent {
  if (!row(value) || !exact(value, ["schema", "status", "issueId", "focusRevision", "familyId", "owner", "situation", "responsibilities",
    "practice", "sourceRefs", "sourceExpert", "expertVersion", "conditions", "parentVersionId", "evaluation"]) || value.schema !== "collaboration-experience/v1"
    || value.status !== "trial" || !integer(value.focusRevision) || !fields(value) || !isExperienceOwner(value.owner)
    || !isExperienceConditions(value.conditions)) return false;
  return expertBinding(value.owner, value.sourceExpert, value.expertVersion, value.conditions)
    && (value.parentVersionId === undefined || text(value.parentVersionId, 512))
    && typeof value.situation === "string" && strings(value.responsibilities, 8, 120) && typeof value.practice === "string"
    && renderExperience({ situation: value.situation, responsibilities: value.responsibilities, practice: value.practice }).length <= EXPERIENCE_CARD_MAX_CHARS;
}

export function isPrepareExperienceInput(value: unknown): value is PrepareExperienceInput {
  if (!row(value) || !exact(value, ["owner", "expertVersion", "expertDraft", "context", "maxChars"]) || !isExperienceOwner(value.owner)
    || !Number.isSafeInteger(value.maxChars) || Number(value.maxChars) < 0 || Number(value.maxChars) > 2400
    || (value.expertVersion !== undefined && !integer(value.expertVersion)) || (value.expertDraft !== undefined && !draft(value.expertDraft))) return false;

  if (value.owner.kind !== "expert" && (value.expertVersion !== undefined || value.expertDraft !== undefined)) return false;

  const c = value.context;

  return c === undefined || row(c) && exact(c, ["surface", "taskFamily", "dependency", "responsibilities", "useScope"])
    && (c.surface === undefined || c.surface === "code" || c.surface === "work")
    && (c.taskFamily === undefined || text(c.taskFamily, 200))
    && (c.dependency === undefined || ["artifact", "independent", "shared_state", "unknown"].includes(String(c.dependency)))
    && (c.responsibilities === undefined || Array.isArray(c.responsibilities) && c.responsibilities.length > 0
      && c.responsibilities.length <= EXPERIENCE_RESPONSIBILITY_LIMITS.maxItems && c.responsibilities.every(isExperienceResponsibility))
    && (c.useScope === undefined || useScope(c.useScope));
}
