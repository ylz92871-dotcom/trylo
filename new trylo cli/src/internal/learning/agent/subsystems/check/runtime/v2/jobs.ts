import { withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../../control/commands.js";
import type { BoardStore } from "../../../../../control/store-port.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { appendCheckerRecord, decodeCheckerCatalog, failure, readCheckerBoard, validAllowance } from "../../adapters/board/store.js";
import type { CheckerEngineOptions, CheckerJobResult, CheckerLease } from "./contracts.js";

export function checkerJobId(basis: unknown): string { return "checker-job:" + contentHashOf(basis); }

/** A lease precedes enqueue/start. Same-owner submission repairs are safe only before any external boundary. */
export async function claimCheckerJob(options: CheckerEngineOptions, lease: CheckerLease) {
  if (!validAllowance(lease.allowance) || lease.allowance.modelCalls < 1 || lease.allowance.modelCalls > 3
    || lease.jobId !== checkerJobId(lease.basis) || lease.ownerId !== options.owner.id) return failure("invalid_checker_lease", lease.jobId);

  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return failure(loaded.reason, loaded.detail);

    const decoded = decodeCheckerCatalog(loaded.state);
    if (!decoded.ok) return decoded;

    const previous = loaded.state.jobs.find(job => job.jobId === lease.jobId);
    const reserved = decoded.catalog.leases.find(item => item.jobId === lease.jobId);
    if (reserved !== undefined && contentHashOf(reserved) !== contentHashOf(lease)) {
      return { ok: true as const, claimed: false, state: previous?.state ?? "queued" };
    }

    if (previous !== undefined && (previous.state !== "queued" || decoded.catalog.generationStarts.some(item => item.jobId === lease.jobId))) {
      return { ok: true as const, claimed: false, state: previous.state };
    }

    const issuedAt = new Date(options.now()).toISOString();

    if (reserved === undefined) {
      if (previous !== undefined) return failure("checker_job_missing_lease", lease.jobId);
      const saved = await appendCheckerRecord(store, lease, issuedAt);
      if (!saved.ok) return saved;
    }

    if (previous === undefined) {
      const queued = await enqueue(store, lease, issuedAt);
      if (!queued.ok) return queued;
    }

    const started = await store.apply({ type: "start_job", commandId: lease.jobId + ":start", issuedAt, jobId: lease.jobId });

    return started.ok ? { ok: true as const, claimed: true, state: "running" as const } : failure(started.reason, started.detail);
  });

  return "reason" in result ? failure(result.reason, result.detail) : result;
}

/** The result is committed first; terminal replay repairs only the lifecycle and never repeats an external action. */
export async function settleCheckerJob(options: CheckerEngineOptions, outcome: CheckerJobResult) {
  return settle(options, outcome, { kind: "active" });
}

async function settle(options: CheckerEngineOptions, outcome: CheckerJobResult, authority: { readonly kind: "active" | "recovery" }) {
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return failure(loaded.reason, loaded.detail);

    const decoded = decodeCheckerCatalog(loaded.state);
    if (!decoded.ok) return decoded;

    const lease = decoded.catalog.leases.find(item => item.jobId === outcome.jobId);
    const committed = decoded.catalog.results.find(item => item.jobId === outcome.jobId);

    if (lease === undefined || lease.scope !== outcome.scope || !validAllowance(outcome.usage)
      || Object.keys(lease.allowance).some(key => outcome.usage[key as keyof typeof outcome.usage] > lease.allowance[key as keyof typeof lease.allowance])) {
      return failure("checker_job_result_mismatch", outcome.jobId);
    }

    if (committed !== undefined && contentHashOf(committed) !== contentHashOf(outcome)) return failure("checker_identity_conflict", "checker_job_result");

    if (committed === undefined && authority.kind === "active" && lease.ownerId !== options.owner.id) return failure("checker_job_owner_mismatch", outcome.jobId);

    const issuedAt = new Date(options.now()).toISOString();
    const job = loaded.state.jobs.find(item => item.jobId === outcome.jobId);
    if (job !== undefined && job.state !== "queued" && job.state !== "running") {
      return committed === undefined ? failure("checker_job_terminal_without_result", outcome.jobId) : { ok: true as const };
    }

    if (job === undefined) {
      const queued = await enqueue(store, lease, issuedAt);
      if (!queued.ok) return queued;
    }

    if (committed === undefined) {
      const saved = await appendCheckerRecord(store, outcome, issuedAt);
      if (!saved.ok) return saved;
    }

    const success = outcome.outcome !== "failed" && outcome.outcome !== "cancelled";
    if (success && job?.state !== "running") {
      const started = await store.apply({ type: "start_job", commandId: outcome.jobId + ":start", issuedAt, jobId: outcome.jobId });
      if (!started.ok) return failure(started.reason, started.detail);
    }

    const command: BoardCommand = success
      ? { type: "complete_job", commandId: outcome.jobId + ":finish", issuedAt, jobId: outcome.jobId, next: "succeeded" }
      : { type: "fail_job", commandId: outcome.jobId + ":finish", issuedAt, jobId: outcome.jobId,
        terminal: outcome.outcome === "cancelled" ? "cancelled" : "failed" };
    const applied = await store.apply(command);

    return applied.ok ? { ok: true as const } : failure(applied.reason, applied.detail);
  });
  return "reason" in result ? failure(result.reason, result.detail) : result;
}

/** Liveness must prove death. Lease-only, queued and result-before-terminal windows all have explicit closeout. */
export async function recoverCheckerJobs(options: CheckerEngineOptions) {
  const loaded = await readCheckerBoard(options.boardRoot);
  if (!loaded.ok) return loaded;

  const results: string[] = [];

  for (const lease of loaded.catalog.leases) {
    const job = loaded.state.jobs.find(item => item.jobId === lease.jobId);
    if (job !== undefined && job.state !== "queued" && job.state !== "running") continue;

    const committed = loaded.catalog.results.find(item => item.jobId === lease.jobId);
    if (committed === undefined && await ownerState(options, lease.ownerId) !== "dead") continue;

    const noExternalStep = (job === undefined || job.state === "queued")
      && !loaded.catalog.generationStarts.some(item => item.jobId === lease.jobId);
    const outcome: CheckerJobResult = committed ?? { schemaVersion: 2, type: "checker_job_result", jobId: lease.jobId, scope: lease.scope,
      outcome: "failed", reason: noExternalStep ? "owner_lost_before_external_work" : "owner_lost_outcome_unknown",
      usage: noExternalStep ? { modelCalls: 0, executions: 0, tokens: 0 } : lease.allowance };
    const settled = await settle(options, outcome, { kind: "recovery" });
    if (!settled.ok) return settled;

    results.push(lease.jobId);
  }

  return { ok: true as const, recovered: results };
}

async function enqueue(store: BoardStore, lease: CheckerLease, issuedAt: string) {
  const applied = await store.apply({ type: "enqueue_job", commandId: lease.jobId + ":enqueue", issuedAt,
    job: { jobId: lease.jobId, observationId: lease.basis, domain: "verifier", scope: lease.scope, maxAttempts: 1, dedupeKey: lease.basis } });
  return applied.ok ? { ok: true as const } : failure(applied.reason, applied.detail);
}

async function ownerState(options: CheckerEngineOptions, ownerId: string) {
  try { return await options.owner.alive(ownerId); }
  catch { return "unknown" as const; } // Probe failure cannot prove that another worker stopped.
}
