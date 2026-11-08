import type { MemberCollaborationReportObserver } from "../../../../../protocol/member-collaboration-report.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { createCollaborationControl } from "../control/index.js";

export type CollaborationMemberReporterOptions = {
  readonly control: Pick<ReturnType<typeof createCollaborationControl>, "read" | "report">;
  readonly scope: string; readonly turnId: string;
  readonly enabled: () => boolean; readonly warn: (reason: string) => void;
};

/** Namespace incoming member facts globally; append uses the Board's original single-writer/idempotency contract. */
export function createCollaborationMemberReporter(options: CollaborationMemberReporterOptions): MemberCollaborationReportObserver {
  return async (context, report) => {
    if (!options.enabled()) return;

    const latest = await options.control.read(options.scope);
    if (!latest.ok) {
      options.warn(latest.reason);
      return;
    }

    const existing = latest.issues.find(issue => issue.issueId === report.issueRef || issue.problemKey === report.issueRef);
    // Attempt IDs may span requests. The host stream ordinal isolates local tool IDs without changing execution/mailbox identity.
    // Historical report IDs stay unchanged; the original tool ID remains in its execution journal/mailbox.
    const reportId = `collaboration-member-report:${contentHashOf({ scope: options.scope, executionId: context.executionId,
      taskId: context.taskId, round: context.round, requestId: context.requestId ?? null, requestSequence: context.requestSequence ?? null,
      memberId: context.memberId ?? null, teamRunId: context.teamRunId ?? null, reportId: report.id })}`;
    const result = await options.control.report({ scope: options.scope, problemKey: existing?.problemKey ?? report.issueRef ?? reportId,
      // Appending independent facts never consumes a stale decision revision. PA decisions/focusing retain their own CAS.
      ...(existing === undefined ? {} : { issueId: existing.issueId }), report: {
        reportId, source: { teamRunId: context.teamRunId ?? options.turnId, taskId: context.taskId,
          memberId: context.memberId ?? context.executionId }, facts: report.facts, hypotheses: report.suspectedCauses, evidenceRefs: report.evidenceRefs } });
    if (!result.ok) options.warn(result.reason);
  };
}
