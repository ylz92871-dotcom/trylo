export { decodeNpmQuarantinePlan, safePackagePath, quarantinePlanId, type NpmQuarantinePlan } from "../../tooling/contract/npm-source.js";
import type { NpmQuarantinePlan } from "../../tooling/contract/npm-source.js";
import { NPM } from "./platforms/npm.js";

export function quarantineArchiveUrl(plan: NpmQuarantinePlan): string {
  const result = NPM.archiveUrl({ platform: "npm", id: plan.name, version: plan.version });
  if (!result.ok) throw new Error("exact npm version could not form an archive URL");
  return result.value;
}
