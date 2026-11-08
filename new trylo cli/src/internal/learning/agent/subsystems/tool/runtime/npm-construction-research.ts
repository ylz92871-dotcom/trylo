import { contentHashOf } from "../../../../control/hash.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { readNpmLearningArtifact, saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { pipelineFailure } from "./pipeline-assets.js";

function boundary(input: NpmAdaptationInput, contractId: string, focus: string) {
  const content = { type: "tool_npm_construction_research_closed", schemaVersion: 1, subjectId: input.admission.jobId,
    contractId, focus, reason: "no_new_source" };
  return { content, versionId: `npm-construction-research-closed_v1_${contentHashOf(content)}` };
}

/** A duplicate read stays known after restart, but a genuinely new implementation
 * can investigate its own source. This record grants no calls or source authority. */
export async function readNpmConstructionResearchBoundary(input: NpmAdaptationInput, contractId: string, focus: string) {
  const selected = boundary(input, contractId, focus), stored = await readNpmLearningArtifact(input.boardRoot, selected.versionId, input.plan.scope);
  if (!stored.ok) return stored;
  if (stored.content !== undefined && contentHashOf(stored.content) !== contentHashOf(selected.content)) {
    return pipelineFailure("invalid_npm_construction_research_boundary", "The committed investigation boundary does not identify this exact source state");
  }
  return { ok: true as const, closed: stored.content !== undefined };
}

export function closeNpmConstructionResearch(input: NpmAdaptationInput, contractId: string, focus: string) {
  return saveNpmLearningArtifact({ ...input, scope: input.plan.scope, ...boundary(input, contractId, focus), issuedAt: new Date(input.now()).toISOString() });
}
