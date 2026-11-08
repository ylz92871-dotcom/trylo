import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createToolProductionPlan, isToolProductionLicense } from "../domain/evolution/production-plan.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { productionFromBoard, saveToolProductionPlan } from "./production-assets.js";
import { pureProductionContractFromBoard } from "./pure-production-contract.js";
import { revisedPureProductionChecks } from "./pure-production-checks.js";

/** A generated child is prepared for the original independent checker and
 * explicit activation. Archiving this plan grants neither verdict nor permission. */
export async function preparePureProductionDescendant(input: { readonly boardRoot: string; readonly versionId: string;
  readonly jobId: string; readonly attempt: number; readonly issuedAt: string }): Promise<PipelineFailure | { readonly ok: true; readonly versionId?: string }> {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const anchored = pureProductionContractFromBoard(loaded.state, `${input.jobId}:${input.attempt}`);
  if (!anchored.ok || anchored.contract === undefined) return anchored;

  const contract = anchored.contract, candidate = candidateFromBoard(loaded.state, input.versionId);
  if (!candidate.ok) return candidate;

  const rawParent = loaded.state.assets.find(row => row.versionId === contract.parent.versionId);
  const workspaceId = typeof rawParent?.content === "object" && rawParent.content !== null && "workspaceId" in rawParent.content
    && typeof rawParent.content.workspaceId === "string" ? rawParent.content.workspaceId : "";
  const parent = productionFromBoard(loaded.state, contract.parent.versionId, workspaceId);
  if (!parent.ok) return parent;

  if (parent.plan.type !== "tool_production_package" || contentHashOf(parent.plan) !== contract.parent.contentHash
    || contentHashOf(parent.plan.checks) !== contract.parent.checksHash || parent.plan.origin.versionId !== contract.parent.artifactVersionId
    || candidate.artifact.request.requestId !== `${input.jobId}:${input.attempt}` || candidate.artifact.request.scope !== contract.scope
    || candidate.artifact.candidate.identity !== parent.plan.candidate.identity || !isToolProductionLicense(parent.plan.manifest.licenseSpdx)) {
    return pipelineFailure("pure_production_contract_mismatch", "the generated candidate must retain its exact host-owned production identity and contract");
  }

  const revised = revisedPureProductionChecks(loaded.state, contract.parent.versionId, parent.plan, contract.revisionRefs ?? []);
  if (!revised.ok) return revised;

  const created = createToolProductionPlan({ workspaceId, originVersionId: input.versionId, artifact: candidate.artifact,
    checks: revised.checks, license: parent.plan.manifest.licenseSpdx });
  if (!created.ok) return created;

  return saveToolProductionPlan(input.boardRoot, created.plan, input.issuedAt, { jobId: input.jobId, attempt: input.attempt });
}
