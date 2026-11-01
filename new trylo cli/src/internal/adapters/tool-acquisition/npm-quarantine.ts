import path from "node:path";
import type { ApprovalConsumptionPort, ApprovalGrantRef } from "../../ports/approval-consumption.js";
import { consumeApproval } from "../../tooling/approval/gates.js";
import { fetchArchive } from "./fetch-archive.js";
import { decodeNpmQuarantinePlan, quarantineArchiveUrl, quarantinePlanId } from "./npm-quarantine-plan.js";
import { checkNpmPackage, NpmPackageError, sha256Bytes } from "./npm-package-check.js";
import { PackageArchiveError, readNpmTarball } from "./ustar-reader.js";
import { createHttpsTransport, type HttpTransport } from "./transport.js";
import { checkQuarantineAncestors, ensureQuarantineDirectory, lockNpmQuarantine, QuarantineFileError, readNpmQuarantine, writeNpmQuarantine, type NpmQuarantineReceipt } from "./quarantine-files.js";

export type NpmQuarantineOptions = {
  readonly root: string;
  readonly approval: ApprovalConsumptionPort;
  readonly token: ApprovalGrantRef;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly transport?: HttpTransport;
};

/** Real-byte acquisition. The caller selects a frozen plan; only Permission may authorize it. */
export async function acquireNpmQuarantine(raw: unknown, options: NpmQuarantineOptions) {
  const plan = decodeNpmQuarantinePlan(raw);
  if (plan === undefined) return failure("invalid_acquisition_plan");
  if (options.signal.aborted) return failure("cancelled");
  const id = quarantinePlanId(plan), destination = path.join(options.root, id);
  let unlock: (() => Promise<void>) | undefined;
  try {
    await checkQuarantineAncestors(options.root);
    const prior = await readNpmQuarantine(destination, plan);
    if (prior !== undefined) return { ok: true as const, state: "quarantined" as const, changed: false, destination, receipt: prior };
    const approved = await consumeApproval(options.approval, { token: options.token, action: "acquire", candidateId: id, packageVersionId: id, scope: plan.scope, now: new Date(options.now()).toISOString() });
    if (!approved.ok) return failure(approved.code);
    await ensureQuarantineDirectory(options.root);
    unlock = await lockNpmQuarantine(destination);
    const response = await fetchArchive(options.transport ?? createHttpsTransport(), quarantineArchiveUrl(plan), options.signal);
    if (!response.ok) return failure(response.code);
    // Never trust a transport's claimed digest: hash the received body at the admission boundary.
    if (sha256Bytes(response.value.body) !== plan.sha256) return failure("hash_mismatch");
    const files = readNpmTarball(response.value.body, plan.sha256);
    checkNpmPackage(plan, files);
    if (options.signal.aborted) return failure("cancelled");
    const receipt: NpmQuarantineReceipt = { schemaVersion: 1, planId: id, plan, acquiredAt: new Date(options.now()).toISOString(),
      approvalGrantId: approved.value.grantId, verification: "not_production_verified",
      files: files.map(file => ({ path: file.path, sha256: sha256Bytes(file.body), bytes: file.body.length })) };
    await writeNpmQuarantine(destination, receipt, files, options.signal);
    const verified = await readNpmQuarantine(destination, plan);
    if (verified === undefined) return failure("quarantine_corrupt");
    return { ok: true as const, state: "quarantined" as const, changed: true, destination, receipt: verified };
  } catch (error) {
    return failure(options.signal.aborted ? "cancelled" : error instanceof NpmPackageError || error instanceof PackageArchiveError || error instanceof QuarantineFileError ? error.code : "quarantine_unavailable");
  } finally {
    // A stale lock is visible on the next call; cleanup cannot turn a rejected archive into success.
    if (unlock !== undefined) await unlock().catch(() => { /* Preserve the owned lock for explicit inspection. */ });
  }
}
function failure(code: string) { return { ok: false as const, code, message: "npm acquisition did not establish a verified quarantine; inspect the retained receipt or staging directory" }; }
