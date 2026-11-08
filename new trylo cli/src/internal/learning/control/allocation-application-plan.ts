import type { AllocationApplicationInput, AllocationFundingBinding, AllocationFundingDraft, AllocationProposal, PreparedAllocationApplication } from "./allocation-application-contract.js";
import type { LearningAllocationOffer } from "./allocation-contract.js";
import { allocateLearningPortfolio } from "./portfolio-allocation.js";
import { planSequentialAllocation } from "./sequential-allocation.js";
import { readLearningPortfolio } from "./portfolio-allocation-read.js";
import { readSequentialAllocation } from "./sequential-allocation-read.js";
import { addAllocationResources, allocationOwnerKey } from "./allocation-shape.js";
import { canonicalJson, contentHashOf } from "./hash.js";
import { centralBudgetReference } from "./central-budget-parse.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "./coordination-parse.js";
import { fields, list, sequence } from "../../validation/json-shape.js";
import { isCentralLearningResources } from "./central-learning-resources.js";

type Preparation = { readonly ok: true; readonly prepared: PreparedAllocationApplication }
  | { readonly ok: false; readonly reason: string };

type ProposalResult = { readonly ok: true; readonly value: AllocationProposal }
  | { readonly ok: false; readonly reason: string };

/** Captures JSON once; outputs are proposals and host bindings, never execution capabilities. */
export function prepareAllocationApplication(input: AllocationApplicationInput): Preparation {
  if (!input) return { ok: false, reason: "allocation_authorization_required" };

  const { kind, proposalJson, bindingsJson, authorizationRef } = input;

  if (!centralBudgetReference(authorizationRef)) return { ok: false, reason: "allocation_authorization_required" };

  const projected = deriveProposal(kind, proposalJson);
  if (!projected.ok) return projected;

  const planned = projected.value;
  if (!Number.isSafeInteger(planned.basis.boardSequence + planned.offers.length + 1)) return { ok: false, reason: "allocation_sequence_overflow" };

  const bindings = readBindings(bindingsJson, planned.offers);
  if (bindings === undefined) return { ok: false, reason: "allocation_binding_invalid" };

  if (bindings.some((binding, index) => !withinAuthorization(binding, planned.offers[index]!))) {
    return { ok: false, reason: "allocation_domain_allowance_exceeded" };
  }

  const planId = `learning-allocation:${contentHashOf({ planned, bindings, authorizationRef })}`;
  const captured = { ...planned, planId };
  const drafts = bindings.map((binding, index) => draft(captured, binding, captured.offers[index]!, authorizationRef, index));
  const auditPayload = canonicalJson({ schemaVersion: 1, type: "central_learning_allocation", proposal: captured, bindings, drafts });

  return { ok: true, prepared: { proposal: captured, bindings, drafts, auditPayload } };
}

function deriveProposal(kind: AllocationApplicationInput["kind"], json: string): ProposalResult {
  if (kind === "portfolio") {
    const request = readLearningPortfolio(json), result = allocateLearningPortfolio(json);
    if (request === undefined || result.status !== "allocated") return invalidProposal();
    const offers = result.plan.allocations.flatMap(item => item.offer === null ? [] : [item.offer]);
    return supportedProposal({ planId: "pending", requestHash: contentHashOf(request), basis: request.basis,
      requestedBudget: request.budget, offers, forecast: { kind: "separable_portfolio", netValue: result.plan.netValue } }, offers);
  }

  if (kind !== "sequential") return invalidProposal();

  const request = readSequentialAllocation(json), result = planSequentialAllocation(json);
  if (request === undefined || result.status !== "planned") return invalidProposal();

  // A financed first segment cannot borrow value from later stages this provider-grant adapter cannot fund.
  // Pure planning still accepts peer User and zero-resource local stages.
  const executionOffers = result.plan.decision.kind === "stop" ? [] : request.states.flatMap(state => state.offers.map(action => action.offer));
  const supported = supportedProposal({ planId: "pending", requestHash: result.plan.modelHash, basis: request.basis, requestedBudget: request.remaining,
    offers: result.plan.decision.kind === "stop" ? [] : [result.plan.decision.offer],
    forecast: { kind: "finite_observable", netValue: result.plan.netPolicyValue } }, executionOffers);
  if (!supported.ok || result.plan.decision.kind === "stop") return supported;

  // Normal stage charges follow canonical reservations, after unused commitment is released.
  // A late receipt overrun instead holds the root; it is not a normally financeable continuation.
  if (request.states.some(state => state.offers.some(action => action.outcomes.some(({ cost }) =>
    cost.calls !== cost.steps || cost.tokens > 0 && cost.calls === 0)))) {
    return { ok: false, reason: "allocation_provider_charge_model_required" };
  }

  return supported;
}

