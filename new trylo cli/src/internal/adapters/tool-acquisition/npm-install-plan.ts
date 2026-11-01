import { contentHashOf } from "../../learning/control/hash.js";
import { decodeNpmInstallData, type NpmInstallPlan } from "../../tooling/contract/npm-install.js";
import { planNpmLockedTree } from "./npm-tree-plan.js";

export { npmInstallId } from "../../tooling/contract/npm-install.js";

/** Rebuild npm resolution after shape validation; persisted edges are never their own authority. */
export function decodeNpmInstallPlan(raw: unknown): NpmInstallPlan | undefined {
  const plan = decodeNpmInstallData(raw);
  if (plan === undefined) return undefined;
  const planned = planNpmLockedTree({ scope: plan.tree.scope, name: plan.tree.root.name, version: plan.tree.root.version,
    target: plan.tree.target, lock: plan.lock });
  return planned.ok && contentHashOf(planned.tree) === contentHashOf(plan.tree) ? plan : undefined;
}
