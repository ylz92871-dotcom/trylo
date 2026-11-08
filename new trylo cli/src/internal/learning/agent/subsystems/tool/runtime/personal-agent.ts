import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { TOOL_LEARNING_ALLOWANCE } from "../../../../control/tool-allowance.js";
import { contentHashOf } from "../../../../control/hash.js";
import { selectToolFocusedSource } from "./central-source.js";

export type ToolPersonalAgentFocus = { readonly issueId: string; readonly expectedRevision: number;
  readonly reason: string; readonly sourceRefs: readonly string[] };

type Options = { readonly boardRoot: string; readonly scope: string; readonly centralScope: string; readonly now: () => number;
  readonly authorized: () => boolean;
  readonly run: (jobId: string, signal: AbortSignal) => Promise<{ readonly ok: boolean }> };

const failure = (reason: string) => ({ ok: false as const, reason });

/** PA delegates an existing canonical tool issue. This adapter never borrows
 * collaboration funds, invents a queue plan, or grants tool execution rights. */
export function createToolPersonalAgentLearning(options: Options) {
  const preflight = (signal: AbortSignal) => signal.aborted ? failure("learning_aborted")
    : !options.authorized() ? failure("tool_learning_authorization_required") : undefined;
  const dispatch = async (issueId: string, signal: AbortSignal) => {
    const blocked = preflight(signal);
    if (blocked !== undefined) return blocked;

    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return failure(loaded.reason);

    const issue = loaded.state.learningIssues?.find(row => row.issueId === issueId);
    const selected = select(loaded.state, issue, options.scope, options.centralScope);
    if (!selected.ok) return selected;

    const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === selected.grantId);
    if (issue?.decision.kind !== "focused_learning" || grant?.domain !== "tool" || grant.scope !== options.centralScope || grant.status !== "open"
      || grant.issueId !== issueId || grant.focusRevision !== issue.decision.revision) return failure("learning_grant_not_found");

    const job = loaded.state.jobs.find(row => row.jobId === selected.jobId);
    if (job?.state === "running") return { ok: true as const, status: "busy" as const, issueId, jobId: selected.jobId, grantId: selected.grantId };

    const worked = await options.run(selected.jobId, signal);
    if (!worked.ok) return { ...failure("tool_learning_dispatch_failed"), workAttempted: true as const };

    const after = await createBoardReader(options.boardRoot).load();
    if (!after.ok) return { ...failure(after.reason), workAttempted: true as const };

    const current = after.state.jobs.find(row => row.jobId === selected.jobId);
    const currentGrant = after.state.centralLearningGrants?.find(row => row.grantId === selected.grantId);
    const status = signal.aborted ? "cancelled" as const : current?.state === "running" ? "busy" as const
      : current?.state === "waiting_approval" || current?.state === "waiting_evidence" ? "waiting_dependency" as const
        : current?.state === "succeeded" ? "completed" as const : current?.state === "failed" || current?.state === "expired" ? "failed" as const
          : current?.state === "cancelled" ? "cancelled" as const : "idle" as const;

    return { ok: true as const, status, workAttempted: true as const, issueId, jobId: selected.jobId, grantId: selected.grantId,
      ...(currentGrant === undefined ? {} : { remaining: centralLearningRemaining(currentGrant) }) };
  };

  return {
    async focus(input: ToolPersonalAgentFocus, signal: AbortSignal) {
      const blocked = preflight(signal);
      if (blocked !== undefined) return blocked;

      const ready = await withBoardWriter(options.boardRoot, async store => {
        const loaded = await store.load();
        if (!loaded.ok) return failure(loaded.reason);

        const issue = loaded.state.learningIssues?.find(row => row.issueId === input.issueId);
        const selected = select(loaded.state, issue, options.scope, options.centralScope);
        if (!selected.ok) return selected;

        if (issue?.revision !== input.expectedRevision) return failure("learning_issue_conflict");

        if (signal.aborted) return failure("learning_aborted");

        const existing = loaded.state.centralLearningGrants?.find(row => row.grantId === selected.grantId);
        if (existing !== undefined && (existing.domain !== "tool" || existing.scope !== options.centralScope || existing.status !== "open"
          || existing.issueId !== input.issueId || issue.decision.kind !== "focused_learning" || existing.focusRevision !== issue.decision.revision)) {
          return failure("learning_grant_closed");
        }

        const apply = async (action: CoordinationAction) => store.apply({ type: "coordinate_learning",
          commandId: `tool-pa:${contentHashOf(action)}`, issuedAt: new Date(options.now()).toISOString(), action });
        let state = loaded.state;

        if (issue.decision.kind !== "focused_learning") {
          const decided = await apply({ kind: "decide", ...input, decision: "focused_learning" });
          if (!decided.ok) return failure(decided.reason);
          state = decided.state;
        }

        const focused = state.learningIssues?.find(row => row.issueId === input.issueId);
        const grant = state.centralLearningGrants?.find(row => row.grantId === selected.grantId);
        if (grant !== undefined) return grant.domain === "tool" && grant.status === "open"
          && grant.issueId === input.issueId && focused?.decision.kind === "focused_learning"
          && grant.focusRevision === focused.decision.revision ? { ok: true as const } : failure("learning_grant_closed");

        if (focused === undefined) return failure("learning_issue_not_found");

        const funded = await apply({ kind: "fund", domain: "tool", issueId: input.issueId, expectedRevision: focused.revision,
          grantId: selected.grantId, allowance: TOOL_LEARNING_ALLOWANCE });

        return funded.ok ? { ok: true as const } : failure(funded.reason);
      });
      if (!ready.ok) return failure("reason" in ready ? ready.reason : "tool_learning_focus_failed");

      return dispatch(input.issueId, signal);
    },
    async resume(signal: AbortSignal) {
      if (signal.aborted) return failure("learning_aborted");

      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) return failure(loaded.reason);

      for (const issue of loaded.state.learningIssues ?? []) {
        if (issue.scope !== options.centralScope || issue.decision.kind !== "focused_learning"
          || !issue.reports.some(row => "subsystem" in row.source && row.source.subsystem === "tool")) continue;

        const selected = select(loaded.state, issue, options.scope, options.centralScope);
        if (!selected.ok) return selected;

        const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === selected.grantId);
        const job = loaded.state.jobs.find(row => row.jobId === selected.jobId);
        if (grant?.status === "open" && job !== undefined && ["queued", "running", "waiting_evidence"].includes(job.state)) return dispatch(issue.issueId, signal);
      }

      return { ok: true as const, status: "idle" as const };
    },
  };
}

function select(...args: Parameters<typeof selectToolFocusedSource>) {
  const source = selectToolFocusedSource(...args);
  return source.ok ? source : failure(source.code);
}

