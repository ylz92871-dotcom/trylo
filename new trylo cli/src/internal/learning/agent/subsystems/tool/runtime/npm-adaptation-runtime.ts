import path from "node:path";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { readNpmInstall } from "../adapters/acquisition/npm-install-files.js";
import { npmLearningSource } from "../adapters/acquisition/npm-learning-source.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import type { NpmAdaptationInput as Input } from "./npm-adaptation-types.js";
import { prepareNpmLearningContract } from "./npm-adaptation-contract.js";
import { prepareNpmUpstreamBaseline } from "./npm-upstream-baseline.js";
import { constructNpmLearningTool } from "./npm-adaptation-construction.js";
import { npmAdaptationPrior } from "./npm-adaptation-parent.js";
import { npmAdaptationFeedback } from "./npm-adaptation-feedback.js";
import { readToolNpmResearchReferences } from "./installation-research.js";
import { toolLearningJobId } from "../domain/evolution/pipeline.js";

export type { NpmAdaptationServices } from "./npm-adaptation-types.js";

/** Installation, contract design, implementation and admission are separate durable steps. */
export async function prepareNpmToolAdaptation(input: Input): Promise<PipelineFailure | { readonly ok: true; readonly versionId: string; readonly sourceChecked: boolean }> {
  if (input.signal.aborted) return pipelineFailure("cancelled", input.admission.jobId);

  const feedback = await npmAdaptationFeedback(input);
  if (!feedback.ok) return feedback;

  input = feedback.input;
  const references = await readToolNpmResearchReferences(input.boardRoot, input.plan, toolLearningJobId(input.plan), input.installation);
  if (!references.ok) return references;

  input = { ...input, researchReferences: references.references };
  const installationId = npmInstallId(input.installation);
  const installed = await readNpmInstall(path.join(input.installationRoot, installationId), input.installation);
  if (installed === undefined) return pipelineFailure("npm_install_not_found", installationId);

  if (input.parent !== undefined && input.predecessor !== undefined) return pipelineFailure("ambiguous_npm_learning_parent", "A replacement must bind one exact parent");

  const researchFiles = [...installed.files, ...npmAdaptationPrior(input).files];
  const source = npmLearningSource(researchFiles, input.installation.tree.root.location);
  const prepared = await prepareNpmLearningContract(input, source,
    read => npmLearningSource(researchFiles, input.installation.tree.root.location, read.paths, read.offset));
  if (!prepared.ok) return prepared;

  const { contract, versionId: contractId } = prepared;
  const baseline = await prepareNpmUpstreamBaseline(input, contract.checks, contractId);
  if ("ok" in baseline) return baseline;

  return constructNpmLearningTool(input, { files: installed.files, contract, contractId, source,
    ...(baseline.kind === "diagnostic" ? { baselineFeedback: baseline.feedback } : {}) });
}
