import type { CliContext } from "./context.js";
import { fields, identity, text } from "../../validation/json-shape.js";
import { isCentralLearningAllowance } from "../../learning/control/coordination-parse.js";
import { createJournalSkillOpportunity } from "../../learning/agent/subsystems/skill/host/index.js";
import { skillLifecycleProjection } from "../../learning/agent/subsystems/skill/index.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import { listSessions, sessionsDir } from "./session-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { methodBoardRoot } from "./learning-sink.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { prepareRun, isRunFailure } from "./run-command.js";
import { runOneTurn } from "./run-one-turn.js";
import { isTurnFailure } from "./host.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CentralLearningRunResult } from "../../integration/central-learning/host.js";

/** An explicit UI action becomes a normal PA task with the same source/content/
 * allocation/worker path. The legacy output-token learner is never called. */
export async function handleCentralSkill(ctx: CliContext, input: unknown): Promise<ExitCode> {
  const fail = (reason: string, code: ExitCode) => { ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central",
    status: code === EXIT_CODES.CANCELLED ? "cancelled" : "failed", result: null, pending: [], reason })}\n`);
  return code; };

  if (!(fields(input, ["workspaceRoot", "sessionId", "learnRequest", "allowance"])
    || fields(input, ["workspaceRoot", "sessionId", "turnId", "learnRequest", "allowance"]))
    || !identity(input.workspaceRoot) || !identity(input.sessionId) || !text(input.learnRequest, 65536)
    || input.turnId !== undefined && !identity(input.turnId)
    || !isCentralLearningAllowance(input.allowance)) return fail("central_skill_input_invalid", EXIT_CODES.USAGE);

  const scope = resolveWorkspaceRoot(ctx, input.workspaceRoot);
  if (typeof scope !== "string") return fail("workspace_unavailable", scope.exitCode);

  // This coordination prompt is host-generated. Its referenced original user journal remains the learning source.
  const local = { ...ctx, cwd: scope, userSourceAvailable: false as const }, cancellation = observeRunCancellation(ctx);
  let scaffold: Awaited<ReturnType<typeof prepareRun>> | undefined;
  const results: CentralLearningRunResult[] = [];

  try {
    const source = await createJournalSkillOpportunity({ workspaceRoot: scope, workspaceId: workspaceIdentity(scope),
      sessions: () => listSessions(local, sessionsDir(ctx.homeDir, ctx.env)).filter(row => row.id === input.sessionId),
      ...(typeof input.turnId === "string" ? { source: { sessionId: input.sessionId, turnId: input.turnId } } : {}) })(cancellation.signal);
    if (source?.sessionId === undefined || source.turnId === undefined) return fail("hermes_skill_source_unavailable", EXIT_CODES.EXECUTION_FAILURE);

    const hermes = createHermesSkillRuntime(local);

    try { await hermes.reportTask({ sessionId: source.sessionId, turnId: source.turnId }); }
    finally { hermes.close(); }

    const current = await createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)).load();
    if (!current.ok) return fail(current.reason, EXIT_CODES.CONFIG);

    const issue = current.state.learningIssues?.find(row => row.scope === scope && row.reports.some(report =>
      "subsystem" in report.source && report.source.subsystem === "skill" && report.source.versionId === source.sessionId
      && report.source.taskId === source.turnId));
    if (issue === undefined) return fail("hermes_skill_source_issue_missing", EXIT_CODES.EXECUTION_FAILURE);

    const sink = { stdout: () => {}, stderr: ctx.stderr };

    scaffold = await prepareRun(local, { options: { message: [], readStdin: false, learning: "agent",
      centralLearning: input.allowance }, sink, permissionMode: "non_interactive" });

    if (isRunFailure(scaffold)) return fail(scaffold.message, scaffold.exitCode);

    const text = ["用户明确要求从这一已完成任务学习Hermes技能。只处理此真实来源，不执行其它业务任务。",
      `issueId=${issue.issueId}; sessionId=${source.sessionId}; turnId=${source.turnId}`,
      `用户学习要求（原文数据）=${JSON.stringify(input.learnRequest)}`,
      "先用collaboration_inspect核对来源，再聚焦该issue。完成返回的apply_known和residual_review内容程序，使用central_learning提交真实引用和公开结果。",
      "若内容建议结束或回普通处理，重新inspect并通过collaboration_decide明确记录resolved或ordinary_execution；不得仅返回文字后留下focused工作。",
      "若仍有值得学习的残余，宿主将统一拨款并运行原Hermes review。保留原pending审批，不自动批准；结果已知/无新题时据实停止。"].join("\n");
    const outcome = await runOneTurn(local, { ...scaffold, centralLearningOnlyIssueId: issue.issueId,
      onCentralLearningResult: result => results.push(result) }, text,
      sink, "non_interactive", {}, cancellation.signal);
    // A failed coordination turn can follow a successfully created original
    // pending proposal. Preserve that locator instead of returning an empty
    // result that makes the existing review item disappear from this action.
    const coordinationFailure = isTurnFailure(outcome) ? outcome.message : undefined;
    const result = [...results].reverse().find(row => row.status === "dispatched") ?? results.at(-1) ?? null;
    const after = await createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)).load();
    if (!after.ok) return fail(after.reason, EXIT_CODES.CONFIG);

    const latest = after.state.learningIssues?.find(row => row.issueId === issue.issueId);
    const job = after.state.jobs.find(row => row.jobId === latest?.jobId);
    const approved = new Set((skillLifecycleProjection(after.state, scope, issue.issueId)?.records ?? [])
      .flatMap(row => row.kind === "native_approved" && typeof row.pendingRef === "string" ? [row.pendingRef] : []));
    const locators = (job?.coordination?.resultRefs ?? []).filter(ref => ref.startsWith("hermes-pending:skills:"));
    const pending = locators.filter(ref => !approved.has(ref))
      .map(ref => ({ subsystem: "skills" as const, id: ref.slice("hermes-pending:skills:".length) }));
    const noInvestment = latest?.decision.kind === "resolved" || latest?.decision.kind === "ordinary_execution";
    const status = cancellation.signal.aborted ? "cancelled" : job?.state === "failed" || outcome.exitCode !== EXIT_CODES.OK ? "failed"
      : job?.state === "succeeded" || pending.length > 0 || noInvestment ? "completed" : "waiting";
    const reason = coordinationFailure ?? (status === "failed" && outcome.exitCode !== EXIT_CODES.OK ? "central_coordination_task_failed"
      : noInvestment && pending.length === 0 ? "central_learning_no_new_investment"
        : locators.length > 0 && pending.length === 0 ? "central_skill_already_applied" : undefined);

    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central", status, result, pending,
      ...(reason === undefined ? {} : { reason }) })}\n`);

    return status === "failed" ? EXIT_CODES.EXECUTION_FAILURE : status === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.OK;
  } catch (error) {
    return fail(error instanceof Error ? error.message : "central_skill_unavailable", cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE);
  } finally {
    cancellation.close();
    if (scaffold !== undefined && !isRunFailure(scaffold)) await scaffold.close();
  }
}
