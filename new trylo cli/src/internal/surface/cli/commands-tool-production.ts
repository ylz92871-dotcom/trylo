import path from "node:path";
import type { CliContext } from "./context.js";
import type { ToolProductionCommand } from "./args-tool-production.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { workspaceIdentity } from "./wiring.js";
import { readToolEvolutionCandidate } from "../../integration/tool-learning/evolution-reader.js";
import { createToolProductionPlan, toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import { parseToolEvolutionRequest } from "../../learning/domains/tool/evolution/parse.js";
import { productionFromBoard, readToolProductionPlan, saveToolProductionPlan } from "../../integration/tool-learning/production-assets.js";
import { admitToolProductionVerification } from "../../integration/tool-learning/production-evidence.js";
import { claimToolProductionCheck, finishToolProductionCheck, expireToolProductionCheck } from "../../integration/tool-learning/production-jobs.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { monitorToolJob } from "../../integration/tool-learning/pipeline-monitor.js";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { permissionLedgerPath } from "./session-paths.js";
import type { ToolProductionPort } from "../../ports/tool-production.js";
import { activateToolProduction, reviewToolProductionActivation, reviewToolProductionFromBoard, stopToolProduction } from "./tool-production-activation.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { authorizeToolCheck } from "./tool-check-permission.js";
import { projectToolProductionDetail, readToolProductionList } from "../../integration/tool-learning/production-view.js";

export async function handleToolProduction(ctx: CliContext, command: ToolProductionCommand, boardRoot: string): Promise<ExitCode> {
  const workspaceId = workspaceIdentity(path.resolve(ctx.cwd));
  const print = <T extends { readonly ok: boolean }>(result: T): ExitCode => { ctx.stdout(`${JSON.stringify(result)}\n`); return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG; };
  if (command.kind === "production-list") return print(await readToolProductionList(boardRoot, workspaceId));
  if (command.kind === "production-plan") {
    const origin = await readToolEvolutionCandidate(boardRoot, command.originVersionId);
    if (!origin.ok) return print(origin);
    const raw = ctx.readFile(path.resolve(ctx.cwd, command.checksFile));
    let value: unknown;
    try { value = raw === undefined || Buffer.byteLength(raw) > 262_144 ? undefined : JSON.parse(raw); }
    catch { value = undefined; }
    const checks = parseToolEvolutionRequest(value);
    if (!checks.ok) return print(checks);
    const planned = createToolProductionPlan({ workspaceId, originVersionId: origin.versionId, artifact: origin.artifact, checks: checks.value, license: command.license });
    return !planned.ok ? print(planned) : print(await saveToolProductionPlan(boardRoot, planned.plan, new Date(ctx.now()).toISOString()));
  }
  const service = ctx.toolProduction;
  if (service === undefined) return print({ ok: false, code: "production_checker_unavailable", message: "process root did not provide its trusted checker" });
  const selection = { boardRoot, versionId: command.versionId, workspaceId, authority: service.authority };
  if (command.kind === "production-show") {
    const loaded = await createBoardReader(boardRoot).load();
    if (!loaded.ok) return print(loaded);
    const plan = productionFromBoard(loaded.state, command.versionId, workspaceId);
    if (!plan.ok) return print(plan);
    const review = await reviewToolProductionFromBoard(loaded.state, selection);
    return print({ ...plan, activationReview: review, checkJobs: loaded.state.jobs.filter(job => job.observationId === plan.proposalId),
      desktopView: projectToolProductionDetail(loaded.state, plan, review) });
  }
  if (command.kind === "production-expire") return print(await expireToolProductionCheck({ ...selection, jobId: command.jobId, issuedAt: new Date(ctx.now()).toISOString() }));
  if (command.kind === "production-verify") return verify(ctx, command, selection, service);
  if (command.kind !== "production-activate") return print(await stopToolProduction({ ...selection,
    action: command.kind === "production-suspend" ? "suspend" : command.kind === "production-withdraw" ? "withdraw" : "rollback",
    commandId: ctx.newId("production-stop"), issuedAt: new Date(ctx.now()).toISOString() }));
  const review = await reviewToolProductionActivation(selection);
  if (!review.ok) return print(review);
  if (review.reviewId !== command.reviewId) return print({ ok: false, code: "production_review_stale", message: "run production-show and approve its exact reviewId" });
  const permission = createFilePermissionStore({ path: permissionLedgerPath(ctx.homeDir, ctx.env) }), now = ctx.now();
  const issued = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: command.versionId, scope: toolProductionScope(review.plan),
    issuedAt: new Date(now).toISOString(), expiry: new Date(now + 60_000).toISOString() });
  if (!issued.ok) return print(issued);
  return print(await activateToolProduction({ ...selection, reviewId: command.reviewId, permission, token: { grantId: issued.grant.grantId }, issuedAt: new Date(ctx.now()).toISOString() }));
}

