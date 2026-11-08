import { canonicalCardJson } from "./contracts.js";
import type { MethodExperienceFact } from "./experience-facts.js";
import type { MethodObservation } from "./inference-observations.js";
import { adoptionWindowClosed } from "./adoption-window.js";

type FeedbackIdentity = Pick<MethodObservation, "versionId" | "taskId" | "opportunityId" | "scopeId" | "compilationId" | "features">;

/** Actual adoption is a historical fact, not another editable self-report.
 * A later block stops future execution but cannot hide an already-used method.
 * Writer and replay use the same binding and original feedback cutoff. */
export function feedbackAdoptionOf(facts: readonly MethodExperienceFact[], identity: FeedbackIdentity,
  beforeSequence: number): MethodObservation["adoption"] {
  const decisions = facts.filter(fact => fact.kind === "decision" && fact.sequence < beforeSequence &&
    fact.versionId === identity.versionId && fact.context.taskId === identity.taskId &&
    fact.context.opportunityId === identity.opportunityId && fact.decision.scopeId === identity.scopeId &&
    fact.decision.compilationId === identity.compilationId &&
    canonicalCardJson(fact.context.features) === canonicalCardJson(identity.features));
  const closed = adoptionWindowClosed(facts, identity, beforeSequence);

  return !closed && decisions.some(fact => fact.kind === "decision" && fact.decision.action === "adopt") ? "adopted" :
    decisions.length > 0 ? "deviated" : "displayed";
}
