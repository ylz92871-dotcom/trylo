import { ExpertLibraryError } from "./contracts.js";

export const EXPERT_EXPERIENCE_MAX_CHARS = 600;

/** Ephemeral guidance; authoritative content/version state stays with collaboration. */
export type ExpertGuidance = { readonly text: string; readonly versionIds: readonly string[] };

export function normalizeExpertExperience(value: unknown, maxChars = EXPERT_EXPERIENCE_MAX_CHARS): ExpertGuidance {
  if (typeof value === "string") return validateGuidance(value, [], maxChars);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExpertLibraryError("invalid_input", "Expert experience port returned invalid content");
  }
  const fields = value as Readonly<Record<string, unknown>>;
  return validateGuidance(fields.text, fields.versionIds, maxChars);
}

function validateGuidance(text: unknown, versionIds: unknown, maxChars: number): ExpertGuidance {
  if (typeof text !== "string" || !Array.isArray(versionIds) || versionIds.length > 32
    || versionIds.some(id => typeof id !== "string" || !id.trim() || id.length > 250)) {
    throw new ExpertLibraryError("invalid_input", "Expert experience port returned invalid content or version provenance");
  }

  if (text.length > maxChars) {
    throw new ExpertLibraryError("invalid_input", "Expert experience port exceeded its task-scoped character limit");
  }

  return { text, versionIds: [...new Set<string>(versionIds)] };
}
