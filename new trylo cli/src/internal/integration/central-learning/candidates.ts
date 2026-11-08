import type { BoardState } from "../../learning/control/state.js";
import type { LearningAllocationBasis } from "../../learning/control/allocation-contract.js";
import type { CentralLearningAllowance, CentralLearningAgentDomain } from "../../learning/control/coordination-contract.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { centralBudgetProjection, grantResources } from "../../learning/control/central-budget-state.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import type { CentralLearningExecutionPort, CentralStagePreparation } from "./contracts.js";

export const CENTRAL_PROPOSAL_DEFINITION = "trylo:source-bound-proposal-delivered:v1";

export type PreparedCentralCandidate = { readonly stage: Extract<CentralStagePreparation, { status: "ready" }>;
  readonly port: CentralLearningExecutionPort; readonly candidate: CentralPursuitCandidate };

/** Shared proposal-criterion metadata. It does not value a runtime intention. */
export function centralCandidateForStage(options: { readonly scope: string; readonly issueId: string; readonly domain: CentralLearningAgentDomain;
  readonly stage: Extract<CentralStagePreparation, { status: "ready" }>; readonly nowMs: number; readonly budgetId: string }): CentralPursuitCandidate {
  const { scope, issueId, domain, stage, nowMs, budgetId } = options;
  const conditionRef = `central-condition:${contentHashOf({ scope, domain,
    policy: stage.policyFamily?.ref ?? stage.policyRef, kind: stage.source.domainStage.kind,
    ...(stage.condition === undefined ? {} : { sourceCondition: stage.condition.ref }) })}`;
  const windowRef = "central-proposal-stage-window:v1";

  return {
    opportunity: { opportunityId: stage.offer.offerId, scope, targetRef: CENTRAL_PROPOSAL_DEFINITION,
      instanceRef: stage.stageRef, sourceRef: stage.source.sourceBindingRef, stage: stage.source.domainStage.kind,
      conditionRef, baselineRef: "central:no-new-stage", windowRef, offer: stage.offer },
    source: stage.source,
    readiness: { kind: "ready", sourceRef: stage.source.sourceBindingRef, now: nowMs, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: CENTRAL_PROPOSAL_DEFINITION },
    fee: { kind: "hard-budget-only", sourceRef: budgetId }, purpose: "focused_learning",
    objective: { instanceId: `central-objective:${contentHashOf([issueId, stage.stageRef])}`,
      criterion: "proposal_delivered", definitionRef: CENTRAL_PROPOSAL_DEFINITION,
      familyRef: `central-proposal-family:${contentHashOf([domain, stage.policyFamily?.ref ?? stage.policyRef])}`,
      familySourceRef: stage.policyFamily?.sourceRef ?? stage.policyRef,
      ...(stage.policyFamily === undefined ? {} : { resourceModel: {
        kind: stage.policyFamily.response, sourceRef: stage.policyFamily.sourceRef } }) },
  };
}

/** The PA has already selected focused learning. Keep one original issue per
 * owner (explicit current focus first, then its oldest unresolved focused issue),
 * leaving private source/strategy selection in the original domain. */
export async function prepareCentralCandidates(options: {
  readonly board: BoardState; readonly scope: string; readonly focusIssueId?: string;
  readonly ports: readonly CentralLearningExecutionPort[]; readonly allowance: CentralLearningAllowance;
  readonly nowMs: number; readonly basis: LearningAllocationBasis;
  readonly admit?: (issueId: string, signal: AbortSignal) => Promise<{ readonly status: "ready" }
    | { readonly status: "blocked"; readonly reason: string; readonly sourceRefs: readonly string[] }>;
}, signal: AbortSignal) {
  const prepared: PreparedCentralCandidate[] = [];
  const unavailable: { issueId: string; reason: string; sourceRefs: readonly string[] }[] = [];

  for (const port of options.ports) {
    if (signal.aborted) break;

    const candidates = (options.board.learningIssues ?? []).filter(issue => issue.scope === options.scope
      && issue.decision.kind === "focused_learning"
      && (learningIssueOwner(issue) === "method" ? "prompt" : learningIssueOwner(issue)) === port.domain)
      .sort((a, b) => a.issueId === options.focusIssueId ? -1 : b.issueId === options.focusIssueId ? 1
        : a.createdAt.localeCompare(b.createdAt) || a.issueId.localeCompare(b.issueId));
    let selected = false;

    for (const issue of candidates) {
      if (signal.aborted || selected) break;

      const admission = await options.admit?.(issue.issueId, signal);
      if (admission?.status === "blocked") {
        unavailable.push({ issueId: issue.issueId, reason: admission.reason, sourceRefs: admission.sourceRefs });
        continue;
      }

      const pool = centralBudgetProjection(options.board, options.basis.budgetId);
      const existing = options.board.centralLearningGrants?.find(grant => grant.grantId === issue.grantId
        && grant.budgetId === options.basis.budgetId && grant.status === "open");
      const committed = existing === undefined ? { tokens: 0, calls: 0, steps: 0 } : grantResources(existing);
      // Available root resources and this issue's existing commitment form the
      // executable envelope. Other issues' commitments remain unavailable.
      const envelope = pool === undefined ? undefined : { ...options.allowance,
        maxTokens: Math.min(options.allowance.maxTokens, Math.max(0, pool.available.tokens) + committed.tokens),
        maxCalls: Math.min(options.allowance.maxCalls, Math.max(0, pool.available.calls) + committed.calls),
        maxSteps: Math.min(options.allowance.maxSteps, Math.max(0, pool.available.steps) + committed.steps) };
      if (envelope === undefined || envelope.maxTokens < 1 || envelope.maxCalls < 1 || envelope.maxSteps < 1) {
        unavailable.push({ issueId: issue.issueId, reason: "central_available_stage_resources_exhausted",
          sourceRefs: [options.basis.budgetId, issue.issueId] });
        continue;
      }

      const stage = await port.prepare({ issueId: issue.issueId, authorizedAllowance: envelope }, signal);
      if (stage.status !== "ready") {
        unavailable.push({ issueId: issue.issueId, reason: stage.reason, sourceRefs: stage.sourceRefs });
        continue;
      }

      selected = true;
      const candidate = centralCandidateForStage({ scope: options.scope, issueId: issue.issueId, domain: port.domain, stage,
        nowMs: options.nowMs, budgetId: options.basis.budgetId });

      prepared.push({ stage, port, candidate });
    }
  }

  return { prepared, unavailable };
}
