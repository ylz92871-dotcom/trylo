import {
  parseEpisodeArray,
  parseTaskFamily,
  parseTrajectory,
  type ParseResult,
} from "../../../../domains/shared/parse.js";
import type { WorkflowEpisode } from "./inducer.js";

export function parseWorkflowEpisode(value: unknown): ParseResult<WorkflowEpisode> {
  if (!isRecord(value)) {
    return { ok: false, reason: "workflow episode is not an object" };
  }

  const id = value.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return { ok: false, reason: "id must be a non-empty string" };
  }

  const family = parseTaskFamily(value.taskFamily);
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

  if (typeof value.fallback !== "string" || value.fallback.length === 0) {
    return { ok: false, reason: "fallback must be a non-empty string" };
  }

  if (!isStringRecord(value.nodeInputs) || !isStringRecord(value.nodeOutputs)) {
    return { ok: false, reason: "nodeInputs and nodeOutputs must be string maps" };
  }

  return {
    ok: true,
    value: {
      id,
      taskFamily: family.value,
      trajectory: trajectory.value,
      nodeInputs: value.nodeInputs,
      nodeOutputs: value.nodeOutputs,
      fallback: value.fallback,
      outcome,
    },
  };
}

export function parseWorkflowEpisodeList(text: string): ParseResult<WorkflowEpisode[]> {
  return parseEpisodeArray(text, parseWorkflowEpisode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}
