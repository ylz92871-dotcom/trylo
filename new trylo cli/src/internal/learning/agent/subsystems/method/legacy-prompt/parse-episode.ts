import {
  parseExternalVerdict,
  parseJsonValue,
  parsePromptOps,
  parseTaskFamily,
  parseVersionPins,
  type ParseResult,
} from "../../../../domains/shared/parse.js";
import { privacyStamp } from "../../../../domains/shared/types.js";
import type { PromptGainEpisode } from "./attribution.js";

export function parsePromptGainEpisode(value: unknown): ParseResult<PromptGainEpisode> {
  if (!isRecord(value)) {
    return { ok: false, reason: "episode is not an object" };
  }

  const id = nonEmpty(value, "id");
  const conversationId = nonEmpty(value, "conversationId");
  const baselinePromptHash = nonEmpty(value, "baselinePromptHash");
  const candidatePromptHash = nonEmpty(value, "candidatePromptHash");

  if (!id.ok) {
    return id;
  }

  if (!conversationId.ok) {
    return conversationId;
  }

  if (!baselinePromptHash.ok) {
    return baselinePromptHash;
  }

  if (!candidatePromptHash.ok) {
    return candidatePromptHash;
  }

  const family = parseTaskFamily(value.taskFamily);
  const versions = parseVersionPins(value.versions);
  const patch = parsePromptOps(value.candidatePatch);
  const baselineExternal = parseExternalVerdict(value.baselineExternal);
  const candidateExternal = parseExternalVerdict(value.candidateExternal);

  if (!family.ok) {
    return family;
  }

  if (!versions.ok) {
    return versions;
  }

  if (!patch.ok) {
    return patch;
  }

  if (!baselineExternal.ok) {
    return baselineExternal;
  }

  if (!candidateExternal.ok) {
    return candidateExternal;
  }

  const pointer = isRecord(value.privacy) && typeof value.privacy.pointer === "string"
    ? value.privacy.pointer
    : undefined;

  return {
    ok: true,
    value: {
      id: id.value,
      conversationId: conversationId.value,
      taskFamily: family.value,
      baselinePromptHash: baselinePromptHash.value,
      candidatePromptHash: candidatePromptHash.value,
      candidatePatch: patch.value,
      versions: versions.value,
      baselineExternal: baselineExternal.value,
      candidateExternal: candidateExternal.value,
      weakSignals: [],
      privacy: privacyStamp(["id", "conversationId", "taskFamily", "promptHash", "versions"], pointer),
    },
  };
}

export function parsePromptEpisodeList(text: string): ParseResult<PromptGainEpisode[]> {
  const json = parseJsonValue(text);
  if (!json.ok) {
    return json;
  }

  if (!isRecord(json.value) || !Array.isArray(json.value.episodes)) {
    return { ok: false, reason: "payload.episodes must be an array" };
  }

  const episodes: PromptGainEpisode[] = [];

  for (const item of json.value.episodes) {
    const parsed = parsePromptGainEpisode(item);
    if (!parsed.ok) {
      return parsed;
    }
    episodes.push(parsed.value);
  }

  return { ok: true, value: episodes };
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
