import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { decodeToolTaskFeedbackArtifact } from "../domain/evolution/task-feedback.js";
import { enqueueToolLearningPlan, planForJob } from "./pipeline-queue.js";
import { assetAvailable } from "./pipeline-assets.js";
import { recordToolTaskFeedback } from "./tool-task-feedback.js";
import type { BoardState } from "../../../../control/state.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { feedbackHandoffFromBoard, saveToolFeedbackHandoff } from "./feedback-handoff.js";
import { selectToolFeedbackInquiry, toolFeedbackChangeKind } from "./feedback-inquiry.js";
import type { ToolTaskFeedback } from "../domain/evolution/task-feedback.js";

export async function recordAndScheduleToolTaskFeedback(boardRoot: string, raw: unknown, issuedAt: string) {
  const saved = await recordToolTaskFeedback(boardRoot, raw, issuedAt);
  if (!saved.ok) return saved;
  // Separate commits let replay repair a lost handoff without running an external action twice.
  return { ...saved, learning: await scheduleToolTaskFeedback(boardRoot, saved.feedbackVersionId) };
}

export type FeedbackLearningHandoff =
  | { readonly kind: "queued"; readonly jobId: string }
  | { readonly kind: "not_requested"; readonly reason: "no_attributed_change" | "unsupported_parent" | "outside_scope" | "already_scheduled"; readonly jobId?: string }
  | { readonly kind: "unavailable"; readonly code: string };

/** A stable plan identity is also the crash-recovery handoff: replay never creates another job. */
export async function scheduleToolTaskFeedback(boardRoot: string, feedbackVersionId: string, scope?: string): Promise<FeedbackLearningHandoff> {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { kind: "unavailable", code: loaded.reason };

  const selected = planForFeedback(loaded.state, feedbackVersionId, scope);
  if (selected.kind !== "plan") return selected;

  const assigned = feedbackHandoffFromBoard(loaded.state, feedbackVersionId);
  if (!assigned.ok) return { kind: "unavailable", code: assigned.code };

  if (assigned.jobId !== undefined) return feedbackJobOutcome(loaded.state, assigned.jobId);

  const inquiry = selectToolFeedbackInquiry(loaded.state, { ...selected, feedbackVersionId });
  if (!inquiry.ok) return { kind: "unavailable", code: inquiry.code };

  const anchor = inquiry.anchorFeedbackVersionId === undefined ? selected : planForFeedback(loaded.state, inquiry.anchorFeedbackVersionId, scope);
  if (anchor.kind !== "plan") return { kind: "unavailable", code: "invalid_tool_feedback_inquiry" };

  const pending = inquiry.existingJobId ?? pendingFeedbackJob(loaded.state, anchor.plan, selected.situation, selected.feedback.versionId);
  const queued = pending === undefined ? await enqueueToolLearningPlan(boardRoot, anchor.plan) : { ok: true as const, jobId: pending, state: "queued" };
  if (!queued.ok) return { kind: "unavailable", code: queued.code };

  const saved = await saveToolFeedbackHandoff(boardRoot, { feedbackVersionId, jobId: queued.jobId,
    plan: anchor.plan, situation: selected.situation, issuedAt: selected.plan.createdAt });
  if (!saved.ok) return { kind: "unavailable", code: saved.code };

  if (inquiry.existingJobId !== undefined) return { kind: "not_requested", reason: "already_scheduled", jobId: inquiry.existingJobId };

  return queued.state === "queued" ? { kind: "queued", jobId: queued.jobId } : { kind: "not_requested", reason: "already_scheduled" };
}

