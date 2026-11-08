import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { projectCentralDecisionStage } from "../../learning/control/decision/stage-projection.js";
import { centralLearningSpent, type CoordinationAction } from "../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralFundedStage } from "./contracts.js";
import { inspectCentralFundedStage } from "./funded-stage.js";
import type { PreparedCentralCandidate } from "./candidates.js";
import { readRuntimeAgentBoard, runtimeAllowanceWithin, runtimeAgentCeiling, runtimeStageIsFree, type RuntimeAgentOptions } from "./runtime-agent-execution-prepare.js";
import type { CentralLearningConfiguration } from "../../learning/central/runtime/contracts.js";

/** Directly bind the model's explicit bounded investment to the existing root.
 * No invented numerical value or allocator submission is needed for authority. */
export async function fundRuntimeAgentStage(options: RuntimeAgentOptions, selected: PreparedCentralCandidate,
  budgetId: string, planRef: string, configuration: CentralLearningConfiguration, signal: AbortSignal): Promise<CentralFundedStage> {
  const rejected = (reason: string) => ({ status: "rejected" as const, reason });
  const before = await readRuntimeAgentBoard(options);
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return rejected(loaded.reason);

    if (loaded.state.sequence !== before.sequence) return rejected("central_runtime_agent_funding_stale");

    const { stage } = selected, projection = projectCentralDecisionStage({ ...stage.source, board: loaded.state,
      scope: options.scope, budgetId, offer: stage.offer });
    if (projection.status !== "ready" && projection.status !== "continue_existing" && projection.status !== "reconcile_then_replan") {
      return rejected(`central_runtime_agent_stage_${projection.status}`);
    }

    const previous = loaded.state.centralLearningGrants?.find(row => row.grantId === stage.source.grantId);
    const free = runtimeStageIsFree(stage.offer);
    if (free && previous === undefined) return rejected("central_runtime_agent_free_return_requires_original_grant");

    const spent = previous === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(previous);
    const desired = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
      maxTokens: spent.tokens + stage.offer.reserve.tokens, maxCalls: spent.calls + stage.offer.reserve.calls,
      maxSteps: spent.steps + stage.offer.reserve.steps,
      maxPromptChars: Math.max(previous?.allowance.maxPromptChars ?? 0, stage.offer.maxPromptChars) };
    const operationAuthorization = { ...desired, maxPromptChars: stage.offer.maxPromptChars };
    const ceiling = runtimeAgentCeiling(options, loaded.state, configuration.allowance, configuration.rootRef);
    if (!free && (!runtimeAllowanceWithin(operationAuthorization, stage.authorizedAllowance) || !runtimeAllowanceWithin(operationAuthorization, ceiling))) {
      return rejected("central_runtime_agent_lifetime_authorization_exceeded");
    }

    let action: CoordinationAction | undefined;

    if (previous === undefined) {
      if (projection.status !== "ready" || projection.mode !== "fund") return rejected("central_runtime_agent_initial_stage_required");
      action = { kind: "fund", issueId: stage.source.issueId, expectedRevision: projection.expectedIssueRevision,
        expectedSequence: loaded.state.sequence, grantId: stage.source.grantId, allowance: desired,
        domain: selected.port.domain, budgetId, authorizationRef: configuration.authorizationRef, planRef };
    } else if (free && previous.planRef !== planRef) {
      // Reattribute the same existing cap to this free handback. This neither
      // creates a grant nor reserves an extra token, call or step.
      action = { kind: "rebudget", grantId: previous.grantId, expectedSequence: loaded.state.sequence,
        authorizationRef: configuration.authorizationRef, planRef, limits: { tokens: previous.allowance.maxTokens,
          calls: previous.allowance.maxCalls, steps: previous.allowance.maxSteps } };
    } else if (!free && contentHashOf(previous.allowance) !== contentHashOf(desired)) {
      action = { kind: "rebudget", grantId: previous.grantId, expectedSequence: loaded.state.sequence,
        authorizationRef: configuration.authorizationRef, planRef, limits: { tokens: desired.maxTokens, calls: desired.maxCalls, steps: desired.maxSteps },
        ...(desired.maxPromptChars > previous.allowance.maxPromptChars ? { maxPromptChars: desired.maxPromptChars } : {}) };
    }

    const applied = action === undefined ? loaded : await store.apply({ type: "coordinate_learning",
      commandId: `central-runtime-agent:${contentHashOf(action)}`, issuedAt: options.now(), action });
    if (!applied.ok) return rejected(applied.reason);

    const issue = applied.state.learningIssues?.find(row => row.issueId === stage.source.issueId);
    if (issue === undefined) return rejected("central_runtime_agent_issue_missing_after_funding");

    const input = { issueId: issue.issueId, grantId: stage.source.grantId, expectedIssueRevision: issue.revision,
      stageRef: stage.stageRef, policyRef: stage.policyRef, sourceBindingRef: stage.source.sourceBindingRef, offer: stage.offer,
      ...(stage.sourceContext === undefined ? {} : { sourceContext: stage.sourceContext }) };
    const inspected = inspectCentralFundedStage(applied.state, { scope: options.scope, domain: selected.port.domain, input });
    if (!inspected.ok) return rejected(inspected.reason);

    return { status: "funded" as const, input };
  }, { commandGuard: () => options.enabled() && !signal.aborted });
  if ("ok" in result) throw new Error(result.reason);

  if (result.status === "rejected") throw new Error(result.reason);

  return result.input;
}
