import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { centralSkillResearchIssueId, type CentralSkillResearchRequest } from "../../learning/agent/subsystems/skill/control/central-research-request.js";
import { centralSkillResearchReport, saveCentralSkillResearchRequest } from "../../learning/agent/subsystems/skill/control/central-research-board.js";
import type { CentralResearchReception } from "./contracts.js";
import type { GroundedCentralResearch } from "./research-intake-common.js";

export interface CentralSkillResearchReceiverOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly workspaceRoot: string;
  readonly enabled: () => boolean;
  readonly now?: () => number;
}

/** Translate an already grounded central purpose into the original skill owner.
 * Focusing, funding, native review and approval remain at their existing ports. */
export async function acceptCentralSkillResearch(options: CentralSkillResearchReceiverOptions,
  request: GroundedCentralResearch, signal: AbortSignal): Promise<CentralResearchReception> {
  const waiting = (reason: string, sourceRefs = request.sourceRefs): CentralResearchReception => ({ status: "waiting", reason, sourceRefs });

  if (signal.aborted) return waiting("learning_aborted");

  if (!options.enabled()) return waiting("collect_disabled");

  if (request.domain !== "skill") return waiting("hermes_research_destination_invalid");

  const now = options.now ?? Date.now;
  const received = await withBoardWriter(options.boardRoot, async store => {
    if (signal.aborted || !options.enabled()) return waiting(signal.aborted ? "learning_aborted" : "collect_disabled");

    const native: CentralSkillResearchRequest = { schemaVersion: 1, type: "skill_research_request", scope: options.scope,
      workspaceRoot: options.workspaceRoot, requestRef: request.requestRef, intentRef: request.intent.intentId,
      intent: request.intent, operation: request.operation, materials: request.materials, sourceRefs: request.sourceRefs };
    const issuedAt = new Date(now()).toISOString();
    const source = await saveCentralSkillResearchRequest(store, native, issuedAt, signal);
    if (source.status !== "found") return waiting(source.status === "invalid" ? source.reason : "hermes_research_source_missing");

    if (signal.aborted || !options.enabled()) return waiting(signal.aborted ? "learning_aborted" : "collect_disabled");

    const issueId = centralSkillResearchIssueId(source.request), report = centralSkillResearchReport(source);
    const loaded = await store.load();
    if (!loaded.ok) return waiting(loaded.reason, report.evidenceRefs);

    const previous = loaded.state.learningIssues?.find(item => item.issueId === issueId && item.scope === options.scope);
    if (previous?.decision.kind === "ordinary_execution" || previous?.decision.kind === "resolved") {
      return waiting("hermes_research_native_purpose_closed", [issueId, ...report.evidenceRefs]);
    }

    const action = { kind: "report" as const, scope: options.scope, issueId,
      problemKey: `skill-research:${contentHashOf([options.scope, request.requestRef])}`, report };
    const recorded = await store.apply({ type: "coordinate_learning", commandId: `skill-research-intake:${contentHashOf(action)}`, issuedAt, action });
    if (!recorded.ok) return waiting(recorded.reason, report.evidenceRefs);

    const issue = recorded.state.learningIssues?.find(item => item.issueId === issueId);
    if (issue === undefined) return waiting("learning_issue_not_found", report.evidenceRefs);

    // A duplicate request never reopens an original native review or a grant.
    return { status: "accepted" as const, issueId, sourceRefs: report.evidenceRefs };
  }, { commandGuard: () => !signal.aborted && options.enabled() });

  return "reason" in received && !("status" in received) ? waiting(received.reason) : received;
}
