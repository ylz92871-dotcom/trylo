import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { decodeToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { createToolProductionPlan, decodeToolProductionPlan, isToolProductionLicense, toolProductionScope, toolProductionVersion, type ToolProductionPlan } from "../../learning/domains/tool/evolution/production-plan.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { candidateFromBoard } from "./evolution-reader.js";

export const TOOL_PRODUCTION_VERIFIER = "tool-production-checker-v1";
export const TOOL_PRODUCTION_GENERATOR = "tool-evolution";
export function toolProductionGenerator(plan: ToolProductionPlan): string { return plan.type === "npm_tool_production_package" ? "tool-acquisition" : TOOL_PRODUCTION_GENERATOR; }
export function toolProductionVerifier(plan: ToolProductionPlan): string { return plan.type === "npm_tool_production_package" ? "npm-tool-production-checker-v1" : TOOL_PRODUCTION_VERIFIER; }
export function productionProposalId(versionId: string): string { return `production-proposal:${versionId}`; }

/** Plans request activation authority and can never take the low-risk data fast lane. */
export async function saveToolProductionPlan(boardRoot: string, plan: ToolProductionPlan, issuedAt: string) {
  const result = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const versionId = toolProductionVersion(plan), proposalId = productionProposalId(versionId);
    if (!validLineage(loaded.state, plan)) return pipelineFailure("invalid_production_origin", "plan does not match its archived source lineage");
    if (loaded.state.assets.some(item => item.versionId === versionId)) return productionFromBoard(loaded.state, versionId, plan.workspaceId);
    if (plan.type === "tool_production_package") {
      const origin = candidateFromBoard(loaded.state, plan.origin.versionId);
      if (!origin.ok) return origin;
    }
    if (loaded.state.assets.filter(item => recordOf(item.content) && ["tool_production_package", "npm_tool_production_package"].includes(String(item.content.type))).length >= 256) {
      return pipelineFailure("production_history_limit", "inspect and retain production history before creating further plans");
    }
    const base = { issuedAt }, scope = toolProductionScope(plan);
    const commands: readonly BoardCommand[] = [
      { ...base, type: "submit_proposal", commandId: `${proposalId}:submit`, proposal: { proposalId, scope, domain: "tool", assetKind: "tool_package",
        candidateRef: versionId, hypothesis: "Caller-frozen tool package awaiting independent verification and explicit activation",
        observationRefs: [plan.origin.versionId], risk: "medium", requiredVerifiers: [toolProductionVerifier(plan)], requestedAuthorities: ["tool_activation"], source: "user_explicit" } },
      { ...base, type: "quarantine", commandId: `${proposalId}:quarantine`, proposalId },
      { ...base, type: "start_evaluation", commandId: `${proposalId}:evaluate`, proposalId },
      { ...base, type: "commit_asset", commandId: `${proposalId}:commit`, proposalId, versionId, schemaVersion: 1, content: plan },
    ];
    for (const command of commands) {
      const applied = await store.apply(command);
      if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
    }
    const saved = await store.load();
    return saved.ok ? productionFromBoard(saved.state, versionId, plan.workspaceId) : pipelineFailure(saved.reason, saved.detail);
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

export async function readToolProductionPlan(boardRoot: string, versionId: string, workspaceId: string) {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? productionFromBoard(loaded.state, versionId, workspaceId) : pipelineFailure(loaded.reason, loaded.detail);
}

/** Validate immutable data independently from its lifecycle; inspection also works after withdrawal. */
export function productionFromBoard(state: BoardState, versionId: string, workspaceId: string) {
  const asset = state.assets.find(item => item.versionId === versionId);
  if (asset === undefined) return pipelineFailure("production_not_found", "production version is absent");
  const plan = decodeToolProductionPlan(asset.content), proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  if (plan === undefined || asset.kind !== "tool_package" || asset.schemaVersion !== 1 || asset.contentHash !== contentHashOf(plan)
    || toolProductionVersion(plan) !== versionId || asset.scope !== toolProductionScope(plan) || asset.source !== "user_explicit"
    || proposal?.proposalId !== productionProposalId(versionId) || proposal.scope !== asset.scope || proposal.assetKind !== asset.kind
    || proposal.domain !== "tool" || proposal.candidateRef !== versionId || proposal.risk !== "medium" || proposal.source !== asset.source
    || contentHashOf(proposal.requiredVerifiers) !== contentHashOf([toolProductionVerifier(plan)])
    || contentHashOf(proposal.requestedAuthorities) !== contentHashOf(["tool_activation"]) || !validLineage(state, plan)) {
    return pipelineFailure("invalid_production_asset", "production data failed immutable source, manifest, proposal or scope checks");
  }
  if (plan.workspaceId !== workspaceId) return pipelineFailure("production_workspace_mismatch", "tool belongs to another workspace");
  if (state.tombstones.some(item => item.entityId === versionId || item.entityId === proposal.proposalId)) return pipelineFailure("production_unavailable", "production asset was removed");
  return { ok: true as const, versionId, proposalId: proposal.proposalId, plan, lifecycle: proposal.lifecycle };
}

function validLineage(state: BoardState, plan: ToolProductionPlan): boolean {
  const decoded = decodeToolProductionPlan(plan);
  if (plan.type === "npm_tool_production_package") return decoded !== undefined && contentHashOf(decoded) === contentHashOf(plan);
  const origin = state.assets.find(item => item.versionId === plan.origin.versionId);
  if (decoded === undefined || origin?.kind !== "tool_package" || !recordOf(origin.content) || origin.content.type !== "tool_evolution_candidate"
    || origin.contentHash !== contentHashOf(origin.content) || origin.contentHash !== plan.origin.contentHash) return false;
  const { type: _type, ...body } = origin.content;
  const artifact = decodeToolEvolutionArtifact(body);
  if (artifact === undefined || !isToolProductionLicense(plan.manifest.licenseSpdx)) return false;
  const rebuilt = createToolProductionPlan({ artifact, workspaceId: plan.workspaceId, originVersionId: origin.versionId, checks: plan.checks, license: plan.manifest.licenseSpdx });
  return rebuilt.ok && contentHashOf(rebuilt.plan) === contentHashOf(plan);
}
