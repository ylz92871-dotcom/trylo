import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { NpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { decodeNpmLearningContract } from "../domain/evolution/npm-learning.js";
import { assetAvailable } from "./pipeline-assets.js";
import { toolFreshContractCasesMatch } from "../domain/evolution/contract-freshness.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { decodeToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import { recordOf } from "../domain/evolution/parse.js";

/** The learning origin is a recovery coordinate, never a verification verdict or activation grant. */
export function validNpmLearningOrigin(state: BoardState, plan: NpmToolProductionPlan): boolean {
  if (plan.learning === undefined) return true;

  const origin = plan.learning, job = state.jobs.find(row => row.jobId === origin.jobId);
  const asset = state.assets.find(row => row.versionId === origin.contractId);
  const contract = asset === undefined ? undefined : decodeNpmLearningContract(asset.content);
  const bound = job?.domain === "tool" && job.scope === plan.origin.scope && job.attempt >= origin.attempt
    && asset?.kind === "workflow" && asset.scope === plan.origin.scope && assetAvailable(state, asset)
    && contract?.subjectId === origin.jobId && contract.installationId === plan.origin.versionId
    && contentHashOf(contract.checks) === contentHashOf(plan.checks);
  if (!bound || contract === undefined) return false;

  // Existing committed contracts remain readable. New host metadata must prove
  // its disclosed boundary against both the snapshot and exact parent bytes.
  if (contract.freshCases === undefined) return true;

  const basis = contract.frozenBasis;
  if (basis === undefined || basis.parentVersionId !== plan.evolution?.parentVersionId) return false;

  if (!toolFreshContractCasesMatch(contract.freshCases, { baseline: basis.grounding.samples.map(row => row.sample),
    samples: contract.checks.evidence, ...(basis.parentVersionId === undefined ? {} : { parentVersionId: basis.parentVersionId }) })) return false;

  if (basis.parentVersionId === undefined) return true;

  const parent = state.assets.find(row => row.versionId === basis.parentVersionId);
  if (parent?.kind !== "tool_package" || parent.contentHash !== contentHashOf(parent.content)
    || parent.contentHash !== plan.evolution?.parentContentHash) return false;

  const production = decodeToolProductionPlan(parent.content);
  const artifact = production === undefined && recordOf(parent.content) && parent.content.type === "tool_evolution_candidate"
    ? decodeToolEvolutionArtifact(Object.fromEntries(Object.entries(parent.content).filter(([key]) => key !== "type"))) : undefined;
  const samples = production?.checks.evidence ?? artifact?.request.evidence;
  if (samples === undefined) return false;

  const disclosed = new Set(basis.grounding.samples.map(row => contentHashOf(row.sample.input)));

  return samples.every(sample => disclosed.has(contentHashOf(sample.input)));
}
