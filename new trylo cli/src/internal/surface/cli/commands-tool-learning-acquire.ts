import path from "node:path";
import type { CliContext } from "./context.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { permissionLedgerPath, tryloHome } from "./session-paths.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { workspaceIdentity } from "./wiring.js";
import { hostNodeExecutable } from "../../adapters/sandbox/executable.js";
import { readToolAcquisition } from "../../learning/agent/subsystems/tool/runtime/acquisition-continuation.js";
import { acquireLearningChoice } from "../../learning/agent/subsystems/tool/adapters/acquisition/learning-acquisition-host.js";
import { locateNpmCli } from "../../learning/agent/subsystems/tool/adapters/acquisition/npm-lock-resolver.js";
import { createHttpsTransport } from "../../learning/agent/subsystems/tool/adapters/acquisition/transport.js";
import { hostNpmTarget } from "../../learning/agent/subsystems/tool/adapters/acquisition/npm-platform.js";
import type { ToolLearningAcquireCommand } from "./args-tool-learning-acquire.js";
import { parseRun } from "./args-run.js";
import { runAcquisitionAdaptation } from "../../learning/agent/subsystems/tool/runtime/acquisition-adaptation-jobs.js";
import { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";
import { npmAdaptationServices } from "./tool-npm-adaptation-wiring.js";
import { reviewToolLearningAcquisition } from "../../learning/agent/subsystems/tool/runtime/acquisition-review.js";
import { reviewAcquisitionAdaptationRecovery } from "../../learning/agent/subsystems/tool/runtime/acquisition-adaptation-recovery-review.js";
import { recoverExpiredAcquisitionAdaptation } from "../../learning/agent/subsystems/tool/runtime/acquisition-adaptation-operator-recovery.js";
import { acquisitionAdaptationJobId } from "../../learning/agent/subsystems/tool/domain/evolution/acquisition-identity.js";
import { npmInstallId } from "../../tooling/contract/npm-install.js";
import { reviewAcquisitionInquiry } from "../../learning/agent/subsystems/tool/runtime/acquisition-inquiry-review.js";
import { recoverExpiredAcquisitionInquiry } from "../../learning/agent/subsystems/tool/runtime/acquisition-inquiry-recovery.js";
import { runToolAcquisitionInquiry } from "./tool-acquisition-inquiry-wiring.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

/** Only this explicit user-command surface supplies grant issuance to the acquisition adapter. */
export async function handleToolLearningAcquire(ctx: CliContext, input: ToolLearningAcquireCommand, boardRoot: string) {
  const scope = workspaceIdentity(path.resolve(ctx.cwd));
  const print = (result: { readonly ok: boolean; readonly code?: string; readonly [key: string]: unknown }) => {
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : result.code === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG;
  };
  const committed = async (result: Parameters<typeof print>[0]) => {
    if (result.ok || result.installed === true || typeof result.failureRef === "string") {
      const refs = [input.jobId, ...(input.approvalId === undefined ? [] : [input.approvalId])];
      for (const key of ["jobId", "childJobId", "versionId", "failureRef", "outcomeVersionId", "installationId"]) {
        if (typeof result[key] === "string") refs.push(result[key]);
      }
      await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
        reason: "tool_native_acquisition_state_committed", sourceRefs: [...new Set(refs)] });
    }
    return print(result);
  };

  if (input.inquiry !== undefined) {
    const selection = { boardRoot, jobId: input.jobId, scope, failureRef: input.inquiry.failureRef, now: ctx.now,
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }) };

    if (input.inquiry.recoveryReviewId !== undefined) return committed(input.approvalId === undefined ? { ok: false, code: "approval_plan_mismatch" }
      : await recoverExpiredAcquisitionInquiry({ ...selection, approvalId: input.approvalId, reviewId: input.inquiry.recoveryReviewId }));

    if (input.inquiry.reviewId === undefined) return print(await reviewAcquisitionInquiry(selection));

    const parsed = parseRun(["tool-acquisition-inquiry"]);
    if (input.approvalId === undefined || parsed.kind !== "run") return print({ ok: false, code: "approval_plan_mismatch" });

    const cancellation = observeRunCancellation(ctx);

    try { return await committed(await runToolAcquisitionInquiry(ctx, { ...selection, approvalId: input.approvalId,
      reviewId: input.inquiry.reviewId, signal: cancellation.signal, run: input.run ?? parsed.options })); }
    catch { return print({ ok: false, code: cancellation.signal.aborted ? "cancelled" : "acquisition_inquiry_unavailable" }); }
    finally { cancellation.close(); }
  }

  if (input.recovery !== undefined) {
    const selection = { boardRoot, jobId: input.jobId, scope, ...input.recovery, now: ctx.now,
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }) };
    if (input.recovery.reviewId === undefined) return print(await reviewAcquisitionAdaptationRecovery(selection));
    return committed(input.approvalId === undefined ? { ok: false, code: "approval_plan_mismatch" }
      : await recoverExpiredAcquisitionAdaptation({ ...selection, approvalId: input.approvalId, reviewId: input.recovery.reviewId }));
  }

  if (input.approvalId === undefined) return print(await reviewToolLearningAcquisition(boardRoot, input.jobId, scope));

  const request = await readToolAcquisition(boardRoot, input.jobId, scope);
  if (!request.ok) return print(request);

  if (input.approvalId !== request.approvalId) return print({ ok: false, code: "approval_plan_mismatch" });

  const cancellation = observeRunCancellation(ctx), home = tryloHome(ctx.homeDir, ctx.env);

  try {
    if (input.resumeChildJobId !== undefined) {
      if (request.installation === undefined || input.resumeChildJobId !== acquisitionAdaptationJobId(input.jobId, input.approvalId, npmInstallId(request.installation))) {
        return print({ ok: false, code: "invalid_continuation_binding" });
      }
      return await committed(await continueAdaptation(ctx, input, request, boardRoot, scope, home, cancellation.signal));
    }

    const nodeExecutable = hostNodeExecutable(), npmCli = await locateNpmCli(nodeExecutable, ctx.env.PATH ?? ctx.env.Path ?? "");
    const store = createFilePermissionStore({ path: permissionLedgerPath(ctx.homeDir, ctx.env) });
    const installed = await acquireLearningChoice({ boardRoot, jobId: input.jobId, scope, approvalId: input.approvalId,
      installationRoot: path.join(home, "learning/tool/installations"), resolution: { nodeExecutable, npmCli: npmCli ?? "",
        scratchRoot: path.join(home, "learning/tool/resolution"), ...(ctx.env.SystemRoot === undefined ? {} : { systemRoot: ctx.env.SystemRoot }) },
      target: hostNpmTarget(), transport: createHttpsTransport(), signal: cancellation.signal, now: ctx.now, approval: store,
      issueGrant: id => store.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope,
        issuedAt: new Date(ctx.now()).toISOString(), expiry: new Date(ctx.now() + 300_000).toISOString() }) });
    if (!installed.ok) return await committed(installed);

    await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
      reason: "tool_native_acquisition_installed", sourceRefs: [input.jobId, input.approvalId, installed.installationId] });

    return await committed(await continueAdaptation(ctx, input, request, boardRoot, scope, home, cancellation.signal, installed.installationId));
  } catch { return print({ ok: false, code: cancellation.signal.aborted ? "cancelled" : "learning_acquisition_unavailable" }); }
  finally { cancellation.close(); }
}

