import type { BoardState } from "../../learning/control/state.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { centralResponseRegistrationsOf } from "./response-registration.js";
import type { CentralResponseDiscoveryBinding } from "./response-discovery.js";

/** Original-domain preparation reads these from its actual selector/condition and
 * currently frozen baseline. No outcome, prior, variance or utility is requested. */
export type CentralResponseContext = {
  readonly policyFamilyRef: string;
  readonly conditionRef: string;
  readonly sourceRef: string;
  readonly baseline: { readonly ruleKey: string; readonly instanceRef: string; readonly sourceRef: string };
  readonly targetKey?: string;
};

export type CentralResponseContextBinding = { readonly opportunityId: string; readonly context: CentralResponseContext };

export function isCentralResponseContext(value: unknown): value is CentralResponseContext {
  return (fields(value, ["policyFamilyRef", "conditionRef", "sourceRef", "baseline"])
    || fields(value, ["policyFamilyRef", "conditionRef", "sourceRef", "baseline", "targetKey"]))
    && [value.policyFamilyRef, value.conditionRef, value.sourceRef].every(identity)
    && (!Object.hasOwn(value, "targetKey") || identity(value.targetKey))
    && fields(value.baseline, ["ruleKey", "instanceRef", "sourceRef"]) && Object.values(value.baseline).every(identity);
}

/** Resolve the current domain's small applicability declaration against the
 * original Board protocol registry. Ambiguous targets are not chosen by value. */
export function resolveCentralResponseContexts(input: { readonly board: BoardState; readonly scope: string;
  readonly candidates: readonly CentralPursuitCandidate[]; readonly contexts: readonly CentralResponseContextBinding[] }):
  { readonly status: "ready"; readonly bindings: readonly CentralResponseDiscoveryBinding[];
    readonly unmatched: readonly { readonly opportunityId: string; readonly reason: string }[] }
  | { readonly status: "invalid"; readonly reason: string } {
  if (!identity(input.scope) || !Array.isArray(input.contexts) || input.contexts.length > 30
    || !input.contexts.every(row => fields(row, ["opportunityId", "context"]) && identity(row.opportunityId) && isCentralResponseContext(row.context))
    || new Set(input.contexts.map(row => row.opportunityId)).size !== input.contexts.length) {
    return { status: "invalid", reason: "response_context_input" };
  }

  const decoded = centralResponseRegistrationsOf(input.board, input.scope);
  if (decoded.status !== "ready") return decoded;

  const bindings: CentralResponseDiscoveryBinding[] = [], unmatched: { opportunityId: string; reason: string }[] = [];

  for (const item of input.contexts) {
    const candidate = input.candidates.find(row => row.opportunity.opportunityId === item.opportunityId);
    if (candidate === undefined) return { status: "invalid", reason: "response_context_candidate_missing" };

    const { context } = item;
    const matches = decoded.value.filter(record => record.protocol !== null
      && record.protocol.policyFamilyRef === context.policyFamilyRef && record.protocol.conditionHash === context.conditionRef
      && record.window.opportunity.stage === candidate.opportunity.stage
      && canonicalJson(record.window.opportunity.offer.owner) === canonicalJson(candidate.opportunity.offer.owner)
      && record.target.baselineRuleKey === context.baseline.ruleKey
      && (context.targetKey === undefined || record.target.key === context.targetKey));
    const targets = [...new Set(matches.map(record => canonicalJson(record.target)))];
    if (targets.length !== 1) {
      unmatched.push({ opportunityId: item.opportunityId, reason: targets.length === 0 ? "response_context_unregistered" : "response_context_ambiguous" });
      continue;
    }

    bindings.push({ opportunityId: item.opportunityId, targetKey: matches[0]!.target.key,
      conditionRef: context.conditionRef, policyFamilyRef: context.policyFamilyRef, sourceRef: context.sourceRef,
      baseline: context.baseline });
  }

  return { status: "ready", bindings, unmatched };
}