function supportedProposal(value: AllocationProposal, executionOffers: readonly LearningAllocationOffer[]): ProposalResult {
  if (executionOffers.some(offer => offer.owner.plane === "user")) return { ok: false, reason: "allocation_user_binding_unavailable" };
  if (executionOffers.some(offer => !isCentralLearningAllowance({ schemaVersion: 2, unit: "total_model_tokens",
    maxTokens: offer.reserve.tokens, maxCalls: offer.reserve.calls, maxSteps: offer.reserve.steps, maxPromptChars: offer.maxPromptChars }))) {
    return { ok: false, reason: "allocation_provider_grant_envelope_required" };
  }
  return { ok: true, value };
}

function invalidProposal(): ProposalResult {
  return { ok: false, reason: "allocation_proposal_invalid_or_limited" };
}

function readBindings(json: string, offers: readonly LearningAllocationOffer[]): readonly AllocationFundingBinding[] | undefined {
  if (typeof json !== "string" || json.length > 32768) return undefined;

  let raw: unknown;

  try { raw = JSON.parse(json); } catch { return undefined; }

  if (!list(raw, offers.length, offers.length) || !raw.every(isBinding)) return undefined;

  if (new Set(raw.map(item => item.offerHash)).size !== raw.length || new Set(raw.map(item => item.grantId)).size !== raw.length
    || new Set(raw.map(item => item.issueId)).size !== raw.length) return undefined;

  const matched = offers.map(offer => raw.find(item => item.offerHash === contentHashOf(offer)));
  if (matched.some((binding, index) => binding === undefined || binding.offerId !== offers[index]!.offerId
    || binding.policyRef !== offers[index]!.policyRef)) return undefined;

  return matched.filter((binding): binding is AllocationFundingBinding => binding !== undefined);
}

function isBinding(value: unknown): value is AllocationFundingBinding {
  return fields(value, ["offerId", "offerHash", "policyRef", "sourceBindingRef", "authorizedAllowance", "issueId", "expectedIssueRevision", "grantId", "mode", "chargedAtBasis"])
    && [value.offerId, value.policyRef, value.sourceBindingRef, value.issueId, value.grantId].every(centralBudgetReference)
    && typeof value.offerHash === "string" && /^[a-f0-9]{64}$/.test(value.offerHash)
    && sequence(value.expectedIssueRevision) && (value.mode === "fund" || value.mode === "extend")
    && isCentralLearningResources(value.chargedAtBasis) && isCentralLearningGrantAllowance(value.authorizedAllowance);
}

/** A small next segment cannot bypass a lifetime source authorization by repeated extension. */
function withinAuthorization(binding: AllocationFundingBinding, offer: LearningAllocationOffer): boolean {
  const desired = addAllocationResources(binding.chargedAtBasis, offer.reserve), cap = binding.authorizedAllowance;
  return desired.tokens <= cap.maxTokens && desired.calls <= cap.maxCalls && desired.steps <= cap.maxSteps
    && offer.maxPromptChars <= cap.maxPromptChars;
}

function draft(proposal: AllocationProposal, binding: AllocationFundingBinding, offer: LearningAllocationOffer,
  authorizationRef: string, index: number): AllocationFundingDraft {
  const expectedSequence = proposal.basis.boardSequence + 1 + index;
  const resources = addAllocationResources(binding.chargedAtBasis, offer.reserve);
  const action = binding.mode === "extend" ? { kind: "rebudget" as const, grantId: binding.grantId, expectedSequence,
    limits: resources, authorizationRef, planRef: proposal.planId }
    : { kind: "fund" as const, issueId: binding.issueId, expectedRevision: binding.expectedIssueRevision, grantId: binding.grantId,
      ...(offer.owner.plane === "agent" ? { domain: offer.owner.domain } : {}), budgetId: proposal.basis.budgetId,
      authorizationRef, planRef: proposal.planId, expectedSequence, allowance: { schemaVersion: 2 as const,
        unit: "total_model_tokens" as const, maxTokens: resources.tokens, maxCalls: resources.calls,
        maxSteps: resources.steps, maxPromptChars: offer.maxPromptChars } };

  return { type: "coordinate_learning", commandId: `allocation-funding:${contentHashOf([proposal.planId, allocationOwnerKey(offer.owner), binding.grantId])}`, action };
}

export { sameCentralLearningResources as sameAllocationResources } from "./central-learning-resources.js";
