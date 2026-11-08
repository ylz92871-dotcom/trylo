import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { candidateToolName } from "../domain/evolution/use.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { createFileRefinementStore } from "./overlay-file.js";
import { taskFeedbackFromBoard } from "./tool-task-feedback.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolFeedbackEntry } from "./tool-task-feedback.js";

/** Returned calls are not successful trajectories; an identified task outcome must corroborate them. */
export async function readToolDecisionHistory(boardRoot: string, ledgerRoot: string, tool: string | undefined) {
  const refinementAttemptedFor = createFileRefinementStore(ledgerRoot).all().filter(entry => typeof entry.tool === "string"
    && typeof entry.refinedAt === "string" && Array.isArray(entry.evidenceRefs) && entry.evidenceRefs.length > 0).map(entry => entry.tool);

  if (tool === undefined) return { refinementAttemptedFor, successfulTrajectories: 0 };

  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) throw new Error(`tool_history_unavailable:${loaded.reason}`);

  const matchedVersions = new Set<string>();

  for (const asset of loaded.state.assets) {
    if (asset.kind !== "tool_package") continue;
    const candidate = candidateFromBoard(loaded.state, asset.versionId);
    if (candidate.ok && (candidate.artifact.candidate.identity === tool
      || candidateToolName(candidate.artifact.candidate.identity, candidate.artifact.verification.candidateHash) === tool)) matchedVersions.add(asset.versionId);
    const plan = decodeToolProductionPlan(asset.content);
    if (plan !== undefined && (plan.candidate.identity === tool || candidateToolName(plan.candidate.identity, contentHashOf(plan)) === tool)) matchedVersions.add(asset.versionId);
  }

  const entries: ToolFeedbackEntry[] = [];

  for (const versionId of matchedVersions) {
    const feedback = taskFeedbackFromBoard(loaded.state, versionId);
    if (!feedback.ok) throw new Error(`tool_history_unavailable:${feedback.code}`);
    entries.push(...feedback.entries);
  }

  // A later correction of the same task replaces its earlier outcome rather than
  // leaving a permanent success in the escalation heuristic.
  const order = new Map(loaded.state.assets.map((asset, index) => [asset.versionId, index]));

  entries.sort((left, right) => order.get(left.feedbackVersionId)! - order.get(right.feedbackVersionId)!);
  const assessments = new Map<string, { readonly solved: boolean; readonly returned: boolean }>();

  for (const { feedback: record } of entries) {
    if (record.source !== "user" && record.source !== "verifier") continue;
    const uses = (loaded.state.toolUses ?? []).filter(use => record.useIds.includes(use.useId));
    assessments.set(JSON.stringify([record.sessionId, record.taskId]), {
      solved: record.outcome === "solved", returned: uses.some(use => use.execution === "returned") });
  }

  return { refinementAttemptedFor, successfulTrajectories: [...assessments.values()].filter(outcome => outcome.solved && outcome.returned).length };
}
