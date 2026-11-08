import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { isCentralJudgmentContextMaterial } from "../../learning/central/runtime/judgment.js";

const NAVIGATION_PREFIXES = ["central-runtime-purpose-", "central-runtime-constraint:", "central-runtime-catalog:",
  "central-business-catalog:", "central-runtime-manifest:", "central-runtime-native-catalog:"] as const;
const NAVIGATION_ROLES = new Set(["host_retrieval_projection_not_task_result_or_learning_gain"]);

/** Only an actually delivered source body supplies lexical task context.
 * Directories and current PA constraints remain visible elsewhere in the agenda. */
export function isCentralOriginalContextMaterial(material: CentralRuntimeMaterial, refs?: ReadonlySet<string>): boolean {
  if (isCentralJudgmentContextMaterial(material, refs) || !["source", "feedback", "work_result"].includes(material.kind)
    || NAVIGATION_PREFIXES.some(prefix => material.ref.startsWith(prefix)) || isCentralUnreadNavigationMaterial(material)) return false;

  let value: unknown;

  try { value = JSON.parse(material.text); }
  catch { return true; } // Ordinary original prose is not a malformed navigation object.

  return !(typeof value === "object" && value !== null && "role" in value
    && typeof value.role === "string" && NAVIGATION_ROLES.has(value.role));
}
