import { EXPERIENCE_RESPONSIBILITY_LIMITS } from "./contracts.js";

export const isExperienceResponsibility = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= EXPERIENCE_RESPONSIBILITY_LIMITS.maxChars && !value.includes("\0");

/** Preserve exact keys. The host may supply a known base role as a fallback; never shorten prose into a different matching key. */
export function experienceResponsibilities(values: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (isExperienceResponsibility(value)) result.add(value);
    if (result.size === EXPERIENCE_RESPONSIBILITY_LIMITS.maxItems) break;
  }
  return [...result];
}
