import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { FocusedLearningPort as PersonalAgentFocusedLearning } from "../../../../control/focused-learning-port.js";
import type { FileWorkflowImprovementOptions } from "./improvement-composition.js";
import { fileWorkflowImprovementPorts } from "./improvement-composition.js";
import { createWorkflowImprovementFunding } from "./improvement-funding.js";
import { workWorkflowImprovement } from "../runtime/improvement-worker.js";
import { workflowImprovementGrantSuffix } from "../runtime/improvement-identities.js";

/** PA selects a canonical opportunity; its original explicit grant remains the spending authority. */
export function createWorkflowFocusedLearning(options: FileWorkflowImprovementOptions): PersonalAgentFocusedLearning {
  const scope = options.centralScope ?? options.scope;
  const run = async (signal: AbortSignal, input?: Parameters<PersonalAgentFocusedLearning["focus"]>[0]) => {
    if (signal.aborted) return failure("learning_aborted");

    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return failure(loaded.reason);

    const candidates = (loaded.state.learningIssues ?? []).filter(issue => issue.scope === scope && issue.reports.every(report =>
      "subsystem" in report.source && report.source.subsystem === "workflow")
      && (input === undefined ? issue.decision.kind === "focused_learning" : issue.issueId === input.issueId));
    const issue = input === undefined ? candidates.find(item => loaded.state.jobs.some(job => job.jobId === item.jobId && job.state === "queued"))
      : candidates[0];
    if (issue === undefined) return input === undefined ? idle() : failure("workflow_focus_source_unavailable");

    if (input !== undefined && issue.revision !== input.expectedRevision) return failure("learning_issue_conflict");

    const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === issue.grantId && item.scope === scope
      && item.domain === "workflow" && item.status === "open");
    if (grant === undefined) return failure("workflow_explicit_grant_required");

    const job = loaded.state.jobs.find(item => item.jobId === grant.jobId);
    if (job?.state === "running") return { ok: true as const, status: "busy" as const, jobId: job.jobId, issueId: issue.issueId };

    if (job?.state !== "queued" || job.attempt !== 0 || grant.reservations.length > 0) return failure("workflow_explicit_grant_required");

    const ports = fileWorkflowImprovementPorts(options), view = await ports.store.read();
    if (!view.ok) return failure(view.code);

    const sources = new Set(issue.reports.flatMap(report => "versionId" in report.source ? [report.source.versionId] : []));
    const source = [...view.value.opportunities].reverse().find(item => sources.has(item.versionId)
      && grant.grantId.endsWith(workflowImprovementGrantSuffix(item.versionId)));
    if (source === undefined) return failure("workflow_focus_source_unavailable");

    if (input !== undefined) {
      const decided = await withBoardWriter(options.boardRoot, board => board.apply({ type: "coordinate_learning",
        commandId: `workflow-pa-focus:${contentHashOf(input)}`, issuedAt: new Date(options.now()).toISOString(),
        action: { kind: "decide", ...input, decision: "focused_learning" } }));
      if (!decided.ok) return failure(decided.reason);
    }

    const funding = createWorkflowImprovementFunding({ ...options, binding: { grantId: grant.grantId, inputVersionId: source.versionId } });
    const funded = { grantId: grant.grantId, jobId: job.jobId, inputVersionId: source.versionId, state: "queued" as const, resultRefs: [] };
    const result = await workWorkflowImprovement({ ...options, ...ports, funding }, funded, source.record, signal);
    if (!result.ok) return failure(result.code);

    if (!("versionId" in result.value)) return { ok: true as const, workAttempted: true as const,
      status: result.value.status === "waiting_evidence" ? "waiting_dependency" as const : "idle" as const,
      issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId };

    return { ok: true as const, status: "completed" as const, issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId,
      result: { kind: "completed" as const, resultRefs: [result.value.versionId] } };
  };

  return { focus: (input, signal) => run(signal, input), resume: signal => run(signal) };
}

const failure = (reason: string) => ({ ok: false as const, reason });
const idle = () => ({ ok: true as const, status: "idle" as const });
