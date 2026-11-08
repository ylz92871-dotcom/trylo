import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { decodeToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { planForJob } from "./pipeline-queue.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { taskFeedbackForCandidate, toolTaskFeedbackContext } from "./tool-task-feedback.js";
import type { BoardState } from "../../../../control/state.js";
import { assessedUsageLessonsFromBoard } from "./usage-lessons.js";
import type { ToolUsageContext } from "../domain/evolution/learning-plan.js";
import type { AssessedToolUsageLesson } from "../domain/evolution/usage-learning.js";

/** Retrieve only scoped usage choices; consumers assess applicability, never receive asset source or grant authority. */
export async function readToolUsageContext(boardRoot: string, scope: string, query?: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const rows: { readonly capability: string; readonly toolId: string; readonly action: "reuse" | "refine";
    readonly usage: string; readonly rationale: string; readonly decisionVersionId: string; readonly authority: "model_proposal";
    readonly standing: AssessedToolUsageLesson["standing"] | "unbound_proposal"; readonly conditions?: ToolUsageContext;
    readonly toolVersionId?: string; readonly effectiveSituations?: readonly string[] }[] = [];
  const fallback: typeof rows = [];
  const assessments = new Map<string, readonly AssessedToolUsageLesson[]>();

  for (const asset of [...loaded.state.assets].reverse()) {
    if (asset.scope !== scope || asset.kind !== "workflow" || !assetAvailable(loaded.state, asset) || !recordOf(asset.content)
      || asset.content.type !== "tool_learning_decision" || typeof asset.content.jobId !== "string") continue;

    const decision = decodeToolLearningDecision(asset.content.decision), plan = planForJob(loaded.state, asset.content.jobId);
    if (decision === undefined || plan === undefined || (decision.action !== "reuse" && decision.action !== "refine")) continue;

    let standing: AssessedToolUsageLesson["standing"] | "unbound_proposal" = "unbound_proposal";
    let lesson: AssessedToolUsageLesson | undefined;
    const versionId = typeof asset.content.selectedToolVersionId === "string" ? asset.content.selectedToolVersionId : undefined;
    if (versionId !== undefined && decision.usageContext !== undefined) {
      if (!assessments.has(versionId)) {
        const assessed = assessedUsageLessonsFromBoard(loaded.state, versionId);
        if (!assessed.ok) return assessed;
        assessments.set(versionId, assessed.lessons);
      }

      lesson = assessments.get(versionId)?.find(item => item.decisionVersionId === asset.versionId);
      standing = lesson?.standing ?? "unbound_proposal";
    }

    const row: typeof rows[number] = { capability: plan.capability, toolId: decision.toolId, action: decision.action, usage: decision.usage,
      rationale: decision.rationale, decisionVersionId: asset.versionId, authority: "model_proposal", standing,
      ...(decision.usageContext === undefined ? {} : { conditions: decision.usageContext }),
      ...(versionId === undefined ? {} : { toolVersionId: versionId }),
      ...(lesson === undefined ? {} : { effectiveSituations: lesson.effectiveSituations }) };
    const matched = query === undefined || `${row.capability} ${row.toolId} ${row.conditions?.situations.join(" ") ?? ""}`
      .toLocaleLowerCase().includes(query.toLocaleLowerCase());
    if (matched) rows.push(row);
    else if (fallback.length < 8) fallback.push(row);

    if (rows.length === 8) break;
  }

  const feedback = readScopedFeedback(loaded.state, scope, query);
  if (!feedback.ok) return feedback;

  return { ok: true as const, guidance: rows.length === 0 ? fallback : rows, feedback: feedback.rows,
    relevance: query === undefined || rows.length > 0 ? "scoped_context" as const : "bounded_fallback_assess_relevance" as const };
}

/** Proposed usage and observed assessments are separate channels. Consumers can
 * reason about the reported situation without turning one failure into a ban. */
function readScopedFeedback(state: BoardState, scope: string, query?: string) {
  const rows: { readonly versionId: string; readonly capability: string; readonly toolId: string;
    readonly evidence: string; readonly authority: "task_assessments" }[] = [];
  const visited = new Set<string>();

  for (const asset of [...state.assets].reverse()) {
    if (asset.kind !== "tool_package" || !assetAvailable(state, asset)) continue;

    const production = decodeToolProductionPlan(asset.content);
    const owned = asset.scope === scope || production?.origin.scope === scope || production?.workspaceId === scope;
    if (!owned) continue;

    const selected = toolLearningParentFromBoard(state, asset.versionId);
    if (!selected.ok) return selected;

    const parent = selected.parent;
    if (visited.has(parent.versionId)) continue;

    visited.add(parent.versionId);
    const feedback = taskFeedbackForCandidate(state, parent.versionId);
    if (!feedback.ok) return feedback;

    // Once a version is retrieved, retain its contrary assessments. Filtering each
    // report by the query used to lose the counterexample that qualified a success.
    const evidence = toolTaskFeedbackContext(feedback.records);
    if (evidence === undefined) continue;

    rows.push({ versionId: parent.versionId, capability: parent.capability, toolId: parent.identity, evidence, authority: "task_assessments" });

    if (rows.length === 8) break;
  }

  const matching = query === undefined ? rows : rows.filter(row => `${row.capability} ${row.toolId} ${row.evidence}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  return { ok: true as const, rows: matching.length === 0 ? rows : matching };
}
