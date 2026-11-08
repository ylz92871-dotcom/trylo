import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningJobId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure, savePipelineAsset, type PipelineFailure } from "./pipeline-assets.js";
import { enqueueToolLearningPlan, planForJob } from "./pipeline-queue.js";
import { toolProductionCheckFailureFromBoard, type ToolProductionFailureEvidence } from "./production-check-reader.js";

type Input = { readonly boardRoot: string; readonly versionId: string; readonly workspaceId: string; readonly jobId: string };

export type ProductionCheckLearningHandoff =
  | { readonly kind: "queued"; readonly jobId: string; readonly reportVersionId: string }
  | { readonly kind: "not_requested"; readonly reason: "no_failed_check" | "unclassified" | "blocked" | "unsupported_parent" | "already_scheduled" }
  | { readonly kind: "unavailable"; readonly code: string };

/** The completed report is the durable outbox. This performs no checker run,
 * execution grant, model call, promotion, or activation. */
export async function scheduleToolProductionCheckLearning(input: Input): Promise<ProductionCheckLearningHandoff> {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return { kind: "unavailable", code: loaded.reason };

  const selected = questionFromBoard(loaded.state, input);
  if (!selected.ok) return { kind: "unavailable", code: selected.code };

  if (!("plan" in selected)) return { kind: "not_requested", reason: selected.reason };

  const assigned = handoffFromBoard(loaded.state, selected.evidence, selected.plan);
  if (!assigned.ok) return { kind: "unavailable", code: assigned.code };

  if (assigned.jobId !== undefined) return jobOutcome(loaded.state, assigned.jobId, selected.evidence.reportVersionId);

  const queued = await enqueueToolLearningPlan(input.boardRoot, selected.plan);
  if (!queued.ok) return { kind: "unavailable", code: queued.code };

  const saved = await withBoardWriter(input.boardRoot, async store => {
    const current = await store.load();
    if (!current.ok) return pipelineFailure(current.reason, current.detail);

    const fresh = questionFromBoard(current.state, input);
    if (!fresh.ok) return fresh;

    if (!("plan" in fresh) || toolLearningJobId(fresh.plan) !== queued.jobId || planForJob(current.state, queued.jobId) === undefined) {
      return pipelineFailure("production_check_handoff_changed", "the exact failed check or learning parent changed before handoff");
    }

    const prior = handoffFromBoard(current.state, fresh.evidence, fresh.plan);
    if (!prior.ok) return prior;

    return savePipelineAsset(store, { versionId: handoffVersion(fresh.evidence.reportVersionId), kind: "workflow", source: "inferred",
      scope: fresh.plan.scope, issuedAt: fresh.plan.createdAt, observations: [fresh.evidence.reportVersionId],
      content: { type: "tool_production_check_learning_handoff", schemaVersion: 1,
        reportVersionId: fresh.evidence.reportVersionId, productionVersionId: fresh.evidence.productionVersionId,
        checkJobId: fresh.evidence.checkJobId, parentVersionId: fresh.evidence.parentVersionId,
        questionKey: questionKey(fresh.evidence), jobId: queued.jobId, scope: fresh.plan.scope } });
  });
  if (!saved.ok) return { kind: "unavailable", code: "reason" in saved ? saved.reason : saved.code };

  return queued.state === "queued" || queued.state === "waiting_evidence"
    ? { kind: "queued", jobId: queued.jobId, reportVersionId: selected.evidence.reportVersionId }
    : { kind: "not_requested", reason: "already_scheduled" };
}

function questionFromBoard(state: BoardState, input: Omit<Input, "boardRoot">): PipelineFailure | {
  readonly ok: true; readonly reason: "no_failed_check" | "unclassified" | "blocked" | "unsupported_parent";
} | { readonly ok: true; readonly plan: ToolLearningPlan; readonly evidence: ToolProductionFailureEvidence } {
  const selected = toolProductionCheckFailureFromBoard(state, input);
  if (!selected.ok) return selected;

  if (selected.evidence === undefined || selected.parent === undefined || selected.occurredAt === undefined) {
    return { ok: true, reason: selected.reason === "implementation_mismatch" ? "unclassified" : selected.reason };
  }

  // One immutable plan/contract and failure class is one investigation question.
  // The earliest committed report fixes identity even when two handoffs race.
  let anchor = { evidence: selected.evidence, parent: selected.parent, occurredAt: selected.occurredAt };

  for (const asset of state.assets) {
    if (!recordOf(asset.content) || asset.content.type !== "tool_production_check_report"
      || asset.content.versionId !== input.versionId || typeof asset.content.jobId !== "string") continue;

    const candidate = toolProductionCheckFailureFromBoard(state, { ...input, jobId: asset.content.jobId });
    if (candidate.ok && candidate.evidence !== undefined && candidate.parent !== undefined && candidate.occurredAt !== undefined
      && questionKey(candidate.evidence) === questionKey(selected.evidence)) {
      anchor = { evidence: candidate.evidence, parent: candidate.parent, occurredAt: candidate.occurredAt };
      break;
    }
  }

  const evidence = anchor.evidence, parent = anchor.parent;
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: parent.scope, capability: parent.capability,
    targetVersionId: parent.versionId, createdAt: anchor.occurredAt, trigger: { runId: evidence.checkJobId,
      proposalKey: `production-check:${questionKey(evidence)}`, action: "heavy_upgrade", tool: parent.identity,
      evidenceRefs: [evidence.reportVersionId, evidence.productionVersionId, parent.versionId] } };

  return { ok: true, plan, evidence: selected.evidence };
}

