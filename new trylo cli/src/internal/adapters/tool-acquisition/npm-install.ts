import path from "node:path";
import type { ApprovalConsumptionPort, ApprovalGrantRef } from "../../ports/approval-consumption.js";
import { consumeApproval } from "../../tooling/approval/gates.js";
import type { NpmInstallTarget } from "../../tooling/contract/npm-tree.js";
import type { NpmInstallReceipt } from "../../tooling/contract/npm-install.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { decodeNpmInstallPlan, npmInstallId } from "./npm-install-plan.js";
import { createHttpsTransport, type HttpTransport } from "./transport.js";
import { fetchArchive } from "./fetch-archive.js";
import { inspectNpmInstallContent, npmInstallFileIndex } from "./npm-install-content.js";
import { readNpmInstall, readNpmInstallStaging, writeNpmInstall } from "./npm-install-files.js";
import { checkQuarantineAncestors, ensureQuarantineDirectory, lockNpmQuarantine, QuarantineFileError } from "./quarantine-files.js";
import { NpmPackageError } from "./npm-package-check.js";
import { PackageArchiveError } from "./ustar-reader.js";
import { NpmTreeError } from "./npm-tree-contract.js";
import { NpmPublicationError, publishNpmInstall, type NpmPublicationIo } from "./npm-install-publication.js";

export type NpmInstallOptions = { readonly root: string; readonly target: NpmInstallTarget; readonly approval: ApprovalConsumptionPort;
  readonly token: ApprovalGrantRef; readonly now: () => number; readonly signal: AbortSignal; readonly transport?: HttpTransport; readonly publicationIo?: NpmPublicationIo };

/** Private bytes only. Publication may retry transient filesystem errors; downloads and package code never replay. */
export async function installNpmTree(raw: unknown, options: NpmInstallOptions) {
  const plan = decodeNpmInstallPlan(raw);
  if (plan === undefined) return failure("invalid_npm_install_plan");
  if (contentHashOf(plan.tree.target) !== contentHashOf(options.target)) return failure("npm_install_target_mismatch");
  if (options.signal.aborted) return failure("cancelled");
  const planId = npmInstallId(plan), destination = path.join(options.root, planId);
  let unlock: (() => Promise<void>) | undefined;
  try {
    await checkQuarantineAncestors(options.root);
    const prior = await readNpmInstall(destination, plan);
    if (prior !== undefined) return { ok: true as const, state: "installed" as const, changed: false, destination, receipt: prior.receipt };
    const approved = await consumeApproval(options.approval, { token: options.token, action: "acquire", candidateId: planId,
      packageVersionId: planId, scope: plan.tree.scope, now: new Date(options.now()).toISOString() });
    if (!approved.ok) return failure(approved.code);
    await ensureQuarantineDirectory(options.root); unlock = await lockNpmQuarantine(destination);
    // Another owner may have published between the first read and this lock acquisition.
    const raced = await readNpmInstall(destination, plan);
    if (raced !== undefined) return { ok: true as const, state: "installed" as const, changed: false, destination, receipt: raced.receipt };
    const staged = await readNpmInstallStaging(destination, plan);
    if (staged !== undefined) {
      await publishNpmInstall(destination, options.signal, options.publicationIo);
      const resumed = await readNpmInstall(destination, plan);
      if (resumed === undefined) return failure("quarantine_corrupt");
      return { ok: true as const, state: "installed" as const, changed: true, resumed: true, publicationGrantId: approved.value.grantId, destination, receipt: resumed.receipt };
    }
    const archives = new Map<string, Uint8Array>(); let compressed = 0;
    for (const pkg of plan.tree.packages) {
      const fetched = await fetchArchive(options.transport ?? createHttpsTransport(), pkg.archiveUrl, options.signal);
      if (!fetched.ok) return failure(fetched.code);
      compressed += fetched.value.body.length;
      if (compressed > 64 * 1024 * 1024) return failure("npm_install_archive_limit");
      archives.set(pkg.location, fetched.value.body);
    }
    const files = inspectNpmInstallContent(plan, archives);
    const receipt: NpmInstallReceipt = { type: "npm_install_receipt", schemaVersion: 1, planId, plan, acquiredAt: new Date(options.now()).toISOString(),
      approvalGrantId: approved.value.grantId, verification: "not_production_verified", files: npmInstallFileIndex(files) };
    if (options.signal.aborted) return failure("cancelled");
    await writeNpmInstall(destination, receipt, archives, files, options.signal, options.publicationIo);
    const saved = await readNpmInstall(destination, plan);
    if (saved === undefined) return failure("quarantine_corrupt");
    return { ok: true as const, state: "installed" as const, changed: true, destination, receipt: saved.receipt };
  } catch (error) {
    return failure(options.signal.aborted ? "cancelled" : npmInstallErrorCode(error));
  } finally {
    if (unlock !== undefined) await unlock().catch(() => { /* An owned stale lock stays visible; never replay a partially published install. */ });
  }
}
export function npmInstallErrorCode(error: unknown): string {
  return error instanceof QuarantineFileError || error instanceof NpmPackageError || error instanceof PackageArchiveError
    || error instanceof NpmTreeError || error instanceof NpmPublicationError ? error.code : "npm_install_unavailable";
}
function failure(code: string) { return { ok: false as const, code, message: "npm dependency installation did not establish a complete reviewed private tree; inspect retained evidence before a new explicit attempt" }; }
