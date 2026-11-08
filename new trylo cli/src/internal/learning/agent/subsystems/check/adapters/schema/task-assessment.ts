import { evaluateSchemaOutput } from "./schema-oracle.js";
import { contentHashOf } from "../../../../../control/hash.js";
import type { CheckExperience, CheckInput, CheckRequirements } from "../../domain/v2/contracts.js";

/** A necessary schema violation is a real negative. A schema match cannot prove extra semantic requirements. */
export function assessDailyCheckInput(requirements: CheckRequirements, facts: CheckInput): CheckExperience["assessment"] {
  if (requirements.schema === undefined || facts.phase !== "before_completion") return undefined;
  const report = evaluateSchemaOutput(requirements.schema, facts.output);
  return report.status !== "fail" ? undefined : { verdict: "invalid", kind: "task_oracle",
    sourceRef: `schema-oracle:${contentHashOf({ requirement: requirements.digest, output: facts.output, report })}` };
}

/** An explicit owner label is evidence; it cannot erase a demonstrated violation of the frozen structural standard. */
export function checkAssessmentCompatibility(experience: CheckExperience) {
  if (experience.assessment?.verdict !== "valid" || experience.requirements.schema === undefined) return { ok: true as const };
  const report = evaluateSchemaOutput(experience.requirements.schema, experience.facts.output);
  return report.status === "fail" ? { ok: false as const, code: "check_oracle_conflict",
    message: "a positive label contradicts the task's unchanged output schema" } : { ok: true as const };
}

