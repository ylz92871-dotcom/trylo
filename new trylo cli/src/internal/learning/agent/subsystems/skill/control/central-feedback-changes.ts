import type { BoardState } from "../../../../control/state.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { isSkillLifecycleObservation, skillLifecycleDraft, SKILL_LIFECYCLE_VERSION,
  type SkillLifecycleFact } from "./lifecycle-facts.js";

/** One native pending/approval/load index over the loaded Board. Approval and
 * complete instruction delivery are navigation facts, never adoption or benefit. */
export function projectSkillCentralFeedbackChanges(board: BoardState, input: { readonly scope: string }): readonly ContentDomainFeedbackChange[] {
  const issues = new Map((board.learningIssues ?? []).filter(issue => issue.scope === input.scope && learningIssueOwner(issue) === "skill")
    .map(issue => [issue.issueId, issue]));
  const grants = new Map((board.centralLearningGrants ?? []).map(grant => [grant.grantId, grant]));
  const jobs = new Map(board.jobs.map(job => [job.jobId, job]));
  const approvals = new Map<string, SkillLifecycleFact>(), rows: SkillLifecycleFact[] = [];

  for (const fact of board.rewardV2Facts ?? []) {
    if (fact.scope !== input.scope || fact.algorithmVersion !== SKILL_LIFECYCLE_VERSION) continue;

    let observation: unknown;

    try { observation = JSON.parse(fact.payloadJson); } catch { throw new Error("hermes_lifecycle_payload"); }

    if (!isSkillLifecycleObservation(observation) || fact.kind !== "feedback" || skillLifecycleDraft(input.scope, observation)?.id !== fact.id) {
      throw new Error("hermes_lifecycle_identity");
    }

    const issue = issues.get(observation.issueId), grant = grants.get(observation.grantId), job = jobs.get(observation.jobId);
    if (issue === undefined || grant?.scope !== input.scope || grant.domain !== "skill" || grant.budgetId === undefined
      || grant.issueId !== issue.issueId || grant.jobId !== observation.jobId || grant.focusRevision > issue.revision
      || job?.scope !== input.scope || job.domain !== "skill" || job.coordination?.issueId !== issue.issueId
      || job.coordination.grantId !== grant.grantId || !job.coordination.resultRefs?.includes(observation.pendingRef)) {
      throw new Error("hermes_lifecycle_source_binding");
    }

    const row = { fact, observation };
    rows.push(row);

    if (observation.kind === "native_approved") approvals.set(fact.id, row);
    else {
      const approved = approvals.get(observation.approvalRef);
      if (approved?.observation.kind !== "native_approved" || approved.fact.sequence >= fact.sequence
        || approved.observation.instructionHash !== observation.instructionHash || approved.observation.name !== observation.name
        || approved.observation.issueId !== observation.issueId || approved.observation.grantId !== observation.grantId
        || approved.observation.jobId !== observation.jobId || approved.observation.pendingRef !== observation.pendingRef
        || Date.parse(approved.observation.at) >= Date.parse(observation.at)) throw new Error("hermes_lifecycle_load_binding");
    }
  }

  return rows.map(({ fact, observation }) => ({ domain: "skill", issueId: observation.issueId, factRef: fact.id,
    unitRef: observation.pendingRef, revisionRef: fact.id, kind: observation.kind === "native_approved" ? "approval" : "delivery",
    sourceRefs: [...new Set([fact.id, observation.pendingRef, observation.grantId, observation.jobId,
      ...(observation.kind === "instruction_loaded" ? [observation.approvalRef] : [])])] }));
}
