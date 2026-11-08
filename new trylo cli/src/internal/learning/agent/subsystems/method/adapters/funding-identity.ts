import type { CentralLearningGrant } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";

/** A method/range has one lifetime purse even when its host scope is normalized. */
export function methodFundingIdentity(grants: readonly CentralLearningGrant[], workspaceId: string, centralScope: string,
  target: { readonly versionId: string; readonly scopeId: string }) {
  const identity = (scope: string) => contentHashOf([scope, target.versionId, target.scopeId]);
  const current = identity(centralScope), legacy = identity(workspaceId);
  const hasLegacy = grants.some(item => item.grantId === `method-grant:${legacy}`);
  if (hasLegacy && legacy !== current && grants.some(item => item.grantId === `method-grant:${current}`)) {
    return { ok: false as const, reason: "method_review_scope_budget_conflict" };
  }

  const selected = hasLegacy ? legacy : current;

  return { ok: true as const, scope: hasLegacy ? workspaceId : centralScope,
    identity: selected, issueId: `method-issue:${selected}`, grantId: `method-grant:${selected}` };
}
