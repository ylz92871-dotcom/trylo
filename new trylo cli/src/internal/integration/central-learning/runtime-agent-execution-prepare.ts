import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralLearningAllowance, CentralLearningGrantAllowance, CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../learning/control/coordination-parse.js";
import { allocationFits } from "../../learning/control/allocation-shape.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { CentralLearningSubject } from "../../learning/central/runtime/contracts.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { isCentralLearningBudgetRootRef } from "../../learning/control/central-budget-parse.js";
import type { BoardState } from "../../learning/control/state.js";
import type { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import type { CentralLearningExecutionPort } from "./contracts.js";
import { centralCandidateForStage, type PreparedCentralCandidate, type prepareCentralCandidates } from "./candidates.js";
import { runtimeAllowanceWithin, runtimeStageIsFree } from "./runtime-agent-execution-envelope.js";
import { CentralRuntimeBlocked } from "../../learning/central/runtime/errors.js";
import { isCentralLearningSourceContext } from "../../learning/control/source-context.js";

export { runtimeAllowanceWithin, runtimeStageIsFree } from "./runtime-agent-execution-envelope.js";

export type CentralRuntimeAgentExecutionOptions = {
  readonly boardRoot: string; readonly scope: string; readonly ports: readonly CentralLearningExecutionPort[];
  readonly control: Pick<ReturnType<typeof createCollaborationControl>, "decide">;
  readonly enabled: () => boolean; readonly now: () => string;
  /** Independent cumulative authorization. operation.allowance is incremental. */
  readonly rootAllowance: CentralLearningGrantAllowance; readonly authorizationRef: string;
  /** Saved exact identity, also available to consultation before any prepare. */
  readonly rootRef?: CentralLearningBudgetRootRef;
  readonly admit?: Parameters<typeof prepareCentralCandidates>[0]["admit"];
};

export type RuntimeAgentOptions = CentralRuntimeAgentExecutionOptions;

export async function readRuntimeAgentBoard(options: RuntimeAgentOptions) {
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.state;
}

export function assertRuntimeAgentActive(options: RuntimeAgentOptions, signal: AbortSignal) {
  if (!options.enabled() || signal.aborted) throw new Error("central_runtime_learning_inactive");
}

export function runtimeAgentIssue(options: RuntimeAgentOptions, board: Awaited<ReturnType<typeof readRuntimeAgentBoard>>,
  subject: CentralLearningSubject) {
  if (subject.plane !== "agent") throw new Error("central_runtime_agent_subject_required");
  const issue = board.learningIssues?.find(row => row.issueId === subject.issueId && row.scope === options.scope);
  const owner = issue === undefined ? undefined : learningIssueOwner(issue);
  if (issue === undefined || (owner === "method" ? "prompt" : owner) !== subject.domain) throw new Error("central_runtime_agent_issue_mismatch");
  return issue;
}

export function runtimeAgentCeiling(options: RuntimeAgentOptions, board: BoardState, configured: CentralLearningGrantAllowance,
  rootRef: CentralLearningBudgetRootRef | undefined = options.rootRef): CentralLearningGrantAllowance {
  const root = board.centralLearningBudgets?.find(row => row.scope === options.scope);

  if (rootRef === undefined) {
    if (!runtimeAllowanceWithin(configured, options.rootAllowance)) throw new Error("central_runtime_agent_allowance_exceeds_authorization");
    if (root !== undefined && contentHashOf(root.limits) !== contentHashOf({ tokens: configured.maxTokens, calls: configured.maxCalls, steps: configured.maxSteps })) {
      throw new Error("central_learning_fixed_budget_mismatch");
    }
    return configured;
  }

  if (!isCentralLearningBudgetRootRef(rootRef) || rootRef.scope !== options.scope || root?.budgetId !== rootRef.budgetId
    || root.openedSequence !== rootRef.openedSequence || root.authorizationRef !== rootRef.authorizationRef) {
    throw new Error("learning_budget_binding");
  }

  const ceiling = { ...configured, maxTokens: root.limits.tokens, maxCalls: root.limits.calls,
    maxSteps: root.limits.steps, maxPromptChars: Math.min(configured.maxPromptChars, options.rootAllowance.maxPromptChars) };
  if (!isCentralLearningGrantAllowance(ceiling)) {
    throw new Error("central_runtime_agent_lifetime_authorization_exhausted");
  }

  return ceiling;
}

export async function applyRuntimeAgentAction(options: RuntimeAgentOptions, action: CoordinationAction, signal: AbortSignal) {
  assertRuntimeAgentActive(options, signal);
  const applied = await withBoardWriter(options.boardRoot, store => store.apply({ type: "coordinate_learning",
    commandId: `central-runtime-agent:${contentHashOf(action)}`, issuedAt: options.now(), action }),
  { commandGuard: () => options.enabled() && !signal.aborted });
  if (!applied.ok) throw new Error(applied.reason);
  return applied.state;
}

/** Original domain prepare consumes a lifetime envelope. Add the already charged
 * prefix once, then require its actual offer to fit this operation's increment. */
export async function prepareRuntimeAgentSource(options: RuntimeAgentOptions, subject: CentralLearningSubject,
  increment: CentralLearningAllowance, configured: CentralLearningGrantAllowance, signal: AbortSignal, allowReduction = false,
  rootRef?: CentralLearningBudgetRootRef) {
  assertRuntimeAgentActive(options, signal);
  let board = await readRuntimeAgentBoard(options);
  const ceiling = runtimeAgentCeiling(options, board, configured, rootRef);

  if (!isCentralLearningAllowance(increment)) throw new Error("central_runtime_agent_allowance_exceeds_authorization");

  let issue = runtimeAgentIssue(options, board, subject);
  const root = board.centralLearningBudgets?.find(row => row.scope === options.scope);
  const pool = root === undefined ? undefined : centralBudgetProjection(board, root.budgetId);
  if (root === undefined || pool === undefined) throw new CentralRuntimeBlocked("central_runtime_agent_budget_unavailable", [options.scope], "resources");

  const previous = board.centralLearningGrants?.find(row => row.grantId === issue.grantId && row.status === "open");
  if (previous !== undefined && previous.budgetId !== root.budgetId) throw new Error("central_runtime_agent_independent_grant");

  const spent = previous === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(previous);
  const lifetime = { ...increment, maxTokens: spent.tokens + increment.maxTokens,
    maxCalls: spent.calls + increment.maxCalls, maxSteps: spent.steps + increment.maxSteps };
  const fitsAuthorization = runtimeAllowanceWithin(increment, ceiling) && runtimeAllowanceWithin(lifetime, ceiling);

  // Some original adapters reject a smaller authorization while an idle old cap
  // remains committed. Only dispatch preparation may explicitly reduce that cap.
  if (fitsAuthorization && pool.status !== "held" && allowReduction && previous !== undefined) {
    const limits = { tokens: Math.min(previous.allowance.maxTokens, lifetime.maxTokens),
      calls: Math.min(previous.allowance.maxCalls, lifetime.maxCalls), steps: Math.min(previous.allowance.maxSteps, lifetime.maxSteps) };
    if (contentHashOf(limits) !== contentHashOf({ tokens: previous.allowance.maxTokens, calls: previous.allowance.maxCalls, steps: previous.allowance.maxSteps })) {
      board = await applyRuntimeAgentAction(options, { kind: "rebudget", grantId: previous.grantId, expectedSequence: board.sequence,
        authorizationRef: options.authorizationRef, planRef: `runtime-operation-cap:${contentHashOf([subject, increment])}`, limits }, signal);
      issue = runtimeAgentIssue(options, board, subject);
    }
  }

  const port = options.ports.find(row => subject.plane === "agent" && row.domain === subject.domain);
  if (port === undefined) throw new Error("central_runtime_agent_domain_unavailable");

  const basis = { scope: options.scope, budgetId: root.budgetId, boardSequence: board.sequence,
    utilityUnit: "qualified_objective_completions", valuationRef: "central-runtime:optional-numerical-consultation:v1" };
  const unavailable = (reason: string, sourceRefs: readonly string[], boundary: "preparation" | "dependency" = "preparation") => ({ status: "unavailable" as const,
    unavailable: [{ issueId: issue.issueId, reason, sourceRefs }], basis, boundary });
  const admitted = await options.admit?.(issue.issueId, signal);
  if (admitted?.status === "blocked") return unavailable(admitted.reason, admitted.sourceRefs);

  if (!fitsAuthorization && previous === undefined) throw new CentralRuntimeBlocked("central_runtime_agent_lifetime_authorization_exhausted",
    [root.budgetId, issue.issueId], "resources");

  // With no paid increment available, probe only the original cumulative grant
  // for a true zero-reserve return. The separate positive operation envelope
  // never replenishes that lifetime or authorizes an extra provider call.
  const authorized = fitsAuthorization && pool.status !== "held" ? { ...lifetime,
    maxTokens: Math.min(lifetime.maxTokens, (previous?.allowance.maxTokens ?? 0) + Math.max(0, pool.available.tokens)),
    maxCalls: Math.min(lifetime.maxCalls, (previous?.allowance.maxCalls ?? 0) + Math.max(0, pool.available.calls)),
    maxSteps: Math.min(lifetime.maxSteps, (previous?.allowance.maxSteps ?? 0) + Math.max(0, pool.available.steps)) } : previous?.allowance;
  if (authorized === undefined) throw new CentralRuntimeBlocked("central_runtime_agent_budget_unavailable", [root.budgetId], "resources");

  const stage = await port.prepare({ issueId: issue.issueId, authorizedAllowance: authorized, operationAllowance: increment }, signal);
  if (stage.status !== "ready") return unavailable(stage.reason, stage.sourceRefs, stage.status === "waiting" ? "dependency" : "preparation");

  if (stage.sourceContext !== undefined && !isCentralLearningSourceContext(stage.sourceContext)) {
    throw new CentralRuntimeBlocked("central_stage_source_context_invalid", [issue.issueId], "preparation");
  }

  if (stage.source.issueId !== issue.issueId || stage.offer.owner.plane !== "agent" || stage.offer.owner.domain !== port.domain) {
    throw new Error("central_runtime_agent_prepared_source_mismatch");
  }

  if (runtimeStageIsFree(stage.offer)) {
    if (previous === undefined || stage.source.grantId !== previous.grantId) throw new Error("central_runtime_agent_free_return_requires_original_grant");
  } else {
    if (!fitsAuthorization) throw new CentralRuntimeBlocked("central_runtime_agent_lifetime_authorization_exhausted", [root.budgetId, issue.issueId], "resources");
    if (pool.status === "held") throw new CentralRuntimeBlocked("central_runtime_agent_budget_unavailable", [root.budgetId], "resources");
    if (!allocationFits(stage.offer.reserve, { tokens: increment.maxTokens, calls: increment.maxCalls, steps: increment.maxSteps })
      || stage.offer.maxPromptChars > increment.maxPromptChars || !runtimeAllowanceWithin(stage.authorizedAllowance, ceiling)) {
      throw new Error("central_runtime_agent_stage_exceeds_operation");
    }
  }

  const selected: PreparedCentralCandidate = { stage, port, candidate: centralCandidateForStage({ scope: options.scope,
    issueId: issue.issueId, domain: port.domain, stage, nowMs: Date.parse(options.now()), budgetId: root.budgetId }) };

  return { status: "ready" as const, selected, basis };
}
