import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import type { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { buildCollaborationCentralResearchRecord } from "../../learning/agent/subsystems/collaboration/control/central-research-record.js";
import { collaborationCentralResearchReports } from "../../learning/agent/subsystems/collaboration/control/central-research-report.js";
import { collaborationCentralResearchForIssue } from "../../learning/agent/subsystems/collaboration/control/central-research-context.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isCentralLearningSourceContext, type CentralLearningContextReader } from "../../learning/control/source-context.js";
import type { GroundedCentralResearch, CentralResearchGroundingOptions } from "./research-intake-common.js";
import type { CentralResearchReception } from "./contracts.js";

export type CentralCollaborationResearchOptions = CentralResearchGroundingOptions & {
  readonly control: Pick<ReturnType<typeof createCollaborationControl>, "report">;
  readonly now?: () => number;
};

const waiting = (reason: string, sourceRefs: readonly string[] = []): CentralResearchReception => ({ status: "waiting", reason, sourceRefs });

/** Intake creates only a truthful source and the original issue. The existing
 * central bridge still owns focus, allocation, the original grant and dispatch. */
export async function acceptCentralCollaborationResearch(options: CentralCollaborationResearchOptions,
  request: GroundedCentralResearch, signal: AbortSignal): Promise<CentralResearchReception> {
  if (signal.aborted || !options.enabled()) return waiting("collect_disabled", request.sourceRefs);

  if (request.domain !== "collaboration") return waiting("collaboration_research_domain_invalid", request.sourceRefs);

  const snapshot = { schema: "collaboration-central-research-request/v1" as const, scope: options.scope,
    requestRef: request.requestRef, intentRef: request.intent.intentId, intent: request.intent,
    operation: request.operation, materials: request.materials, sourceRefs: request.sourceRefs };
  const fact = buildCollaborationCentralResearchRecord(snapshot);
  if (fact === undefined) return waiting("collaboration_research_input_capacity", request.sourceRefs);

  const original = collaborationCentralResearchReports(snapshot, fact.id);
  const enabled = () => !signal.aborted && options.enabled();
  const board = createFileCollaborationBoard(options.boardRoot, enabled), now = options.now ?? Date.now;

  try {
    const loaded = await board.load();
    if (!loaded.ok) return waiting(loaded.reason, request.sourceRefs);

    const issue = loaded.state.learningIssues?.find(item => item.issueId === original.issueId && item.scope === options.scope);
    if (issue?.decision.kind === "resolved" || issue?.decision.kind === "ordinary_execution") {
      return waiting("collaboration_research_issue_closed", [issue.issueId, ...request.sourceRefs]);
    }

    const existing = loaded.state.rewardV2Facts?.find(item => item.id === fact.id);
    if (existing !== undefined) {
      if (existing.scope !== fact.scope || existing.algorithmVersion !== fact.algorithmVersion
        || existing.kind !== fact.kind || existing.payloadJson !== fact.payloadJson) return waiting("collaboration_research_record_conflict", [fact.id]);
    } else {
      const saved = await board.apply({ type: "record_reward_v2_fact", commandId: fact.id,
        issuedAt: new Date(now()).toISOString(), expectedSequence: loaded.state.sequence, fact });
      if (!saved.ok) return waiting(saved.reason, request.sourceRefs);
    }

    for (const report of original.reports) {
      if (!enabled()) return waiting("collect_disabled", [fact.id]);

      const reported = await options.control.report({ scope: options.scope, issueId: original.issueId,
        problemKey: original.problemKey, report });
      if (!reported.ok) return waiting(reported.reason, [fact.id]);

      if (reported.issue.issueId !== original.issueId) return waiting("collaboration_research_issue_changed", [fact.id]);

      if (reported.issue.decision.kind === "resolved" || reported.issue.decision.kind === "ordinary_execution") {
        return waiting("collaboration_research_issue_closed", [reported.issue.issueId, fact.id]);
      }
    }

    return enabled() ? { status: "accepted", issueId: original.issueId,
      sourceRefs: [...new Set([fact.id, request.requestRef, request.intent.intentId, ...request.sourceRefs])] }
      : waiting("collect_disabled", [fact.id]);
  } catch { return waiting("collaboration_research_intake_unconfirmed", [fact.id]); }
}

/** Keep the complete frozen purpose in the production worker request even when
 * no central-runtime context reader was supplied by a legacy host. */
export function createCentralCollaborationResearchContextReader(options: {
  readonly boardRoot: string; readonly scope: string; readonly fallback?: CentralLearningContextReader;
}): CentralLearningContextReader {
  return async issueId => {
    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) throw new Error(loaded.reason);

    const issue = loaded.state.learningIssues?.find(item => item.issueId === issueId && item.scope === options.scope);
    if (issue === undefined) return options.fallback?.(issueId);

    const research = collaborationCentralResearchForIssue(loaded.state, options.scope, issue);
    if (research.status === "absent") return options.fallback?.(issueId);

    if (research.status === "rejected") throw new Error(research.reason);

    const context = await options.fallback?.(issueId);
    const text = canonicalJson({ schema: "collaboration-central-research-context/v1", request: research.request,
      ...(context === undefined ? {} : { centralContext: context }) });
    const value = { ref: `collaboration-central-context:${contentHashOf([research.recordRef, context ?? null])}`, text };
    if (!isCentralLearningSourceContext(value)) throw new Error("collaboration_research_context_capacity");

    return value;
  };
}
