import { resolve } from "node:path";
import { createCollaborationControl, createFileCollaborationBoard, centralLearningRemaining, centralLearningSpent } from "../../learning/agent/subsystems/collaboration/index.js";
import { isCollaborationPlan, collaborationPlanSourcesValid } from "../../learning/agent/subsystems/collaboration/orchestration/index.js";
import { isCollaborationExperienceContent, collaborationExperienceSourcesValid } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { isTeamLearningIssueReport } from "../../learning/control/coordination-contract.js";
import type { BoardState } from "../../learning/control/state.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { isCollaborationIssueControlV1, type CollaborationIssuesSnapshotV1 } from "../../protocol/collaboration-control.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CollaborationIssueOptions } from "./args-collaboration-issues.js";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

/** Canonical read projection. A proposed plan or dispatched guidance is never reported as adopted. */
export function collaborationIssuesSnapshot(state: BoardState, scope: string): CollaborationIssuesSnapshotV1 {
  return { schemaVersion: 1, scope, issues: (state.learningIssues ?? []).filter(i => i.scope === scope
    && i.reports.some(isTeamLearningIssueReport)).map(issue => {
    const job = state.jobs.find(j => j.jobId === issue.jobId), grant = state.centralLearningGrants?.find(g => g.grantId === issue.grantId);
    const adjustments = state.assets.flatMap(asset => {
      if (asset.scope !== scope || !isCollaborationPlan(asset.content) || asset.content.issueId !== issue.issueId
        || !collaborationPlanSourcesValid(state, scope, asset.content) || state.tombstones.some(t => t.entityId === asset.versionId || t.entityId === asset.createdFromProposalId)) return [];
      const plan = asset.content;
      return [{ adjustmentRef: asset.versionId, title: plan.title, details: [plan.summary,
        ...plan.adjustments.map(a => `${a.memberId} (${a.kind}): ${a.instruction}`)].join("\n"),
      affectedMembers: [...new Set(plan.adjustments.map(a => a.memberId))], state: "proposed", experienceVersionIds: plan.experienceVersionIds }];
    });
    const experienceIds = new Set(adjustments.flatMap(a => a.experienceVersionIds));

    for (const asset of state.assets) {
      if (asset.scope === scope && isCollaborationExperienceContent(asset.content) && asset.content.issueId === issue.issueId
        && collaborationExperienceSourcesValid(state, scope, asset.content)) experienceIds.add(asset.versionId);
    }

    const feedback = (state.collaborationRuntimeReceipts ?? []).flatMap(receipt => receipt.scope === scope && receipt.phase === "use_feedback"
      && receipt.versionIds.some(id => experienceIds.has(id))
      ? [{ ref: receipt.receiptId, summary: receipt.summary, sourceRefs: receipt.sourceRefs }] : []);

    return { issueId: issue.issueId, revision: issue.revision, title: issue.reports[0]?.facts[0] ?? issue.problemKey,
      decision: issue.decision.kind, ...(issue.decision.kind === "unreviewed" ? {} : { reason: issue.decision.reason }), updatedAt: issue.updatedAt,
      reports: issue.reports.filter(isTeamLearningIssueReport).map(r => ({ reportId: r.reportId, memberId: r.source.memberId, facts: r.facts,
        suspectedCauses: r.hypotheses ?? [], evidenceRefs: r.evidenceRefs })),
      ...(job === undefined || grant === undefined ? {} : { learning: { jobId: job.jobId, state: job.state, grantId: grant.grantId,
        unit: grant.allowance.unit, allowance: grant.allowance.maxTokens, spent: centralLearningSpent(grant).tokens, remaining: centralLearningRemaining(grant).tokens } }),
      dependencies: (state.learningDependencies ?? []).filter(d => d.issueId === issue.issueId).map(d => ({ dependencyId: d.dependencyId,
        owner: d.owner, ...(d.requestId === undefined ? {} : { requestId: d.requestId }), state: d.state.kind,
        ...("reason" in d.state ? { reason: d.state.reason } : {}) })), adjustments, feedback,
    };
  }) };
}

/** Stdin resolve is an explicit user action. It cannot submit a PA focus decision, funding or approval receipt. */
export async function handleCollaborationIssues(ctx: CliContext, options: CollaborationIssueOptions,
  injectedBoard?: Pick<BoardStore, "load" | "apply">): Promise<ExitCode> {
  const write = (value: object, exit: ExitCode): ExitCode => {
    ctx.stdout(`${JSON.stringify(value)}\n`);
    return exit;
  };
  const error = (reason: string, exit: ExitCode = EXIT_CODES.EXECUTION_FAILURE) => write({ schemaVersion: 1, ok: false, reason }, exit);
  const scope = resolve(ctx.cwd, options.workspace ?? ctx.cwd);
  if (!ctx.isDirectory(scope)) return error("workspace_unavailable");

  let request: unknown;

  if (options.control === "coordinate") {
    try {
      const raw = await ctx.readStdin();
      if (raw.length > 16384) return error("invalid_collaboration_control", EXIT_CODES.USAGE);
      request = JSON.parse(raw);
    }
    catch { return error("invalid_collaboration_control", EXIT_CODES.USAGE); }
    if (!isCollaborationIssueControlV1(request)) return error("invalid_collaboration_control", EXIT_CODES.USAGE);
  }

  const board = injectedBoard ?? createFileCollaborationBoard(`${tryloHome(ctx.homeDir, ctx.env)}/learning/board`);
  const loaded = await board.load();
  if (!loaded.ok) return error(loaded.reason);

  if (options.control === "issues") return write(collaborationIssuesSnapshot(loaded.state, scope), EXIT_CODES.OK);

  if (!isCollaborationIssueControlV1(request)) return error("invalid_collaboration_control", EXIT_CODES.USAGE);

  const issue = loaded.state.learningIssues?.find(i => i.issueId === request.issueId && i.scope === scope);
  if (issue === undefined) return error("learning_issue_not_found");

  if (issue.revision !== request.expectedRevision) return error("learning_issue_conflict");

  const control = createCollaborationControl({ board, now: () => new Date(ctx.now()).toISOString(), ownerId: "collaboration-management" });
  const resolutionRef = `user:collaboration-resolve:${contentHashOf(request)}`;
  const result = await control.decide({ issueId: issue.issueId, expectedRevision: request.expectedRevision, decision: "resolved",
    reason: request.reason, sourceRefs: [resolutionRef] });
  if (result.ok) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: result.issue.scope,
    reason: "collaboration_issue_resolution_committed", sourceRefs: [result.issue.issueId, resolutionRef] });

  return result.ok ? write({ schemaVersion: 1, ok: true, revision: result.issue.revision }, EXIT_CODES.OK) : error(result.reason);
}
