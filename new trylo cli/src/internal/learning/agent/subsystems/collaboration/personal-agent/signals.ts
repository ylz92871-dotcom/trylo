type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): value is string => typeof value === "string";

/** Small normal-request signals keep open work visible when a complete inspection cannot fit. Inspect remains the detail authority. */
export function compactPersonalAgentSignals(inspection: unknown, maxChars = 1400): string {
  if (!row(inspection) || inspection.ok !== true || !row(inspection.state) || !row(inspection.resources)) {
    return JSON.stringify({ status: "unavailable", next: "collaboration_inspect" });
  }

  const issues = array(inspection.state.issues).filter(row);
  const pendingIssues = issues.filter(issue => row(issue.decision) && (issue.decision.kind !== "resolved"
    || typeof issue.revision === "number" && typeof issue.decision.revision === "number" && issue.revision > issue.decision.revision));
  const followUp = row(inspection.resources.followUp) ? inspection.resources.followUp : undefined;
  const planSummary = row(inspection.resources.planSummary) ? inspection.resources.planSummary : undefined;
  const plans = array(inspection.resources.plans).filter(row);
  const uses = followUp === undefined ? [] : array(followUp.items).filter(row);
  const objective = row(inspection.resources.objective) ? inspection.resources.objective : undefined;
  const totals = row(objective?.totals) ? objective.totals : undefined;
  const summary: Row = { status: "available", issueCount: issues.length,
    unresolvedIssueCount: issues.filter(issue => row(issue.decision) && issue.decision.kind !== "resolved").length,
    issuesNeedingAttention: pendingIssues.length,
    pendingUseCount: typeof followUp?.totalPending === "number" ? followUp.totalPending : 0,
    currentTaskPendingUseCount: typeof followUp?.currentTaskPending === "number" ? followUp.currentTaskPending : 0,
    ...(typeof planSummary?.availableProposalCount === "number" ? { availableProposalCount: planSummary.availableProposalCount } : {}),
    ...(totals === undefined ? {} : { objective: { members: totals.members, pendingTools: totals.pendingTools, unreturnedTools: totals.unreturnedTools,
      next: "inspect objective data before assuming a member or unreturned tool failed" } }),
    issues: [], uses: [], proposals: [], next: "collaboration_inspect for exact current evidence, decisions and paged uses" };
  const issueRows: Row[] = [], useRows: Row[] = [], proposalRows: Row[] = [];

  summary.issues = issueRows;
  summary.uses = useRows;
  summary.proposals = proposalRows;
  const add = (target: Row[], value: Row): boolean => {
    target.push(value);
    if (JSON.stringify(summary).length <= maxChars) return true;
    target.pop();
    return false;
  };
  // A real pending use gets the first opportunity; long exact IDs are omitted as a unit, never truncated into invalid references.
  const memberUses = uses.filter(use => row(use.owner) && use.owner.kind !== "personal_agent");
  const displayedUses = [...memberUses, ...uses.filter(use => row(use.owner) && use.owner.kind === "personal_agent")];

  for (const use of displayedUses.slice(0, 2)) {
    const boundary = row(use.boundary) ? use.boundary : {};
    add(useRows, { usageReceiptId: use.usageReceiptId, currentTask: use.currentTask,
      memberId: boundary.memberId, taskId: boundary.taskId, round: boundary.round,
      versionIds: array(use.pendingVersionIds).filter(text) });
  }

  for (const issue of pendingIssues.slice().reverse()) {
    const reports = array(issue.reports).filter(row), latest = reports[reports.length - 1];
    const decision = row(issue.decision) ? issue.decision.kind : "unknown";
    add(issueRows, { issueId: issue.issueId, revision: issue.revision, decision, reportCount: reports.length,
      ...(decision === "resolved" ? { reportsAfterResolution: true } : {}),
      ...(latest === undefined ? {} : { latestReportId: latest.reportId, source: latest.source }) });
    if (issueRows.length >= 3) break;
  }

  for (const plan of plans.slice(-2).reverse()) if (text(plan.versionId) && row(plan.content) && text(plan.content.issueId)) {
    add(proposalRows, { issueId: plan.content.issueId, versionId: plan.versionId });
  }

  return JSON.stringify(summary);
}
