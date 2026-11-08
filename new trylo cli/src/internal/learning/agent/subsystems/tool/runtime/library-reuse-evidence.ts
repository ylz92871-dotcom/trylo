import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolProductionPlan, type ToolProductionPlan } from "../domain/evolution/production-plan.js";
import { toolReuseExampleCoverage, type ToolReuseContractEvidence, type ToolReuseTaskSample } from "../domain/evolution/reuse-evidence.js";
import { selectToolTaskAssessments } from "../domain/evolution/feedback-evidence.js";
import type { ToolReuseSummary } from "../domain/evolution/reuse-retrieval.js";
import { productionFromBoard } from "./production-assets.js";
import { taskFeedbackFromBoard } from "./tool-task-feedback.js";

/** Enrich only tools the current host inventory already exposes. Historical data
 * can explain a choice; it can never configure, grant or resurrect a callable tool. */
export function toolLibraryReuseEvidence(state: BoardState, scope: string, tools: readonly ToolReuseSummary[],
  taskSamples: readonly ToolReuseTaskSample[]) {
  const evidence: ToolReuseContractEvidence[] = [];

  for (const tool of tools.slice(0, 24)) {
    if (tool.versionId === undefined) continue;

    const raw = state.assets.find(asset => asset.versionId === tool.versionId)?.content;
    const decoded = decodeToolProductionPlan(raw);

    // Builtins, plugins and explicitly mounted lab tools keep their original
    // inventory entry. This projection has no authority to invent their checks.
    if (decoded === undefined) continue;

    // The host may legitimately expose a workspace production tool whose
    // original learning contract belongs to a separate scope. Keep that offered
    // tool usable, without importing its contract or feedback into this learner.
    // Missing optional evidence means unknown fit, never incompatibility.
    if (decoded.origin.scope !== scope) continue;

    const selected = productionFromBoard(state, tool.versionId, decoded.workspaceId);
    if (!selected.ok) return selected;

    const plan = selected.plan, feedback = taskFeedbackFromBoard(state, tool.versionId);
    if (!feedback.ok) return feedback;

    const external = feedback.entries.filter(entry => entry.feedback.source === "user" || entry.feedback.source === "verifier");
    const latest = new Map<string, typeof external[number]>();

    for (const row of external) latest.set(JSON.stringify([row.feedback.sessionId, row.feedback.taskId, row.feedback.situation]), row);

    const kept = selectToolTaskAssessments([...latest.values()].map(row => row.feedback), 4);
    const taskAssessments: ToolReuseContractEvidence["taskAssessments"] = kept.flatMap(report => {
      if (report.source !== "user" && report.source !== "verifier") return [];
      const entry = external.find(row => row.feedback === report)!;
      return [{ feedbackRef: entry.feedbackVersionId, situation: report.situation, outcome: report.outcome,
        recommendation: report.recommendation, reportedBy: report.source,
        returnedUseIds: (state.toolUses ?? []).filter(use => report.useIds.includes(use.useId) && use.execution === "returned").map(use => use.useId) }];
    });

    evidence.push({ toolId: tool.toolId, versionId: tool.versionId, contractHash: contentHashOf(plan.checks.evidence),
      implementationHash: toolImplementationHash(plan), taskExamples: toolReuseExampleCoverage(plan.checks.evidence, taskSamples),
      contractScope: { sourceCases: plan.checks.evidence.filter(sample => sample.role === "source").length,
        heldOutCases: plan.checks.evidence.filter(sample => sample.role !== "source").length, generalization: "not_established" },
      sameImplementationAs: [], taskAssessments });
  }

  return { ok: true as const, evidence: evidence.map(row => ({ ...row, sameImplementationAs: evidence.filter(other => other.toolId !== row.toolId
    && other.implementationHash === row.implementationHash).map(other => ({ toolId: other.toolId, versionId: other.versionId })) })) };
}

/** Labels/descriptions may differ. Equality is deliberately limited to the exact
 * executable bytes/configuration and input ABI; it is not semantic deduplication. */
function toolImplementationHash(plan: ToolProductionPlan): string {
  return contentHashOf({ inputSchema: plan.candidate.inputSchema, runtime: plan.type === "tool_production_package"
    ? { profile: "confined_json_function_v1", source: plan.candidate.source }
    : { installationId: plan.origin.versionId, installationHash: plan.origin.contentHash, runtime: plan.runtime, patches: plan.patches ?? [] } });
}