function planForFeedback(state: BoardState, feedbackVersionId: string, scope?: string): FeedbackLearningHandoff | {
  readonly kind: "plan"; readonly plan: ToolLearningPlan; readonly situation: string; readonly feedback: ToolTaskFeedback;
} {
  const asset = state.assets.find(item => item.versionId === feedbackVersionId);
  const artifact = asset === undefined ? undefined : decodeToolTaskFeedbackArtifact(asset.content);
  if (asset === undefined || artifact === undefined || !assetAvailable(state, asset)) return { kind: "unavailable", code: "invalid_tool_feedback_asset" };

  const feedback = artifact.feedback;
  const change = toolFeedbackChangeKind(feedback);
  if (change === undefined) return { kind: "not_requested", reason: "no_attributed_change" };

  const selected = toolLearningParentFromBoard(state, feedback.versionId);
  const parent = selected.ok ? selected.parent : undefined;
  if (parent === undefined) return { kind: "not_requested", reason: "unsupported_parent" };

  if (scope !== undefined && parent.scope !== scope) return { kind: "not_requested", reason: "outside_scope" };

  return { kind: "plan", situation: feedback.situation, feedback, plan: { type: "tool_learning_plan", schemaVersion: 1,
    scope: parent.scope, capability: parent.capability, targetVersionId: parent.versionId,
    createdAt: artifact.occurredAt, trigger: { runId: feedback.taskId, proposalKey: `task-feedback:${feedbackVersionId}`,
      action: change === "usage" ? "light_upgrade" : "heavy_upgrade", tool: parent.identity,
      evidenceRefs: [feedbackVersionId, parent.versionId, ...feedback.useIds, ...feedback.evidenceRefs].slice(0, 32) } } };
}

/** Actual new evidence may enrich an unfrozen pending question for the same
 * exact production contract. Reworded agent hypotheses are handled above. */
function pendingFeedbackJob(state: BoardState, next: ToolLearningPlan, situation: string, sourceVersionId: string): string | undefined {
  for (const job of [...state.jobs].reverse()) {
    if (job.domain !== "tool" || job.scope !== next.scope || (job.state !== "queued" && job.state !== "waiting_evidence")) continue;

    const plan = planForJob(state, job.jobId);
    if (plan === undefined || plan.targetVersionId !== next.targetVersionId || !plan.trigger.proposalKey.startsWith("task-feedback:")) continue;

    const feedbackId = plan.trigger.proposalKey.slice("task-feedback:".length);
    const asset = state.assets.find(item => item.versionId === feedbackId);
    const feedback = asset === undefined ? undefined : decodeToolTaskFeedbackArtifact(asset.content);
    if (feedback?.feedback.situation === situation && feedback.feedback.versionId === sourceVersionId) return job.jobId;
  }
  return undefined;
}

function feedbackJobOutcome(state: BoardState, jobId: string): FeedbackLearningHandoff {
  const job = state.jobs.find(item => item.jobId === jobId);
  return job?.state === "queued" || job?.state === "waiting_evidence" ? { kind: "queued", jobId }
    : { kind: "not_requested", reason: "already_scheduled", jobId };
}

/** Feedback assets are the recoverable outbox; immutable handoffs retain any
 * merge into another pending question. Both live in the existing Board writer. */
export async function resumeToolFeedbackLearning(boardRoot: string, scope: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };

  const assets = loaded.state.assets.filter(asset => asset.kind === "workflow" && typeof asset.content === "object" && asset.content !== null
    && "type" in asset.content && asset.content.type === "tool_task_feedback");
  if (assets.length > 4096) return { ok: false as const, code: "tool_feedback_capacity", message: "feedback recovery requires bounded archive maintenance" };

  const jobIds = new Set<string>();
  const failures: { readonly feedbackVersionId: string; readonly code: string }[] = [];
  let enqueues = 0;

  for (const asset of assets) {
    const selected = planForFeedback(loaded.state, asset.versionId, scope);
    if (selected.kind === "unavailable") {
      failures.push({ feedbackVersionId: asset.versionId, code: selected.code });
      continue;
    }

    if (selected.kind !== "plan") continue;

    const assigned = feedbackHandoffFromBoard(loaded.state, asset.versionId);
    if (!assigned.ok) {
      failures.push({ feedbackVersionId: asset.versionId, code: assigned.code });
      continue;
    }

    if (assigned.jobId !== undefined) {
      const outcome = feedbackJobOutcome(loaded.state, assigned.jobId);
      if (outcome.kind === "queued") jobIds.add(outcome.jobId);
      continue;
    }

    if (enqueues++ >= 16) return { ok: true as const, jobIds: [...jobIds], failures, truncated: true };

    const scheduled = await scheduleToolTaskFeedback(boardRoot, asset.versionId, scope);
    if (scheduled.kind === "queued") jobIds.add(scheduled.jobId);
    else if (scheduled.kind === "unavailable") failures.push({ feedbackVersionId: asset.versionId, code: scheduled.code });
  }

  return { ok: true as const, jobIds: [...jobIds], failures, truncated: false };
}
