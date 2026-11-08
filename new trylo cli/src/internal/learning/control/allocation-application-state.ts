import type { PreparedAllocationApplication } from "./allocation-application-contract.js";
import type { CentralBudgetProjection } from "./central-budget-contract.js";
import type { RecordRewardV2FactCommand } from "./commands.js";
import { centralBudgetProjection, grantResources, resourcesFit } from "./central-budget-state.js";
import { centralLearningSpent } from "./coordination-contract.js";
import { contentHashOf } from "./hash.js";
import { learningIssueOwner } from "./learning-issue-owner.js";
import { methodPayloadHash } from "./method-replay.js";
import { isRewardV2Draft } from "../reward/v2-facts.js";
import { sameAllocationResources } from "./allocation-application-plan.js";
import type { BoardState } from "./state.js";

type Failure = { readonly ok: false; readonly reason: string };

export type AllocationRecovery = { readonly ok: true; readonly confirmed: number; readonly recorded: boolean;
  readonly budget: CentralBudgetProjection } | Failure;

export function allocationAuditCommand(prepared: PreparedAllocationApplication, issuedAt: string): RecordRewardV2FactCommand {
  const { proposal } = prepared;
  return { type: "record_reward_v2_fact", commandId: `allocation-decision:${proposal.planId}`, issuedAt,
    expectedSequence: proposal.basis.boardSequence, fact: { id: proposal.planId,
      scope: `allocation-budget:${contentHashOf([proposal.basis.scope, proposal.basis.budgetId])}`,
      algorithmVersion: "central-learning-allocation/v1", kind: "learning_decision", payloadJson: prepared.auditPayload } };
}

/** History is verified before fresh preconditions: our own confirmed prefix has already changed grants. */
export function recoverAllocationPrefix(state: BoardState, prepared: PreparedAllocationApplication, issuedAt: string): AllocationRecovery {
  const budget = centralBudgetProjection(state, prepared.proposal.basis.budgetId);
  if (budget === undefined || budget.budget.scope !== prepared.proposal.basis.scope) return failure("allocation_budget_binding");

  const audit = allocationAuditCommand(prepared, issuedAt);
  if (!isRewardV2Draft(audit.fact)) return failure("allocation_decision_evidence_limit");

  const fact = state.rewardV2Facts?.find(item => item.id === audit.fact.id);
  if (fact === undefined) {
    if (state.appliedCommands.some(item => item.commandId === audit.commandId)) return failure("allocation_record_missing");
    return { ok: true, recorded: false, confirmed: 0, budget };
  }

  if (fact.payloadJson !== audit.fact.payloadJson || fact.scope !== audit.fact.scope || fact.algorithmVersion !== audit.fact.algorithmVersion
    || fact.kind !== audit.fact.kind || fact.sequence !== prepared.proposal.basis.boardSequence + 1) return failure("allocation_record_conflict");

  const applied = state.appliedCommands.find(item => item.commandId === audit.commandId);
  if (applied === undefined || applied.payloadHash !== methodPayloadHash(audit) || applied.sequence !== fact.sequence) return failure("allocation_identity_unavailable");

  return fundingPrefix(state, prepared, issuedAt, budget);
}

function fundingPrefix(state: BoardState, prepared: PreparedAllocationApplication, issuedAt: string, budget: CentralBudgetProjection): AllocationRecovery {
  let confirmed = 0, gap = false;

  for (const [index, draft] of prepared.drafts.entries()) {
    const applied = state.appliedCommands.find(item => item.commandId === draft.commandId);
    if (applied === undefined) {
      gap = true;
      continue;
    }
    if (gap || applied.sequence !== prepared.proposal.basis.boardSequence + 2 + index
      || applied.payloadHash !== methodPayloadHash({ ...draft, issuedAt })) return failure("allocation_prefix_conflict");
    confirmed += 1;
  }

  return { ok: true, confirmed, recorded: true, budget };
}

export function allocationContextFailure(state: BoardState, prepared: PreparedAllocationApplication,
  recovery: Extract<AllocationRecovery, { ok: true }>): string | undefined {
  const expected = prepared.proposal.basis.boardSequence + (recovery.recorded ? 1 + recovery.confirmed : 0);
  if (state.sequence !== expected) return "allocation_basis_stale";

  if (recovery.budget.status === "held") return "allocation_budget_held";

  const originalAvailable = { ...recovery.budget.available };

  for (const offer of prepared.proposal.offers.slice(0, recovery.confirmed)) {
    originalAvailable.tokens += offer.reserve.tokens;
    originalAvailable.calls += offer.reserve.calls;
    originalAvailable.steps += offer.reserve.steps;
  }

  if (!resourcesFit(prepared.proposal.requestedBudget, originalAvailable)) return "allocation_budget_exceeded";

  for (let index = recovery.confirmed; index < prepared.bindings.length; index += 1) {
    const problem = bindingFailure(state, prepared, index);
    if (problem !== undefined) return problem;
  }

  return undefined;
}

function bindingFailure(state: BoardState, prepared: PreparedAllocationApplication, index: number): string | undefined {
  const binding = prepared.bindings[index]!, offer = prepared.proposal.offers[index]!;
  if (offer.owner.plane !== "agent") return "allocation_user_binding_unavailable";

  const issue = state.learningIssues?.find(item => item.issueId === binding.issueId);
  if (issue === undefined || issue.scope !== prepared.proposal.basis.scope || issue.revision !== binding.expectedIssueRevision
    || issue.decision.kind !== "focused_learning") return "allocation_issue_binding";

  const owner = learningIssueOwner(issue), domain = owner === "method" ? "prompt" : owner;
  if (domain !== offer.owner.domain) return "allocation_owner_binding";

  const grant = state.centralLearningGrants?.find(item => item.grantId === binding.grantId);

  if (binding.mode === "fund") return grant !== undefined ? "allocation_grant_exists"
    : sameAllocationResources(binding.chargedAtBasis, { tokens: 0, calls: 0, steps: 0 }) ? undefined : "allocation_charge_binding";

  if (grant === undefined || grant.budgetId !== prepared.proposal.basis.budgetId || grant.scope !== issue.scope
    || grant.issueId !== issue.issueId || grant.jobId !== issue.jobId || issue.grantId !== grant.grantId
    || (grant.domain ?? "collaboration") !== offer.owner.domain || grant.status !== "open") return "allocation_grant_binding";

  if (grant.claim !== undefined || grant.reservations.some(item => item.state === "reserved")) return "allocation_worker_boundary_required";

  const charged = centralLearningSpent(grant);
  if (!sameAllocationResources(charged, binding.chargedAtBasis)) return "allocation_charge_binding";

  if (!sameAllocationResources(charged, grantResources(grant))) return "allocation_reconcile_required";

  return grant.allowance.maxPromptChars === offer.maxPromptChars ? undefined : "allocation_prompt_envelope_binding";
}

function failure(reason: string): Failure { return { ok: false, reason }; }
