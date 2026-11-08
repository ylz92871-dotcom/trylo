import { contentHashOf } from "../../../../control/hash.js";
import { coordinationScopeValid } from "../../../../control/coordination-parse.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { skillBoardAccess } from "./board.js";
import { createSkillDispatcher } from "./dispatch.js";
import type { SkillCoordinationOptions, SkillFocus, SkillTaskReport } from "./contracts.js";
import { isSkillIssueReference } from "./command-input.js";

const failure = (reason: string) => ({ ok: false as const, reason });

/** The centre records and funds an opportunity; Hermes chooses what to retain. */
export function createSkillCoordination(options: SkillCoordinationOptions) {
  const board = skillBoardAccess(options);
  const dispatcher = createSkillDispatcher(options, board);
  const read = async (issueId: string) => {
    const loaded = await board.load();
    if (!loaded.ok) return loaded;
    const issue = loaded.state.learningIssues?.find(item => item.issueId === issueId && item.scope === options.scope
      && learningIssueOwner(item) === "skill");
    return issue === undefined ? failure("learning_issue_not_found") : { ok: true as const, issue, state: loaded.state };
  };

  return {
    async inspect(issueId?: string) {
      if (!coordinationScopeValid(options.scope) || issueId !== undefined && !isSkillIssueReference(issueId)) return failure("invalid_learning_coordination");

      const loaded = await board.load();
      if (!loaded.ok) return loaded;

      const issues = (loaded.state.learningIssues ?? []).filter(issue => issue.scope === options.scope
        && learningIssueOwner(issue) === "skill"
        && (issueId === undefined || issue.issueId === issueId));
      if (issueId !== undefined && issues.length === 0) return failure("learning_issue_not_found");

      const jobs = loaded.state.jobs.filter(job => job.scope === options.scope && job.domain === "skill"
        && issues.some(issue => issue.jobId === job.jobId && job.coordination?.issueId === issue.issueId));
      const grants = (loaded.state.centralLearningGrants ?? []).filter(grant => grant.scope === options.scope && grant.domain === "skill"
        && issues.some(issue => issue.grantId === grant.grantId && issue.issueId === grant.issueId)
        && jobs.some(job => job.jobId === grant.jobId && job.coordination?.grantId === grant.grantId));

      return { ok: true as const, scope: options.scope, issues, jobs, grants };
    },
    async report(input: SkillTaskReport) {
      if (!coordinationScopeValid(options.scope) || !input.sourceRef.trim()) return failure("invalid_learning_coordination");

      const identity = contentHashOf([options.scope, input.sourceRef]);
      const issueId = `skill-issue:${identity}`, problemKey = `skill-opportunity:${identity}`;
      const reported = await board.send({ kind: "report", scope: options.scope, issueId, problemKey,
        report: { reportId: `skill-report:${identity}`, source: { subsystem: "skill", taskId: input.taskId, versionId: input.versionId ?? input.sourceRef },
          facts: input.facts, evidenceRefs: [...new Set([input.sourceRef, ...input.evidenceRefs])] } });
      if (!reported.ok) return reported;

      const issue = reported.state.learningIssues?.find(item => item.issueId === issueId);

      return issue === undefined ? failure("learning_issue_not_found") : { ok: true as const, issue };
    },
    async focus(input: SkillFocus, allocation?: { readonly grantId: string }) {
      const current = await read(input.issueId);
      if (!current.ok) return current;

      if (allocation !== undefined) {
        if (!isSkillIssueReference(allocation.grantId)) return failure("invalid_learning_coordination");

        const existing = current.state.centralLearningGrants?.find(item => item.grantId === allocation.grantId);
        if (existing !== undefined) return existing.domain === "skill" && existing.scope === options.scope
          && existing.issueId === current.issue.issueId && current.issue.grantId === existing.grantId
          && current.issue.decision.kind === "focused_learning"
          && contentHashOf(existing.allowance) === contentHashOf(input.allowance)
          ? { ok: true as const, issue: current.issue, grant: existing } : failure("learning_grant_conflict");
      }

      const decided = await board.send({ kind: "decide", issueId: input.issueId, expectedRevision: input.expectedRevision,
        decision: "focused_learning", reason: input.reason, sourceRefs: input.sourceRefs });
      if (!decided.ok) return decided;

      const issue = decided.state.learningIssues?.find(item => item.issueId === input.issueId);
      if (issue?.decision.kind !== "focused_learning") return failure("learning_issue_not_focused");

      const grantId = allocation?.grantId ?? `skill-grant:${contentHashOf([options.scope, issue.issueId, issue.decision.revision])}`;
      const existing = decided.state.centralLearningGrants?.find(item => item.grantId === grantId);
      if (existing !== undefined) return contentHashOf(existing.allowance) === contentHashOf(input.allowance)
        ? { ok: true as const, issue, grant: existing } : failure("learning_grant_conflict");

      const funded = await board.send({ kind: "fund", domain: "skill", issueId: issue.issueId, expectedRevision: issue.revision,
        grantId, allowance: input.allowance });
      if (!funded.ok) return funded;

      const grant = funded.state.centralLearningGrants?.find(item => item.grantId === grantId);
      const after = funded.state.learningIssues?.find(item => item.issueId === issue.issueId);

      return grant === undefined || after === undefined ? failure("learning_grant_not_found") : { ok: true as const, issue: after, grant };
    },
    run: dispatcher.run,
    recoverExpired: dispatcher.recoverExpired,
    dispatchFunded: dispatcher.dispatchFunded,
  };
}
