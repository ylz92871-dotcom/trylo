import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolLearningContext } from "../domain/evolution/learning-plan.js";
import { exactPureProductionLearningParents } from "./pure-production-regression.js";
import { revisedPureProductionChecks } from "./pure-production-checks.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";

/** The complete independent oracle never enters the model context. A source
 * sample already disclosed as training may be reviewed against its exact parent. */
export function pureProductionPlanningParents(state: BoardState, plan: ToolLearningPlan) {
  const sources = exactPureProductionLearningParents(state, plan);
  if (!sources.ok) return sources;

  const parents: NonNullable<ToolLearningContext["pureProductionParents"]>[number][] = [];

  for (const parent of sources.parents) {
    const artifact = toolLearningParentFromBoard(state, parent.artifactVersionId);
    if (!artifact.ok) return artifact;

    if (artifact.parent.kind !== "generated") continue;

    const disclosed = new Set(artifact.parent.artifact.request.evidence.map(sample => contentHashOf(sample.input)));
    const sourceSamples = parent.plan.checks.evidence.filter(sample => sample.role === "source" && disclosed.has(contentHashOf(sample.input)));
    const revised = revisedPureProductionChecks(state, parent.versionId, parent.plan);
    if (!revised.ok) return revised;

    parents.push({ versionId: parent.versionId, artifactVersionId: parent.artifactVersionId, contentHash: parent.contentHash,
      checksHash: parent.checksHash, parentContractHash: contentHashOf(parent.plan.checks.evidence), sourceSamples, approvedRevisionRefs: revised.revisionRefs,
      sourceAnchors: sourceSamples.map(sample => ({ sampleId: sample.sampleId, sampleHash: contentHashOf(sample), expectedHash: contentHashOf(sample.expected) })),
      approvedSourceCorrections: revised.revisions.flatMap(revision => revision.proposal.corrections.filter(correction =>
        sourceSamples.some(sample => sample.sampleId === correction.sampleId)).map(correction => ({ revisionId: revision.revisionId,
          sampleId: correction.sampleId, expected: correction.expected }))) });
  }

  return { ok: true as const, parents };
}
