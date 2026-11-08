import type { BoardState } from "../../learning/control/state.js";
import type { readCentralRuntimeCompletedIndex } from "../../learning/central/runtime/records.js";
import { readRuntimeAgentOriginalWork } from "./runtime-agent-execution-frame.js";
import { readCentralStageDispatchEvidence } from "./stage-dispatch-evidence.js";
import { createOrganizationStageProductionReader } from "./organization-feedback-production.js";

export type OrganizationCompletedRow = ReturnType<typeof readCentralRuntimeCompletedIndex>[number];

export interface OrganizationProductionProof {
  readonly inputHash: string; readonly outputs: readonly string[]; readonly anchors: readonly string[];
}

/** The verified Board prefix supplies operations; original native owners and
 * immutable stage receipts prove their outputs at the exact archived input.
 * Discovery creates no invocation, publication or replacement receipt. */
export async function readOrganizationProductionEvidence(board: BoardState, input: {
  readonly boardRoot: string; readonly scope: string; readonly workspaceId: string; readonly check: () => void;
  readonly wantedReferences: ReadonlySet<string>;
}, completed: readonly OrganizationCompletedRow[]): Promise<ReadonlyMap<string, OrganizationProductionProof>> {
  const proofs = new Map<string, OrganizationProductionProof>();

  if (input.wantedReferences.size === 0) return proofs;

  const grants = new Map((board.centralLearningGrants ?? []).filter(grant => grant.scope === input.scope).map(grant => [grant.grantId, grant]));
  const projectStage = createOrganizationStageProductionReader(board, { scope: input.scope, workspaceId: input.workspaceId });

  for (const row of completed) {
    input.check();

    if (row.work === undefined || row.completed.operation.kind !== "dispatch") continue;

    let original: Awaited<ReturnType<typeof readRuntimeAgentOriginalWork>>;

    try { original = await readRuntimeAgentOriginalWork(row.work, input.scope, input.boardRoot); }
    catch { continue; } // An invalid archived frame establishes no production.

    const grant = grants.get(original.input.grantId);
    if (grant === undefined || grant.issueId !== original.input.issueId) continue;

    if (![row.completed.operation.operationId, row.work.workRef, original.input.issueId, original.input.grantId,
      original.input.stageRef, original.input.sourceBindingRef, ...row.completed.operation.sourceRefs, ...row.completed.resultRefs]
      .some(ref => input.wantedReferences.has(ref))) continue;

    const stage = projectStage({ input: original.input, resultRefs: row.completed.resultRefs });
    const inputHash = original.inputHash, returned = new Set(row.completed.resultRefs);

    if (stage.status === "supported") {
      proofs.set(row.completed.operation.operationId, { inputHash, outputs: stage.outputs.filter(ref => returned.has(ref)),
        anchors: stage.anchors });
      continue;
    }

    const owner = original.input.offer.owner;
    if (owner.plane !== "agent" || owner.domain !== "workflow" && owner.domain !== "collaboration") continue;

    const receipt = await readCentralStageDispatchEvidence({ boardRoot: input.boardRoot, scope: input.scope, domain: owner.domain }, original.input);

    input.check();

    if (receipt.status !== "ready" || !receipt.dispatch.ok || receipt.dispatch.workAttempted !== true
      || receipt.dispatch.status !== "completed" || receipt.dispatch.result?.kind !== "completed"
      || receipt.dispatch.issueId !== undefined && receipt.dispatch.issueId !== original.input.issueId
      || receipt.dispatch.grantId !== undefined && receipt.dispatch.grantId !== original.input.grantId
      || receipt.dispatch.jobId !== undefined && receipt.dispatch.jobId !== grant.jobId) continue;

    proofs.set(row.completed.operation.operationId, { inputHash,
      outputs: receipt.dispatch.result.resultRefs.filter(ref => returned.has(ref)),
      anchors: [original.input.stageRef, original.input.sourceBindingRef, row.work.workRef] });
  }

  return proofs;
}
