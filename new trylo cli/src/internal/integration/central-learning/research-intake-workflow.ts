import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { workflowImprovementsFromBoard } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { buildWorkflowCentralResearchSource } from "../../learning/agent/subsystems/workflow/adapters/central-research-source.js";
import { workflowImprovementRecordId, workflowImprovementSourceBindingRef } from "../../learning/agent/subsystems/workflow/runtime/improvement-identities.js";
import type { CentralResearchReception } from "./contracts.js";
import type { CentralWorkflowExecution } from "./workflow.js";
import type { GroundedCentralResearch } from "./research-intake-common.js";
import { centralResearchEpisodeEvidence } from "./research-intake-episode.js";

export interface WorkflowResearchReceptionOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly workspaceId: string;
  readonly enabled: () => boolean;
  readonly workflow: Pick<CentralWorkflowExecution, "queueOpportunity">;
}

/** The native opportunity producer owns persistence/nomination. This adapter
 * never creates a grant, reopens the parent business issue or starts a worker. */
export async function acceptCentralWorkflowResearch(options: WorkflowResearchReceptionOptions,
  request: GroundedCentralResearch, signal: AbortSignal): Promise<CentralResearchReception> {
  const waiting = (reason: string, refs = request.sourceRefs): CentralResearchReception => ({ status: "waiting", reason, sourceRefs: refs });

  if (!options.enabled() || signal.aborted) return waiting("central_research_intake_cancelled");

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return waiting(loaded.reason);

  const view = workflowImprovementsFromBoard(loaded.state, options.workspaceId, options.scope);
  if (!view.ok) return waiting(view.code);

  const existing = view.value.opportunities.find(row => row.record.opportunity.opportunityId === request.requestRef);
  if (existing !== undefined) {
    const issue = loaded.state.learningIssues?.find(row => row.scope === options.scope && row.reports.some(report =>
      "subsystem" in report.source && report.source.subsystem === "workflow" && report.source.versionId === existing.versionId));
    if (issue !== undefined) {
      if (issue.decision.kind === "ordinary_execution" || issue.decision.kind === "resolved") {
        return waiting("workflow_research_native_purpose_closed", [issue.issueId, existing.versionId]);
      }
      return { status: "accepted", issueId: issue.issueId, sourceRefs: [request.requestRef, existing.versionId, request.intent.intentId,
        workflowImprovementSourceBindingRef(options.scope, existing.versionId)] };
    }
  }

  const built = existing === undefined ? buildWorkflowCentralResearchSource({ requestRef: request.requestRef,
    intentRef: request.intent.intentId, goal: request.intent.goal, rationale: request.intent.rationale,
    conditions: request.intent.conditions, citations: request.intent.derivation?.citations ?? [], materials: request.materials,
    lineageEvidence: centralResearchEpisodeEvidence(request) }, options.workspaceId)
    : { status: "ready" as const, record: existing.record };
  if (built.status !== "ready") return built;

  if (!options.enabled() || signal.aborted) return waiting("central_research_intake_cancelled");

  const nominated = await options.workflow.queueOpportunity(built.record, signal);
  if (!nominated.ok) return waiting(nominated.code, [request.requestRef, workflowImprovementRecordId(built.record)]);

  return { status: "accepted", issueId: nominated.value.issueId, sourceRefs: [request.requestRef,
    nominated.value.inputVersionId, request.intent.intentId, nominated.value.sourceBindingRef] };
}
