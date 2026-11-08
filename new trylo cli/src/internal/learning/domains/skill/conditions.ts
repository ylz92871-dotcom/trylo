import type { TaskFamily } from "../shared/types.js";
import { parseTaskFamily, type ParseResult } from "../shared/parse.js";

export function parseSkillTaskFamily(value: unknown): ParseResult<TaskFamily> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const key of ["language", "repoKind", "checkSchema"]) {
      if (key in value) {
        const field: unknown = Reflect.get(value, key);
        if (typeof field !== "string" || field.trim().length === 0) {
          return { ok: false, reason: "optional skill conditions must be non-empty strings" };
        }
      }
    }
  }
  return parseTaskFamily(value);
}

/** Missing conditions are explicit unknowns, never wildcards. */
export function skillTaskFamilyKey(family: TaskFamily): string {
  return JSON.stringify([
    family.id, family.intentClass, family.checkKind,
    family.language ?? null, family.repoKind ?? null, family.checkSchema ?? null,
  ]);
}

export function sameSkillTaskFamily(actual: TaskFamily, expected: TaskFamily): boolean {
  return skillTaskFamilyKey(actual) === skillTaskFamilyKey(expected);
}
