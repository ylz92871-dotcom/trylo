import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { NpmLearningContract, NpmLearningGrounding } from "../domain/evolution/npm-learning.js";
import { keysAre, recordOf, textOf } from "../domain/evolution/parse.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { npmAdaptationParent } from "./npm-adaptation-parent.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** Only new commitments pass here. A model supplies a reference, while the
 * host supplies its real provenance kind; existing committed origins never move. */
export function canonicalNpmContractOrigins(input: NpmAdaptationInput, checks: ToolEvolutionRequest,
  grounding: NpmLearningGrounding, raw: unknown) {
  if (!Array.isArray(raw) || raw.length !== checks.evidence.length) return pipelineFailure("invalid_npm_contract_origins", "Every frozen case needs exactly one bounded source reference");

  const requested = new Map<string, string>();

  for (const origin of raw) {
    if (!recordOf(origin) || !keysAre(origin, ["sampleId", "kind", "ref"]) || !textOf(origin.sampleId, 128) || !textOf(origin.ref, 512)
      || !["observed", "contract", "synthesized"].includes(String(origin.kind)) || requested.has(origin.sampleId)
      || !checks.evidence.some(sample => sample.sampleId === origin.sampleId)) return pipelineFailure("invalid_npm_contract_origins", "Origin identities and references must match the exact frozen case set");
    requested.set(origin.sampleId, origin.ref);
  }

  const parent = npmAdaptationParent(input), external = input.plan.opportunity?.grounding;
  const contractRefs = new Set([...(checks.contractRevisionRefs ?? []), ...(parent?.checks.evidence.map(sample => `${parent.versionId}:${sample.sampleId}`) ?? [])]);
  const origins: NpmLearningContract["origins"][number][] = [];

  for (const sample of checks.evidence) {
    const ref = requested.get(sample.sampleId)!;
    const disclosed = grounding.samples.find(row => row.sample.sampleId === sample.sampleId);
    if (disclosed !== undefined) {
      if (canonicalJson(disclosed.sample) !== canonicalJson(sample) || (disclosed.ref !== ref && !disclosed.aliases?.includes(ref))) {
        return pipelineFailure("npm_contract_origin_mismatch", "A disclosed case must retain its exact sample and an actual canonical or alias reference");
      }

      if (contractRefs.has(ref)) {
        origins.push({ sampleId: sample.sampleId, kind: "contract", ref });
        continue;
      }

      if (external?.reference !== ref || !external.samples.some(fact => contentHashOf(fact.input) === contentHashOf(sample.input)
        && contentHashOf(fact.expected) === contentHashOf(sample.expected))) {
        return pipelineFailure("npm_contract_origin_unbound", "This source reference has no matching disclosed fact in the current host context");
      }

      origins.push({ sampleId: sample.sampleId, kind: external.source === "observed_io" ? "observed" : "contract", ref });
    } else {
      if (!grounding.requirements.some(requirement => requirement.ref === ref)) return pipelineFailure("npm_contract_origin_unbound", "New hypotheses must identify a current requirement; they cannot claim an observed or inherited case reference");
      origins.push({ sampleId: sample.sampleId, kind: "synthesized", ref });
    }
  }

  return { ok: true as const, origins };
}
