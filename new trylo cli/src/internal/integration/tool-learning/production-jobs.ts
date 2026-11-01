import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { productionFromBoard } from "./production-assets.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ValidationRecord } from "../../tooling/contract/types.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";

type Selection = { readonly boardRoot: string; readonly versionId: string; readonly workspaceId: string; readonly issuedAt: string };

/** Operator closeout is bound to the exact workspace plan; it does not retry or issue a receipt. */
export async function expireToolProductionCheck(input: Selection & { readonly jobId: string }) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const selected = productionFromBoard(loaded.state, input.versionId, input.workspaceId);
    if (!selected.ok) return selected;
    const job = loaded.state.jobs.find(item => item.jobId === input.jobId);
    const prefix = `tool-production-check:v1:${contentHashOf(selected.plan)}:`;
    if (job === undefined || !job.jobId.startsWith(prefix) || job.observationId !== selected.proposalId || job.domain !== "tool"
      || job.scope !== toolProductionScope(selected.plan)) return pipelineFailure("production_check_claim_lost", "job is not bound to this plan");
    if (job.state === "expired") return { ok: true as const, jobId: job.jobId };
    const applied = await store.apply({ type: "fail_job", commandId: `${input.jobId}:operator-expire`, issuedAt: input.issuedAt, jobId: input.jobId, terminal: "expired" });
    return applied.ok ? { ok: true as const, jobId: job.jobId } : pipelineFailure(applied.reason, applied.detail);
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

/** Explicit checks use existing Board jobs, one real execution per claim; no automatic retry. */
export async function claimToolProductionCheck(input: Selection) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const selected = productionFromBoard(loaded.state, input.versionId, input.workspaceId);
    if (!selected.ok) return selected;
    if (selected.lifecycle !== "evaluating") return pipelineFailure("production_lifecycle_mismatch", "only evaluating plans may be checked");
    const prefix = `tool-production-check:v1:${contentHashOf(selected.plan)}:`;
    const history = loaded.state.jobs.filter(item => item.jobId.startsWith(prefix));
    if (history.some(item => item.state === "running" || item.state === "waiting_approval" || item.state === "succeeded")) return pipelineFailure("production_check_in_flight", "inspect the existing check and receipt; lost executions must be explicitly expired before another attempt");
    const queued = history.find(item => item.state === "queued");
    if (queued === undefined && history.length >= 3) return pipelineFailure("production_check_budget", "three explicit checks exhausted; create a newly reviewed plan");
    const jobId = queued?.jobId ?? `${prefix}${history.length + 1}`, scope = toolProductionScope(selected.plan);
    if (queued === undefined) {
      const enqueued = await store.apply({ type: "enqueue_job", commandId: `${jobId}:enqueue`, issuedAt: input.issuedAt,
        job: { jobId, scope, observationId: selected.proposalId, domain: "tool", maxAttempts: 1, dedupeKey: prefix } });
      if (!enqueued.ok) return pipelineFailure(enqueued.reason, enqueued.detail);
    }
    const started = await store.apply({ type: "start_job", commandId: `${jobId}:start`, issuedAt: input.issuedAt, jobId });
    return started.ok ? { ok: true as const, jobId, attempt: 1, plan: selected.plan } : pipelineFailure(started.reason, started.detail);
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

/** Archived outcomes are diagnostics. They cannot be replayed into new authority receipts. */
export async function finishToolProductionCheck(input: Selection & { readonly jobId: string; readonly record: ValidationRecord;
  readonly outcome: "verified" | "failed" | "cancelled"; readonly receiptId?: string }) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const selected = productionFromBoard(loaded.state, input.versionId, input.workspaceId);
    if (!selected.ok) return selected;
    const job = loaded.state.jobs.find(item => item.jobId === input.jobId);
    if (job?.state !== "running" || job.attempt !== 1 || job.observationId !== selected.proposalId
      || input.record.packageVersionId !== input.versionId) return pipelineFailure("production_check_claim_lost", "check job is not owned by this attempt");
    if (input.outcome === "verified" && !loaded.state.evidence.some(item => item.proposalId === selected.proposalId && item.dataVersion === input.versionId
      && item.receipt?.receiptId === input.receiptId && item.externalVerdict === "pass")) return pipelineFailure("production_verification_required", "a verified check requires its admitted receipt");
    const report = { type: "tool_production_check_report", schemaVersion: 1, versionId: input.versionId, jobId: input.jobId,
      outcome: input.outcome, record: input.record, receiptId: input.receiptId ?? null };
    const saved = await savePipelineAsset(store, { versionId: `production-check-report:${contentHashOf(report)}`, kind: "workflow", content: report,
      scope: toolProductionScope(selected.plan), source: "user_explicit", issuedAt: input.issuedAt });
    if (!saved.ok) return saved;
    const base = { jobId: input.jobId, issuedAt: input.issuedAt, commandId: `${input.jobId}:finish` };
    const finished = input.outcome === "verified" && input.receiptId !== undefined
      ? await store.apply({ ...base, type: "complete_job", next: "succeeded" })
      : await store.apply({ ...base, type: "fail_job", terminal: input.outcome === "cancelled" ? "cancelled" : "failed" });
    return finished.ok ? { ok: true as const, jobId: input.jobId, outcome: input.outcome } : pipelineFailure(finished.reason, finished.detail);
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}
