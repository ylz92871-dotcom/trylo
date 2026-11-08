import type { BoardState } from "../../../../control/state.js";
import { toolFeedbackIsExternal, type ToolTaskFeedback } from "../domain/evolution/task-feedback.js";
import { TOOL_JOB_PREFIX, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFeedbackScope } from "./feedback-input-facts.js";
import { feedbackHandoffFromBoard } from "./feedback-handoff.js";
import { planForJob } from "./pipeline-queue.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";

export function toolFeedbackChangeKind(feedback: ToolTaskFeedback): "usage" | "implementation" | undefined {
  return feedback.recommendation === "change_usage" && feedback.attribution === "usage" ? "usage"
    : (feedback.recommendation === "improve" || feedback.recommendation === "replace") && feedback.attribution === "implementation" ? "implementation" : undefined;
}

/** Same immutable host uses are one investigation budget, not a new one for
 * each agent phrasing/turn/situation. Existing plans prove assignment even when
 * a process crashed before its separate handoff commit. No lifecycle is reset. */
export function selectToolFeedbackInquiry(state: BoardState, input: { readonly plan: ToolLearningPlan;
  readonly feedbackVersionId: string; readonly feedback: ToolTaskFeedback }): PipelineFailure | {
    readonly ok: true; readonly existingJobId?: string; readonly anchorFeedbackVersionId?: string } {
  if (toolFeedbackIsExternal(input.feedback)) return { ok: true as const };

  const parentVersionId = input.plan.targetVersionId;
  if (parentVersionId === undefined) return pipelineFailure("invalid_tool_feedback_inquiry", "An investigation must bind an exact learning parent");

  const history = toolLearningFeedbackScope(state, input.plan, parentVersionId);
  if (!history.ok) return history;

  if (history.historyScope !== "bound") return pipelineFailure("tool_feedback_workspace_unavailable", "A hypothesis needs an actual source-workspace use binding before investigation");

  if (history.entries.length > 4096) return pipelineFailure("tool_feedback_capacity", "Feedback inquiry recovery requires bounded archive maintenance");

  const order = new Map(state.assets.map((asset, index) => [asset.versionId, index]));
  const entries = [...history.entries].sort((left, right) => order.get(left.feedbackVersionId)! - order.get(right.feedbackVersionId)!);
  const byVersion = new Map(entries.map(entry => [entry.feedbackVersionId, entry]));
  const inquiries = new Map<string, Set<string>>();

  for (const job of state.jobs) {
    if (job.domain !== "tool" || job.scope !== input.plan.scope || !job.jobId.startsWith(TOOL_JOB_PREFIX)) continue;

    const plan = planForJob(state, job.jobId);
    if (plan?.targetVersionId !== parentVersionId || !plan.trigger.proposalKey.startsWith("task-feedback:")) continue;

    const origin = byVersion.get(plan.trigger.proposalKey.slice("task-feedback:".length));
    if (origin === undefined) continue; // Another actual source workspace is not this inquiry.

    if (toolFeedbackChangeKind(origin.feedback) === undefined) {
      return pipelineFailure("invalid_tool_feedback_inquiry", "The canonical queued inquiry does not identify its original bound host-use feedback");
    }

    inquiries.set(job.jobId, new Set(origin.feedback.useIds));
  }

  for (const entry of entries) {
    const handoff = feedbackHandoffFromBoard(state, entry.feedbackVersionId);
    if (!handoff.ok) return handoff;
    const assigned = handoff.jobId === undefined ? undefined : inquiries.get(handoff.jobId);
    if (assigned !== undefined) for (const useId of entry.feedback.useIds) assigned.add(useId);
  }

  const assigned = new Set([...inquiries.values()].flatMap(uses => [...uses]));
  if (input.feedback.useIds.every(useId => assigned.has(useId))) {
    const existing = [...inquiries].find(([, uses]) => input.feedback.useIds.some(useId => uses.has(useId)));
    if (existing !== undefined) return { ok: true as const, existingJobId: existing[0] };
  }

  // Before the first enqueue, all schedulers still see the same earliest
  // committed feedback anchor. Its unchanged plan hash lets the original Board
  // enqueue owner arbitrate the race without a second store or nested writer.
  const anchor = entries.find(entry => !toolFeedbackIsExternal(entry.feedback) && toolFeedbackChangeKind(entry.feedback) !== undefined
    && input.feedback.useIds.every(useId => entry.feedback.useIds.includes(useId)));

  return anchor === undefined || anchor.feedbackVersionId === input.feedbackVersionId ? { ok: true as const }
    : { ok: true as const, anchorFeedbackVersionId: anchor.feedbackVersionId };
}
