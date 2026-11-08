import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { NpmInstallPlan } from "../../../../../tooling/contract/npm-install.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan } from "../adapters/acquisition/npm-install-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolAcquisitionPlanVersion, toolAcquisitionInstalledVersion } from "../domain/evolution/acquisition-identity.js";

export { toolAcquisitionInstalledVersion } from "../domain/evolution/acquisition-identity.js";

import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { toolAcquisitionDecisionFromBoard } from "./acquisition-decision.js";
import type { BoardState } from "../../../../control/state.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";

/** Read the planner's frozen choice, so approval cannot silently follow a later model decision. */
export async function readToolAcquisition(boardRoot: string, jobId: string, scope: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  return toolAcquisitionFromBoard(loaded.state, jobId, scope);
}

export function toolAcquisitionFromBoard(state: BoardState, jobId: string, scope: string) {
  const job = state.jobs.find(item => item.jobId === jobId);
  if (job === undefined || !["waiting_approval", "waiting_evidence"].includes(job.state)) return pipelineFailure("acquisition_request_not_found", jobId);

  const request = toolAcquisitionDecisionFromBoard(state, jobId, scope);
  if (!request.ok) return request;

  if (request.learningPlan.fundingOrigin !== undefined) {
    const origin = toolFundingOriginFromBoard(state, request.learningPlan);
    if (!origin.ok) return origin;
  }

  const { approvalId } = request;
  const frozen = state.assets.find(asset => asset.versionId === toolAcquisitionPlanVersion(approvalId));
  const content = frozen !== undefined && assetAvailable(state, frozen) && frozen.scope === scope && recordOf(frozen.content) ? frozen.content : undefined;
  const installation = content?.type === "tool_acquisition_plan" && content.decisionVersionId === approvalId ? decodeNpmInstallPlan(content.plan) : undefined;
  if (frozen !== undefined && installation === undefined) return pipelineFailure("acquisition_plan_invalid", jobId);

  return { ...request,
    ...(installation === undefined ? {} : { installation }) };
}

export async function saveToolAcquisitionPlan(input: { readonly boardRoot: string; readonly jobId: string; readonly scope: string;
  readonly approvalId: string; readonly plan: NpmInstallPlan; readonly issuedAt: string }) {
  const current = await readToolAcquisition(input.boardRoot, input.jobId, input.scope);
  if (!current.ok) return current;

  if (current.approvalId !== input.approvalId || input.plan.tree.scope !== input.scope || current.decision.candidate.platform !== "npm"
    || input.plan.tree.root.name !== current.decision.candidate.id || input.plan.tree.root.version !== current.decision.candidate.version
    || decodeNpmInstallPlan(input.plan) === undefined) return pipelineFailure("acquisition_plan_mismatch", input.jobId);

  const saved = await withBoardWriter(input.boardRoot, store => savePipelineAsset(store, {
    versionId: toolAcquisitionPlanVersion(input.approvalId), kind: "workflow", scope: input.scope, source: "user_explicit", issuedAt: input.issuedAt,
    content: { type: "tool_acquisition_plan", schemaVersion: 1, jobId: input.jobId, decisionVersionId: input.approvalId, plan: input.plan },
  }));

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

export async function recordToolAcquisitionInstalled(input: { readonly boardRoot: string; readonly jobId: string; readonly scope: string;
  readonly approvalId: string; readonly plan: NpmInstallPlan; readonly grantId: string; readonly issuedAt: string }) {
  const current = await readToolAcquisition(input.boardRoot, input.jobId, input.scope);
  if (!current.ok) return current;

  if (current.approvalId !== input.approvalId || current.installation === undefined
    || npmInstallId(current.installation) !== npmInstallId(input.plan)) return pipelineFailure("acquisition_plan_mismatch", input.jobId);

  const content = { type: "tool_acquisition_installed", schemaVersion: 1, jobId: input.jobId, scope: input.scope,
    decisionVersionId: input.approvalId, installationId: npmInstallId(input.plan), grantId: input.grantId,
    next: "adapt_and_prepare_production", occurredAt: input.issuedAt };
  const versionId = toolAcquisitionInstalledVersion(input.approvalId, content.installationId);
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const prior = loaded.state.assets.find(asset => asset.versionId === versionId);
    if (prior !== undefined) return assetAvailable(loaded.state, prior) && prior.scope === input.scope && recordOf(prior.content)
      && prior.content.type === content.type && prior.content.decisionVersionId === input.approvalId
      && prior.content.installationId === content.installationId && prior.content.grantId === input.grantId
      ? { ok: true as const, versionId } : pipelineFailure("acquisition_receipt_conflict", input.jobId);

    return savePipelineAsset(store, { versionId, kind: "workflow", scope: input.scope, source: "user_explicit", issuedAt: input.issuedAt, content });
  });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