async function continueAdaptation(ctx: CliContext, command: ToolLearningAcquireCommand,
  request: Extract<Awaited<ReturnType<typeof readToolAcquisition>>, { readonly ok: true }>, boardRoot: string, scope: string,
  home: string, signal: AbortSignal, installedId?: string) {
  const parsed = parseRun(["tool-acquisition-adaptation"]);
  if (parsed.kind !== "run" || command.approvalId === undefined) return { ok: false, code: "invalid_adaptation_run" };

  const run = command.run ?? parsed.options;
  const adapted = await runAcquisitionAdaptation({ boardRoot, jobId: command.jobId, scope, approvalId: command.approvalId,
    workspaceId: scope, installationRoot: path.join(home, "learning/tool/installations"), now: ctx.now, signal,

    services: async continuationJobId => {
      const funding = createToolLearningFunding({ boardRoot, scope, centralScope: ctx.cwd, now: ctx.now, continuationJobId });
      const session = openToolEvolutionSession(ctx, run, { boardRoot, mode: "manual", funding });
      if ("exitCode" in session) throw new Error("provider_configuration_unavailable");
      return { ...npmAdaptationServices(ctx, { boardRoot, plan: request.learningPlan, run, funding,
        complete: (prompt, callSignal, phase) => session.complete(prompt, callSignal, phase) }),
      release: async () => { try { await session.close(); } finally { await funding.release(); } } };
    } });

  return { ...adapted, installationId: installedId ?? (request.installation === undefined ? undefined : npmInstallId(request.installation)), installed: true,
    next: adapted.ok ? "production_verify_then_explicit_activation" : "resume_adaptation_with_evidence_or_remaining_allowance" };
}
