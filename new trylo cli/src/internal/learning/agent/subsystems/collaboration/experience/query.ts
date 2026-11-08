import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationExperienceContent, ExperienceConditions, PrepareExperienceInput } from "./contracts.js";
import { isCollaborationExperienceContent } from "./parse.js";
import { experienceConditionsMatch, experienceOwnerFingerprint, liveExperienceAssets } from "./policy.js";
import { collaborationExperienceSourcesValid } from "./provenance.js";
import { renderExperience } from "./render.js";

export const EXPERIENCE_QUERY_MAX_ITEMS = 12;

export type ExperienceQueryOptions = { readonly text?: string; readonly limit?: number };

type ConditionField = "expertVersion" | "expertDraft" | "surface" | "taskFamily" | "dependency" | "responsibility";

export type ExperienceApplicability = { readonly state: "eligible" }
  | { readonly state: "missing_context"; readonly missing: readonly ConditionField[] }
  | { readonly state: "incompatible"; readonly mismatches: readonly ConditionField[]; readonly missing: readonly ConditionField[] };

export type ExperienceQueryItem = {
  readonly versionId: string; readonly familyId: string; readonly card: string;
  readonly conditions: ExperienceConditions; readonly expertVersion?: number;
  readonly applicability: ExperienceApplicability;
};

export type ExperienceQueryResult = {
  readonly mode: "discovery_only"; readonly items: readonly ExperienceQueryItem[]; readonly omittedCount: number;
};

export function isExperienceQueryOptions(value: unknown): value is ExperienceQueryOptions {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => key === "text" || key === "limit")
    && (!("text" in value) || value.text === undefined || typeof value.text === "string" && value.text.length <= 2000 && !value.text.includes("\0"))
    && (!("limit" in value) || value.limit === undefined || typeof value.limit === "number" && Number.isSafeInteger(value.limit)
      && value.limit >= 1 && value.limit <= EXPERIENCE_QUERY_MAX_ITEMS);
}

/** Discovery may explain context conflicts, but temporary branches still require their exact authorization scope. */
function readable(content: CollaborationExperienceContent, input: PrepareExperienceInput): boolean {
  if (experienceOwnerFingerprint(content.owner) !== experienceOwnerFingerprint(input.owner)) return false;
  const conditions = content.conditions;
  return (conditions.expertDraft === undefined || contentHashOf({ draft: conditions.expertDraft }) === contentHashOf({ draft: input.expertDraft }))
    && (conditions.useScope === undefined || contentHashOf({ scope: conditions.useScope }) === contentHashOf({ scope: input.context?.useScope }));
}

function applicability(content: CollaborationExperienceContent, input: PrepareExperienceInput): ExperienceApplicability {
  if (experienceConditionsMatch(content, input)) return { state: "eligible" };

  const missing: ConditionField[] = [], mismatches: ConditionField[] = [], conditions = content.conditions, context = input.context;
  const compare = (field: ConditionField, expected: unknown, actual: unknown) => {
    if (expected === undefined) return;
    if (actual === undefined || actual === "unknown") missing.push(field);
    else if (actual !== expected) mismatches.push(field);
  };

  compare("expertVersion", content.expertVersion, input.expertVersion);
  compare("surface", conditions.surface, context?.surface);
  compare("taskFamily", conditions.taskFamily, context?.taskFamily);
  compare("dependency", conditions.dependency, context?.dependency);

  if (conditions.responsibility !== undefined) {
    if (context?.responsibilities === undefined) missing.push("responsibility");
    else if (!context.responsibilities.includes(conditions.responsibility)) mismatches.push("responsibility");
  }

  if (conditions.expertDraft === undefined && input.expertDraft !== undefined) mismatches.push("expertDraft");

  return mismatches.length ? { state: "incompatible", mismatches, missing } : { state: "missing_context", missing };
}

/** Read-only planning view. A query neither loads instructions into a member nor records an adoption. */
export function queryExperience(state: BoardState, scope: string, input: PrepareExperienceInput,
  options: ExperienceQueryOptions = {}): ExperienceQueryResult {
  const words = [...new Set(options.text?.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean) ?? [])].slice(0, 32);
  const candidates = liveExperienceAssets(state, scope).slice().reverse().flatMap(asset => {
    const content = asset.content;
    if (!isCollaborationExperienceContent(content) || !readable(content, input)
      || !collaborationExperienceSourcesValid(state, scope, content)) return [];

    const card = renderExperience(content), searchable = `${content.familyId}\n${card}`.toLocaleLowerCase();
    const item: ExperienceQueryItem = { versionId: asset.versionId, familyId: content.familyId, card,
      conditions: structuredClone(content.conditions), ...(content.expertVersion === undefined ? {} : { expertVersion: content.expertVersion }),
      applicability: applicability(content, input) };

    return [{ item, score: words.reduce((score, word) => score + (searchable.includes(word) ? 1 : 0), 0) }];
  }).sort((left, right) => right.score - left.score);
  const items = candidates.slice(0, options.limit ?? EXPERIENCE_QUERY_MAX_ITEMS).map(candidate => candidate.item);

  return { mode: "discovery_only", items, omittedCount: candidates.length - items.length };
}