type ProductionSelection = Parameters<typeof reviewToolProductionActivation>[0];

/** Native checking and receipt issuance stay in the trusted composition root, outside learning. */
async function verify(ctx: CliContext, command: Extract<ToolProductionCommand, { kind: "production-verify" }>, selection: ProductionSelection, service: ToolProductionPort): Promise<ExitCode> {
  const cancellation = observeRunCancellation(ctx);
  const print = (result: unknown) => ctx.stdout(`${JSON.stringify(result)}\n`);
  try {
    const selected = await readToolProductionPlan(selection.boardRoot, selection.versionId, selection.workspaceId);
    if (!selected.ok) { print(selected); return EXIT_CODES.CONFIG; }
    if (cancellation.signal.aborted) return EXIT_CODES.CANCELLED;
    ctx.stderr(`Production check ${selected.versionId}\nSource: ${JSON.stringify(selected.plan.type === "npm_tool_production_package" ? selected.plan.origin : selected.plan.candidate.source)}\n`);
    const args = { productionVersionId: selected.versionId, workspaceId: selection.workspaceId };
    if (!(await authorizeToolCheck(ctx, command.run, args, cancellation.signal))) { print({ ok: false, code: "production_check_not_authorized" }); return cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG; }
    const claim = await claimToolProductionCheck({ ...selection, issuedAt: new Date(ctx.now()).toISOString() });
    if (!claim.ok) { print(claim); return EXIT_CODES.CONFIG; }
    const deadline = new AbortController();
    const monitor = monitorToolJob({ boardRoot: selection.boardRoot, jobId: claim.jobId, attempt: claim.attempt, signal: AbortSignal.any([cancellation.signal, deadline.signal]) });
    const timeout = setTimeout(() => deadline.abort(), 240_000);
    try {
      const checked = await service.check(claim.plan, claim.jobId, monitor.signal);
      await monitor.check();
      const issued = checked.kind === "verified" ? { ok: true as const, receipt: checked.receipt } : undefined;
      const admitted = issued?.ok && !monitor.signal.aborted ? await admitToolProductionVerification({ ...selection, jobId: claim.jobId, receiptId: issued.receipt.receiptId, issuedAt: new Date(ctx.now()).toISOString() }) : undefined;
      const outcome = admitted?.ok ? "verified" : monitor.signal.aborted ? "cancelled" : "failed";
      const finished = await finishToolProductionCheck({ ...selection, jobId: claim.jobId, record: checked.record, outcome,
        ...(issued?.ok ? { receiptId: issued.receipt.receiptId } : {}), issuedAt: new Date(ctx.now()).toISOString() });
      print({ ok: admitted?.ok === true && finished.ok, versionId: selection.versionId, jobId: claim.jobId, outcome, record: checked.record,
        issuance: issued, checkFailure: checked.kind === "verified" ? undefined : checked.failure, admission: admitted, persistence: finished, activated: false });
      return admitted?.ok && finished.ok ? EXIT_CODES.OK : outcome === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE;
    } finally { clearTimeout(timeout); monitor.close(); }
  } catch {
    print({ ok: false, code: "production_check_unavailable", message: "check did not complete; inspect retained job, report and authority receipt before retrying" });
    return cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG;
  } finally { cancellation.close(); }
}