function questionKey(evidence: ToolProductionFailureEvidence): string {
  return contentHashOf({ productionVersionId: evidence.productionVersionId, parentVersionId: evidence.parentVersionId,
    checksHash: evidence.checksHash, stage: evidence.stage, caseSet: evidence.caseSet });
}

function handoffVersion(reportVersionId: string): string { return `tool-production-check-handoff_v1_${contentHashOf(reportVersionId)}`; }

function handoffFromBoard(state: BoardState, evidence: ToolProductionFailureEvidence, plan: ToolLearningPlan): PipelineFailure | { readonly ok: true; readonly jobId?: string } {
  const asset = state.assets.find(item => item.versionId === handoffVersion(evidence.reportVersionId));
  if (asset === undefined) return { ok: true };

  const raw = asset.content, jobId = toolLearningJobId(plan);
  if (!assetAvailable(state, asset) || asset.kind !== "workflow" || asset.scope !== plan.scope || !recordOf(raw)
    || !keysAre(raw, ["type", "schemaVersion", "reportVersionId", "productionVersionId", "checkJobId", "parentVersionId", "questionKey", "jobId", "scope"])
    || raw.type !== "tool_production_check_learning_handoff" || raw.schemaVersion !== 1 || raw.reportVersionId !== evidence.reportVersionId
    || raw.productionVersionId !== evidence.productionVersionId || raw.checkJobId !== evidence.checkJobId || raw.parentVersionId !== evidence.parentVersionId
    || raw.questionKey !== questionKey(evidence) || raw.scope !== plan.scope || raw.jobId !== jobId || planForJob(state, jobId) === undefined) {
    return pipelineFailure("invalid_production_check_handoff", "the immutable report-to-investigation relation is unavailable");
  }

  return { ok: true, jobId };
}

function jobOutcome(state: BoardState, jobId: string, reportVersionId: string): ProductionCheckLearningHandoff {
  const job = state.jobs.find(item => item.jobId === jobId);
  return job?.state === "queued" || job?.state === "waiting_evidence" ? { kind: "queued", jobId, reportVersionId }
    : { kind: "not_requested", reason: "already_scheduled" };
}

/** Bounded replay repairs a lost enqueue/handoff commit after restart. It never
 * reruns the checker, and unchanged diagnostics cannot create another job. */
export async function resumeToolProductionCheckLearning(boardRoot: string, workspaceId: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const reports = loaded.state.assets.filter(asset => asset.kind === "workflow" && recordOf(asset.content) && asset.content.type === "tool_production_check_report");
  if (reports.length > 768) return pipelineFailure("production_check_history_limit", "production recovery requires bounded archive maintenance");

  const jobIds = new Set<string>(), failures: { readonly reportVersionId: string; readonly code: string }[] = [];
  let processed = 0;

  for (const asset of reports) {
    const raw = asset.content;
    if (!recordOf(raw) || typeof raw.versionId !== "string" || typeof raw.jobId !== "string") continue;

    const production = loaded.state.assets.find(item => item.versionId === raw.versionId);
    if (!recordOf(production?.content) || production.content.workspaceId !== workspaceId) continue;

    const input = { boardRoot, versionId: raw.versionId, workspaceId, jobId: raw.jobId };
    const selected = questionFromBoard(loaded.state, input);
    if (!selected.ok) {
      failures.push({ reportVersionId: asset.versionId, code: selected.code });
      continue;
    }

    if (!("plan" in selected)) continue;

    const assigned = handoffFromBoard(loaded.state, selected.evidence, selected.plan);
    if (!assigned.ok) {
      failures.push({ reportVersionId: asset.versionId, code: assigned.code });
      continue;
    }

    if (assigned.jobId !== undefined) {
      const outcome = jobOutcome(loaded.state, assigned.jobId, asset.versionId);
      if (outcome.kind === "queued") jobIds.add(outcome.jobId);
      continue;
    }

    if (processed++ >= 16) return { ok: true as const, jobIds: [...jobIds], failures, truncated: true };

    const scheduled = await scheduleToolProductionCheckLearning(input);
    if (scheduled.kind === "queued") jobIds.add(scheduled.jobId);
    else if (scheduled.kind === "unavailable") failures.push({ reportVersionId: asset.versionId, code: scheduled.code });
  }

  return { ok: true as const, jobIds: [...jobIds], failures, truncated: false };
}
