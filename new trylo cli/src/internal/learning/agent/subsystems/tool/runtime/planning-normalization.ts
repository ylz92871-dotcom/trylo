import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningContext } from "../domain/evolution/learning-plan.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** Model-facing parent references become canonical full-source requests exactly once.
 * Never overwrite a supplied mismatch or resolve a version omitted from the model's context. */
export function normalizeToolPlanningDecision(raw: unknown, context: ToolLearningContext, state: BoardState) {
  if (!recordOf(raw) || raw.action !== "improve" || !recordOf(raw.request) || !recordOf(raw.request.prior)) return { ok: true as const, value: raw };

  const prior = raw.request.prior;
  if (!keysAre(prior, ["versionId"], ["source", "sourceHash"]) || typeof prior.versionId !== "string") return pipelineFailure("planning_parent_mismatch", "improvement requires an exact archived parent reference");

  const offered = context.priorVersions.find(item => item.versionId === prior.versionId);
  if (offered === undefined) return pipelineFailure("planning_parent_mismatch", "the selected parent was not offered in this planning context");

  const selected = toolLearningParentFromBoard(state, prior.versionId);
  if (!selected.ok) return selected;

  if (selected.parent.kind !== "generated" || selected.parent.versionId !== prior.versionId || selected.parent.scope !== context.plan.scope) return pipelineFailure("planning_parent_mismatch", "only the exact readable generated parent can supply source");

  const source = selected.parent.artifact.candidate.source, sourceHash = contentHashOf(source);
  const offeredHash = offered.sourceHash ?? (offered.source === undefined ? undefined : contentHashOf(offered.source));
  if (offeredHash !== sourceHash || (prior.sourceHash !== undefined && prior.sourceHash !== sourceHash)
    || (prior.source !== undefined && prior.source !== source)) return pipelineFailure("planning_parent_mismatch", "a supplied source/hash or offered immutable parent no longer matches");

  return { ok: true as const, value: { ...raw, request: { ...raw.request, prior: { versionId: prior.versionId, source } } } };
}
