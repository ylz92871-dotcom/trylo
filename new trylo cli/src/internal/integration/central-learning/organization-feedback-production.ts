import type { BoardState } from "../../learning/control/state.js";
import type { CentralFundedStage } from "./contracts.js";
import { createCentralMethodResearchProductionReader } from "../../learning/agent/subsystems/method/adapters/central-research-production.js";
import { readCentralToolStageProduction } from "../../learning/agent/subsystems/tool/runtime/central-production.js";

export interface OrganizationStageProduction {
  readonly status: "supported" | "not_supported";
  readonly outputs: readonly string[];
  readonly anchors: readonly string[];
}

const unique = (values: readonly string[]) => [...new Set(values)].sort();

type Options = { readonly scope: string; readonly workspaceId?: string };

type Selection = { readonly input: CentralFundedStage; readonly resultRefs: readonly string[] };

/** One immutable Board read session. Reuse the original Method owner's local
 * history/candidate index across its stages; no cache survives this closure. */
export function createOrganizationStageProductionReader(board: BoardState, options: Options):
  (selection: Selection) => OrganizationStageProduction {
  const method = createCentralMethodResearchProductionReader(board, options);
  return selection => stageProduction(board, { ...options, ...selection }, method);
}

/** Historical native production proof, not current availability or execution
 * permission. The caller authenticates the original work and preserves its
 * complete funded input; reported refs alone never establish production. */
export function projectOrganizationStageProduction(board: BoardState, options: Options & Selection): OrganizationStageProduction {
  return createOrganizationStageProductionReader(board, options)({ input: options.input, resultRefs: options.resultRefs });
}

function stageProduction(board: BoardState, options: Options & Selection,
  method: ReturnType<typeof createCentralMethodResearchProductionReader>): OrganizationStageProduction {
  const { input } = options;
  const empty = (status: OrganizationStageProduction["status"]): OrganizationStageProduction => ({ status, outputs: [], anchors: [] });

  if (input.offer.owner.plane !== "agent") return empty("not_supported");

  const domain = input.offer.owner.domain;
  if (domain !== "prompt" && domain !== "tool") return empty("not_supported");

  const reported = new Set(options.resultRefs);
  const source = { scope: options.scope, input, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) };
  const proof = domain === "prompt" ? method(input)
    : readCentralToolStageProduction(board, source);
  if (proof === undefined) return empty("supported");

  const refs = "publishedVersionRefs" in proof ? proof.publishedVersionRefs : proof.outputs;
  const outputs = unique(refs.filter(ref => reported.has(ref)));
  if (outputs.length === 0) return empty("supported");

  // Returned refs may themselves include input provenance. Only explicit
  // stage-local paid checkpoints and confirmed outputs become anchors;
  // an owner's broad sourceRefs remain background even when returned.
  const stageProof = "checkpointRefs" in proof ? [...proof.checkpointRefs, ...proof.reservationRefs] : [];

  return { status: "supported", outputs, anchors: unique([input.issueId, input.grantId, input.stageRef, input.sourceBindingRef,
    ...stageProof, ...outputs]) };
}
