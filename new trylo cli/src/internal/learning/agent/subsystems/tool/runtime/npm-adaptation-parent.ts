import { contentHashOf } from "../../../../control/hash.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { npmLearningPrior } from "../adapters/acquisition/npm-learning-prior.js";

/** Shared contract identity; npm-specific installation logic still uses input.parent. */
export function npmAdaptationParent(input: Pick<NpmAdaptationInput, "parent" | "predecessor">) {
  if (input.parent !== undefined) return { versionId: input.parent.versionId, checks: input.parent.plan.checks,
    capability: input.parent.plan.origin.capability, feedback: input.parent.feedback };
  return input.predecessor;
}

export function npmAdaptationPrior(input: Pick<NpmAdaptationInput, "parent" | "predecessor">) {
  if (input.parent !== undefined || input.predecessor === undefined) return npmLearningPrior(input.parent?.plan);
  const previous = input.predecessor, sourcePath = "trylo_previous/adapter.cjs";
  return { files: [{ path: sourcePath, body: Buffer.from(previous.source) }], summary: {
    descriptor: previous.descriptor, runtime: { profile: "confined_json_function_v1", sourcePath, sourceContentHash: contentHashOf(previous.source) }, patches: [] } };
}

export function npmAdaptationEvolution(input: NpmAdaptationInput) {
  const parent = input.parent, predecessor = input.predecessor;
  if (parent === undefined && predecessor === undefined) return undefined;
  return { parentVersionId: parent?.versionId ?? predecessor!.versionId,
    parentContentHash: parent === undefined ? predecessor!.contentHash : contentHashOf(parent.plan),
    requestId: `${input.admission.jobId}:${input.admission.attempt}`, adaptation: input.adaptation,
    ...(input.acquisition === undefined ? {} : { acquisition: input.acquisition }) };
}
