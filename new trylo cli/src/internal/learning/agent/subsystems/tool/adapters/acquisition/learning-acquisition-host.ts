import path from "node:path";
import type { ApprovalConsumptionPort } from "../../../../../../ports/approval-consumption.js";
import type { PermissionIssueOutcome } from "../../../../../../adapters/permission-store/file-ledger.js";
import { npmInstallId } from "../../../../../../tooling/contract/npm-install.js";
import { ok } from "../../../../../../tooling/contract/result.js";
import { readToolAcquisition, saveToolAcquisitionPlan, recordToolAcquisitionInstalled } from "../../runtime/acquisition-continuation.js";
import { resolveNpmLearningLock, type NpmResolutionHost } from "./npm-lock-resolver.js";
import { npmPreparationId, prepareNpmInstallation } from "./npm-install-preparation.js";
import type { NpmInstallTarget } from "../../../../../../tooling/contract/npm-tree.js";
import type { HttpTransport } from "./transport.js";
import { installNpmTree } from "./npm-install.js";
import { recordToolAcquisitionFailure } from "../../runtime/acquisition-failure.js";
import type { ToolAcquisitionFailurePhase } from "../../domain/evolution/acquisition-failure.js";

/** The explicit host passes a grant callback bound to one approved choice and scope.
 * Acquisition mechanics and Board continuation stay inside the tool subsystem. */
export async function acquireLearningChoice(input: { readonly boardRoot: string; readonly jobId: string; readonly scope: string;
  readonly approvalId: string; readonly installationRoot: string; readonly resolution: NpmResolutionHost;
  readonly target: NpmInstallTarget; readonly transport: HttpTransport; readonly signal: AbortSignal; readonly now: () => number;
  readonly approval: ApprovalConsumptionPort; readonly issueGrant: (id: string) => Promise<PermissionIssueOutcome> }) {
  const request = await readToolAcquisition(input.boardRoot, input.jobId, input.scope);
  if (!request.ok) return request;

  if (input.approvalId !== request.approvalId) return { ok: false as const, code: "approval_plan_mismatch" };

  if (request.decision.candidate.platform !== "npm") return { ok: false as const, code: "acquisition_runtime_unsupported" };

  const issuedAt = () => new Date(input.now()).toISOString();
  const failed = async <T extends { readonly ok: false; readonly code: string }>(phase: ToolAcquisitionFailurePhase, failure: T) => {
    const recorded = await recordToolAcquisitionFailure({ ...input, phase, failure, issuedAt: issuedAt() });
    return recorded.ok ? { ...failure, failureRef: recorded.versionId }
      : { ...failure, failureRecordCode: recorded.code };
  };
  let plan = request.installation, sourceTransport = input.transport;
  if (plan === undefined) {
    const resolved = await resolveNpmLearningLock({ scope: input.scope, name: request.decision.candidate.id,
      version: request.decision.candidate.version, target: input.target, transport: input.transport, signal: input.signal, host: input.resolution });
    if (!resolved.ok) return failed("resolve", resolved);

    const preparation = { scope: input.scope, name: request.decision.candidate.id, version: request.decision.candidate.version,
      target: input.target, lock: resolved.lock };
    const approved = await input.issueGrant(npmPreparationId(preparation));
    if (!approved.ok) return failed("preparation_permission", approved);

    const prepared = await prepareNpmInstallation(preparation, { approval: input.approval, token: { grantId: approved.grant.grantId },
      now: input.now, signal: input.signal, transport: input.transport });
    if (!prepared.ok) return failed("preparation", prepared);

    plan = prepared.plan;
    const saved = await saveToolAcquisitionPlan({ ...input, plan, issuedAt: issuedAt() });
    if (!saved.ok) return failed("plan_commit", saved);

    sourceTransport = { get: async fetch => {
      const bytes = prepared.archives.get(fetch.url);
      return bytes === undefined ? input.transport.get(fetch) : ok({ status: 200, body: bytes });
    } };
  }

  const approved = await input.issueGrant(npmInstallId(plan));
  if (!approved.ok) return failed("install_permission", approved);

  const installed = await installNpmTree(plan, { root: path.resolve(input.installationRoot), target: input.target,
    approval: input.approval, token: { grantId: approved.grant.grantId }, now: input.now, signal: input.signal, transport: sourceTransport });
  if (!installed.ok) return failed("install", installed);

  const recorded = await recordToolAcquisitionInstalled({ ...input, plan, grantId: installed.receipt.approvalGrantId, issuedAt: issuedAt() });

  return recorded.ok ? { ok: true as const, state: "installed" as const, installationId: installed.receipt.planId, jobId: input.jobId,
    changed: installed.changed, next: "adapt_and_prepare_production", activated: false } : failed("receipt_commit", recorded);
}
