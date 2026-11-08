import {
  parseEpisodeArray,
  parseTrajectory,
  type ParseResult,
} from "../shared/parse.js";
import type { SkillCorrection, SkillEpisode } from "./types.js";
import { parseSkillTaskFamily } from "./conditions.js";

export function parseSkillEpisode(value: unknown): ParseResult<SkillEpisode> {
  if (!isRecord(value)) {
    return { ok: false, reason: "skill episode is not an object" };
  }

  const id = nonEmpty(value, "id");
  if (!id.ok) {
    return id;
  }

  const family = parseSkillTaskFamily(value.taskFamily);
  if (!family.ok) {
    return family;
  }

  const trajectory = parseTrajectory(value.trajectory);
  if (!trajectory.ok) {
    return trajectory;
  }

  const outcome = value.outcome;
  if (outcome !== "success" && outcome !== "failure") {
    return { ok: false, reason: "outcome must be success or failure" };
  }

  if (!Array.isArray(value.steps) || value.steps.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "steps must be string[]" };
  }

  if (!Array.isArray(value.checks) || value.checks.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "checks must be string[]" };
  }

  const episode: SkillEpisode = {
    id: id.value,
    taskFamily: family.value,
    trajectory: trajectory.value,
    outcome,
    steps: value.steps,
    checks: value.checks,
  };
  let parsed = episode;

  if (value.failureMode !== undefined) {
    if (typeof value.failureMode !== "string" || value.failureMode.trim().length === 0) {
      return { ok: false, reason: "failureMode must be a non-empty string" };
    }
    parsed = { ...parsed, failureMode: value.failureMode };
  }

  if (value.correction !== undefined) {
    const correction = parseCorrection(value.correction);
    if (!correction.ok) {
      return correction;
    }

    if (outcome !== "failure") {
      return { ok: false, reason: "correction is negative evidence, never a successful demonstration" };
    }

    parsed = { ...parsed, correction: correction.value };
  }

  if (value.validatedAfterCorrectionIds !== undefined) {
    const refs = value.validatedAfterCorrectionIds;
    if (outcome !== "success" || !Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
      return { ok: false, reason: "validatedAfterCorrectionIds requires success and non-empty string references" };
    }
    parsed = { ...parsed, validatedAfterCorrectionIds: refs };
  }

  return { ok: true, value: parsed };
}

function parseCorrection(value: unknown): ParseResult<SkillCorrection> {
  if (!isRecord(value) || !Array.isArray(value.targetEpisodeIds) || value.targetEpisodeIds.length === 0 ||
    value.targetEpisodeIds.some((id) => typeof id !== "string" || id.trim().length === 0) ||
    (value.scope !== "task" && value.scope !== "condition" && value.scope !== "family") ||
    typeof value.reason !== "string" || value.reason.trim().length === 0) {
    return { ok: false, reason: "correction requires targetEpisodeIds, explicit scope and reason" };
  }
  return { ok: true, value: { targetEpisodeIds: value.targetEpisodeIds, scope: value.scope, reason: value.reason } };
}

export function parseSkillEpisodeList(text: string): ParseResult<SkillEpisode[]> {
  return parseEpisodeArray(text, parseSkillEpisode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(
  value: Record<string, unknown>,
  key: string,
): ParseResult<string> {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    return { ok: false, reason: `${key} must be a non-empty string` };
  }
  return { ok: true, value: field };
}
