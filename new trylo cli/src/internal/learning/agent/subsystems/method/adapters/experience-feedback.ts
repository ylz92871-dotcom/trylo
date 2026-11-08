import type { BoardState } from "../../../../control/state.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { isContext } from "../domain/experience-facts.js";
import type { MethodObservation } from "../domain/inference.js";
import type { FeedbackInput } from "../port.js";
import { isRepresentativeOpportunity } from "../domain/opportunity-representative.js";
import { isMethodApplicationReport, sameApplicationReport } from "../domain/application-report.js";
import { feedbackAdoptionOf } from "../domain/feedback-adoption.js";

/** Enrich the existing feedback at the locked write boundary; never a second score ledger. */
export function observationForFeedback(state: BoardState, input: FeedbackInput): MethodObservation | undefined {
  if (input.application !== undefined && !isMethodApplicationReport(input.application)) throw new Error("invalid_method_application");

  const replay = state.feedbacks.find(item => item.exposureId === input.exposureId && item.helped === input.helped &&
    item.observation !== undefined);
  if (replay?.observation !== undefined) {
    if (!sameApplicationReport(replay.observation.application, input.application)) throw new Error("method_feedback_application_conflict");
    return replay.observation;
  }

  const fielding = state.fieldings.find(item => item.exposureId === input.exposureId && item.versionId === input.versionId);
  if (fielding?.useSequence === undefined) return undefined;

  // The request's real-send receipt owns attribution. input.context exists only
  // for old callers whose unbound exposures predate provenance recording.
  const context = fielding.binding?.context ?? input.context;
  if (!isContext(context) || context.taskId !== input.turnId) return undefined;

  // One parent turn is a known dependent origin. Its first real exposure fixes
  // prospective eligibility, even if context or feedback arrives on a later beat.
  const origin = state.fieldings.filter(item => item.versionId === input.versionId && item.turnId === context.taskId);
  if (origin.some(item => item.useSequence === undefined)) return undefined;

  const originalSequence = Math.min(...origin.map(item => item.useSequence!));
  const prior = state.feedbacks.some(item => item.observation?.versionId === input.versionId &&
    item.observation.taskId === context.taskId && item.observation.opportunityId === context.opportunityId);

  // A later request in the same opportunity is another report, not a new trial
  // or an implicit correction. Explicit revisions use input.observation.
  if (prior) return undefined;

  const opportunity = { versionId: input.versionId, taskId: context.taskId, opportunityId: context.opportunityId,
    scopeId: fielding.scope, features: context.features,
    ...(fielding.binding?.compilationId === undefined ? {} : { compilationId: fielding.binding.compilationId }) };
  const adoption = feedbackAdoptionOf(state.methodExperienceFacts ?? [], opportunity, state.sequence + 1);
  const adopted = adoption === "adopted";

  return { observationId: shortId("method-observation", [input.versionId, context.taskId, context.opportunityId]),
    taskId: context.taskId, opportunityId: context.opportunityId, versionId: input.versionId, scopeId: fielding.scope,
    sequence: originalSequence, opportunitySequence: fielding.useSequence, correlationId: context.taskId, revision: 0,
    ...(adopted ? { clusterRepresentative: isRepresentativeOpportunity(state.methodExperienceFacts ?? [], opportunity, state.sequence + 1) } : {}),
    adoption,
    outcome: input.helped ? "helped" : "unhelpful", source: "self_report", features: context.features,
    ...(input.application === undefined ? {} : { application: input.application }),
    ...(fielding.binding?.compilationId === undefined ? {} : { compilationId: fielding.binding.compilationId }) };
}
