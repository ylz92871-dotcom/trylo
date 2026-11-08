import path from "node:path";
import type { CliContext } from "./context.js";
import type { ToolContractCommand } from "./args-tool-contract.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { workspaceIdentity } from "./wiring.js";
import { permissionLedgerPath } from "./session-paths.js";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { decodeToolContractRevisionProposal } from "../../learning/agent/subsystems/tool/domain/evolution/contract-revision.js";
import { approveToolContractRevision, listToolContractRevisions, proposeToolContractRevision, reviewToolContractRevision } from "../../learning/agent/subsystems/tool/runtime/contract-revisions.js";
import { withdrawToolContractRevision } from "../../learning/agent/subsystems/tool/runtime/contract-revision-withdrawal.js";
import { contractRevisionResumeJobs } from "../../learning/agent/subsystems/tool/runtime/contract-revision-resume.js";
import { parseRun } from "./args-run.js";
import { afterTurnToolCycle } from "./tool-cycle-wiring.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { planForJob } from "../../learning/agent/subsystems/tool/runtime/pipeline-records.js";
import { toolFundingOriginFromBoard } from "../../learning/agent/subsystems/tool/runtime/tool-funding-origin.js";
import { toolLearningFundingIdentity } from "../../learning/agent/subsystems/tool/domain/evolution/funding-identity.js";
import { selectToolFocusedSource } from "../../learning/agent/subsystems/tool/runtime/central-source.js";
import { toolFundingGrantMatches } from "../../learning/agent/subsystems/tool/runtime/tool-funding-grant.js";

/** Only this explicit user-command surface issues the narrowly bound grant.
 * Learning workers can save proposals but never call the Permission issuer. */
export async function handleToolContract(ctx: CliContext, command: ToolContractCommand, boardRoot: string): Promise<ExitCode> {
  const scope = workspaceIdentity(path.resolve(ctx.cwd));
  const print = <T extends { readonly ok: boolean }>(result: T): ExitCode => {
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  };

  if (command.kind === "contract-revisions") return print(await listToolContractRevisions(boardRoot, command.parentVersionId, scope));

  if (command.kind === "contract-propose") {
    const text = ctx.readFile(path.resolve(ctx.cwd, command.proposalFile));
    let raw: unknown;

    try { raw = text === undefined || Buffer.byteLength(text) > 128 * 1024 ? undefined : JSON.parse(text); }
    catch { raw = undefined; }

    const proposal = decodeToolContractRevisionProposal(raw);
    if (proposal === undefined) return print({ ok: false, code: "invalid_contract_revision", message: "proposal.json must contain exact old hashes and expected replacements, without approval claims" });

    if (proposal.scope !== scope) return print({ ok: false, code: "contract_revision_scope_mismatch", message: "the proposal is not for this learning workspace" });

    return print(await proposeToolContractRevision(boardRoot, proposal, new Date(ctx.now()).toISOString()));
  }

  const review = await reviewToolContractRevision(boardRoot, command.proposalId, scope);
  if (!review.ok || command.kind === "contract-show") return print(review);

  const reviewId = command.kind === "contract-withdraw" ? review.withdrawReviewId : review.reviewId;
  if (command.reviewId !== reviewId) return print({ ok: false, code: "contract_revision_review_stale", message: "run contract-show and approve the exact reviewId for this operation after inspecting its effect" });

  if (review.approved && command.kind === "contract-approve") {
    const learningResume = await resumeContractLearning(ctx, boardRoot, scope, command.proposalId);
    await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
      reason: "tool_native_contract_approved", sourceRefs: [command.proposalId, review.revisionId] });
    return print({ ok: true, revisionId: review.revisionId, duplicate: true, learningResume });
  }

  const permission = createFilePermissionStore({ path: permissionLedgerPath(ctx.homeDir, ctx.env) }), now = ctx.now();
  const issued = await permission.issue({ action: "modify", candidateId: reviewId, packageVersionId: review.proposal.parentVersionId,
    scope, issuedAt: new Date(now).toISOString(), expiry: new Date(now + 60_000).toISOString() });
  if (!issued.ok) return print(issued);

  if (command.kind === "contract-withdraw") {
    const result = await withdrawToolContractRevision({ boardRoot, proposalId: command.proposalId,
      scope, withdrawReviewId: command.reviewId, permission, token: { grantId: issued.grant.grantId }, issuedAt: new Date(ctx.now()).toISOString() });
    if (result.ok) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
      reason: "tool_native_contract_withdrawn", sourceRefs: [command.proposalId, review.revisionId] });
    return print(result);
  }

  const accepted = await approveToolContractRevision({ boardRoot, proposalId: command.proposalId, scope, reviewId: command.reviewId,
    permission, token: { grantId: issued.grant.grantId }, issuedAt: new Date(ctx.now()).toISOString() });
  if (!accepted.ok) return print(accepted);

  const learningResume = await resumeContractLearning(ctx, boardRoot, scope, command.proposalId);

  await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
    reason: "tool_native_contract_approved", sourceRefs: [command.proposalId, accepted.revisionId] });

  return print({ ...accepted, learningResume });
}

async function resumeContractLearning(ctx: CliContext, boardRoot: string, scope: string, proposalId: string) {
  const waiting = await contractRevisionResumeJobs(boardRoot, proposalId, scope);
  if (!waiting.ok) return { kind: "unavailable" as const, code: waiting.code };

  if (waiting.jobIds.length === 0) return { kind: "no_pending_job" as const };

  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { kind: "unavailable" as const, code: loaded.reason };

  const workspaceRoot = path.resolve(ctx.cwd), root = loaded.state.centralLearningBudgets?.find(item => item.scope === workspaceRoot);
  if (root !== undefined) {
    for (const jobId of waiting.jobIds) {
      const plan = planForJob(loaded.state, jobId), job = loaded.state.jobs.find(item => item.jobId === jobId);
      if (plan === undefined || job?.scope !== scope || plan.scope !== scope || !toolFundingOriginFromBoard(loaded.state, plan).ok) {
        return { kind: "unavailable" as const, code: "contract_resume_source_unavailable" };
      }

      const identity = toolLearningFundingIdentity(plan), grant = loaded.state.centralLearningGrants?.find(item => item.grantId === identity.grantId);
      const issue = loaded.state.learningIssues?.find(item => item.issueId === identity.issueId);
      if (issue !== undefined) {
        const source = selectToolFocusedSource(loaded.state, issue, scope, issue.scope);
        if (!source.ok || source.jobId !== jobId || grant !== undefined && !toolFundingGrantMatches(loaded.state, plan, grant)
          || grant?.budgetId !== undefined && (grant.budgetId !== root.budgetId || grant.scope !== root.scope)) {
          return { kind: "unavailable" as const, code: "contract_resume_managed_binding" };
        }
      } else if (grant !== undefined) return { kind: "unavailable" as const, code: "contract_resume_managed_binding" };
    }
    // This exact workspace root owns all new funding here, even before a grant
    // exists. A detached unbound worker must not race its managed dispatcher.
    return { kind: "deferred_to_central" as const, jobIds: waiting.jobIds };
  }

  const parsed = parseRun(["Resume approved tool contract investigation"]);
  if (parsed.kind !== "run") return { kind: "unavailable" as const, code: "contract_resume_run_options_unavailable" };

  try {
    await afterTurnToolCycle(ctx, { workspaceId: scope, run: parsed.options })(waiting.jobIds);
    return { kind: "dispatch_requested" as const, jobIds: waiting.jobIds };
  } catch {
    return { kind: "unavailable" as const, code: "contract_resume_dispatch_unavailable" };
  }
}
