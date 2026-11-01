import type { BoardState } from "../../learning/control/state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { toolProductionScope, type ToolProductionPlan } from "../../learning/domains/tool/evolution/production-plan.js";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { checkValidationRecord } from "../../learning/verification-authority/validation-record.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { productionFromBoard } from "./production-assets.js";
import { pipelineFailure } from "./pipeline-assets.js";

type Selected = Extract<ReturnType<typeof productionFromBoard>, { readonly ok: true }>;

/** Additive operator projection; no source code, sample inputs, expected answers or raw tool output. */
export function projectToolProductionSummary(state: BoardState, selected: Selected) {
  const plan = selected.plan, pointer = state.activations.find(row => row.scope === toolProductionScope(plan) && row.assetKind === "tool_package");
  const uses = (state.toolUses ?? []).filter(row => row.versionId === selected.versionId && row.workspaceId === plan.workspaceId);
  const latest = state.jobs.filter(row => row.observationId === selected.proposalId).at(-1);
  const npm = plan.type === "npm_tool_production_package" ? plan.installation.tree.root : undefined;
  return { versionId: selected.versionId, identity: plan.candidate.identity, description: plan.candidate.description, lifecycle: selected.lifecycle,
    profile: plan.manifest.runtimeProfile, packageName: npm?.name ?? plan.candidate.identity, packageVersion: plan.manifest.version, license: plan.manifest.licenseSpdx,
    dependencyCount: plan.type === "npm_tool_production_package" ? plan.installation.packages.length - 1 : 0,
    ...(latest === undefined ? {} : { checkState: latest.state, checkJobId: latest.jobId }),
    ...(pointer === undefined ? {} : { current: { versionId: pointer.versionId, generation: pointer.generation, pointer: pointer.pointer,
      ...(pointer.previousVersionId === undefined ? {} : { previousVersionId: pointer.previousVersionId }) } }),
    uses: { total: uses.length, returned: uses.filter(row => row.execution === "returned").length, quality: "unverified" as const } };
}

export async function readToolProductionList(boardRoot: string, workspaceId: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const candidates = loaded.state.assets.filter(asset => recordOf(asset.content)
    && ["tool_production_package", "npm_tool_production_package"].includes(String(asset.content.type)) && asset.content.workspaceId === workspaceId);
  const items: ReturnType<typeof projectToolProductionSummary>[] = [];
  for (const asset of candidates.slice(-50).reverse()) {
    const selected = productionFromBoard(loaded.state, asset.versionId, workspaceId);
    if (!selected.ok) return selected;
    items.push(projectToolProductionSummary(loaded.state, selected));
  }
  return { ok: true as const, formatVersion: 1 as const, workspaceId, boardSequence: loaded.state.sequence, items, total: candidates.length, truncated: candidates.length > items.length };
}

export function projectToolProductionDetail(state: BoardState, selected: Selected,
  review: { readonly ok: true; readonly reviewId: string; readonly receipt: { readonly receiptId: string } } | { readonly ok: false; readonly code: string }) {
  const plan = selected.plan;
  return { formatVersion: 1 as const, workspaceId: plan.workspaceId, boardSequence: state.sequence, ...projectToolProductionSummary(state, selected),
    capability: plan.origin.capability, mastery: plan.candidate.mastery, source: sourceRows(plan),
    permissions: plan.manifest.permissions, timeoutMs: plan.manifest.timeoutMs,
    review: review.ok ? { status: "available" as const, reviewId: review.reviewId, receiptId: review.receipt.receiptId }
      : { status: "unavailable" as const, code: review.code },
    report: latestReport(state, selected) };
}
function sourceRows(plan: ToolProductionPlan) {
  if (plan.type !== "npm_tool_production_package") return [{ name: plan.candidate.identity, version: plan.manifest.version, license: plan.manifest.licenseSpdx,
    origin: "generated_candidate" as const, sourceVersionId: plan.origin.versionId, contentHash: plan.origin.contentHash }];
  return plan.installation.packages.map(item => ({ name: item.review.name, version: item.review.version, license: item.review.licenseSpdx,
    origin: "reviewed_npm_archive" as const, location: item.location, upstreamUrl: item.review.upstreamUrl,
    sourceRevision: item.review.sourceRevision, archiveSha256: item.review.sha256, licenses: item.review.licenses }));
}
function latestReport(state: BoardState, selected: Selected) {
  const jobs = new Set(state.jobs.filter(row => row.observationId === selected.proposalId).map(row => row.jobId));
  for (const asset of [...state.assets].reverse()) {
    const raw = asset.content;
    if (asset.kind !== "workflow" || asset.contentHash !== contentHashOf(raw) || !recordOf(raw) || raw.type !== "tool_production_check_report"
      || raw.schemaVersion !== 1 || raw.versionId !== selected.versionId || typeof raw.jobId !== "string" || !jobs.has(raw.jobId)
      || asset.scope !== toolProductionScope(selected.plan)) continue;
    const checked = checkValidationRecord(raw.record);
    if (!checked.ok || checked.record.packageVersionId !== selected.versionId) continue;
    return { jobId: raw.jobId, verdict: checked.record.verdict, stages: checked.record.stages };
  }
  return null;
}
