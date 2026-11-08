import type { ToolEvolutionRequest, ToolEvolutionSample } from "./contracts.js";
import { canonicalJson, contentHashOf } from "../../../../../control/hash.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionRequest, parseToolEvolutionSample, recordOf, textOf } from "./parse.js";
import { decodeToolFreshContractCases, toolFreshContractCasesMatch, type ToolFreshContractCases } from "./contract-freshness.js";

export const NPM_LEARNING_CONTRACT_MAX_BYTES = 262_144;

export type NpmLearningGrounding = {
  readonly requirements: readonly { readonly ref: string; readonly text: string }[];
  readonly samples: readonly { readonly ref: string; readonly sample: ToolEvolutionSample; readonly aliases?: readonly string[] }[];
};

export type NpmContractResearchBoundary = { readonly kind: "open" }
  | { readonly kind: "contract_only"; readonly reason: "reserved_calls" | "no_new_source" | "research_limit" };

export type NpmLearningContract = {
  readonly type: "tool_npm_learning_contract"; readonly schemaVersion: 1;
  readonly subjectId: string; readonly installationId: string; readonly groundingHash: string;
  readonly checks: ToolEvolutionRequest;
  readonly origins: readonly { readonly sampleId: string; readonly kind: "observed" | "contract" | "synthesized"; readonly ref: string }[];
  /** Host-only provenance with disclosed regressions and current reserved checks. */
  readonly frozenBasis?: { readonly parentVersionId?: string; readonly adaptationHash: string; readonly grounding: NpmLearningGrounding };
  readonly revisionOf?: string;
  readonly freshCases?: ToolFreshContractCases;
};

export function isNpmLearningContractId(raw: unknown): raw is string {
  return typeof raw === "string" && /^npm-contract(?:-revised)?_v1_[a-f0-9]{64}$/.test(raw);
}

/** Expected answers are frozen before asking for implementation. Synthetic answers remain hypotheses. */
export function decodeNpmLearningContract(raw: unknown): NpmLearningContract | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > NPM_LEARNING_CONTRACT_MAX_BYTES
    || !keysAre(raw, ["type", "schemaVersion", "subjectId", "installationId", "groundingHash", "checks", "origins"], ["frozenBasis", "revisionOf", "freshCases"])
    || raw.type !== "tool_npm_learning_contract" || raw.schemaVersion !== 1 || !textOf(raw.subjectId, 160)
    || !textOf(raw.installationId, 160) || typeof raw.groundingHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.groundingHash)
    || !Array.isArray(raw.origins)) return undefined;

  const checks = parseToolEvolutionRequest(raw.checks);
  if (!checks.ok || checks.value.operation !== "create" || checks.value.prior !== undefined || checks.value.composition !== undefined
    || raw.origins.length !== checks.value.evidence.length) return undefined;

  const origins: NpmLearningContract["origins"][number][] = [];

  for (const row of raw.origins) {
    if (!recordOf(row) || !keysAre(row, ["sampleId", "kind", "ref"]) || !textOf(row.sampleId, 128) || !textOf(row.ref, 512)
      || !["observed", "contract", "synthesized"].includes(String(row.kind)) || origins.some(item => item.sampleId === row.sampleId)
      || !checks.value.evidence.some(sample => sample.sampleId === row.sampleId)) return undefined;
    origins.push({ sampleId: row.sampleId, kind: row.kind as NpmLearningContract["origins"][number]["kind"], ref: row.ref });
  }

  let frozenBasis: NpmLearningContract["frozenBasis"];
  if (raw.frozenBasis !== undefined) {
    const basis = raw.frozenBasis;
    if (!recordOf(basis) || !keysAre(basis, ["adaptationHash", "grounding"], ["parentVersionId"])
      || typeof basis.adaptationHash !== "string" || !/^[a-f0-9]{64}$/.test(basis.adaptationHash)
      || (basis.parentVersionId !== undefined && !textOf(basis.parentVersionId, 160))) return undefined;

    const grounding = decodeNpmLearningGrounding(basis.grounding);
    if (grounding === undefined) return undefined;

    frozenBasis = { adaptationHash: basis.adaptationHash, grounding,
      ...(basis.parentVersionId === undefined ? {} : { parentVersionId: basis.parentVersionId }) };
  }

  if (raw.revisionOf !== undefined && (!isNpmLearningContractId(raw.revisionOf) || frozenBasis === undefined)) return undefined;

  const freshCases = raw.freshCases === undefined ? undefined : decodeToolFreshContractCases(raw.freshCases);
  if (raw.freshCases !== undefined && (freshCases === undefined || frozenBasis === undefined || !toolFreshContractCasesMatch(freshCases,
    { baseline: frozenBasis.grounding.samples.map(row => row.sample), samples: checks.value.evidence,
      ...(frozenBasis.parentVersionId === undefined ? {} : { parentVersionId: frozenBasis.parentVersionId }) }))) return undefined;

  const contract: NpmLearningContract = { type: raw.type, schemaVersion: 1, subjectId: raw.subjectId, installationId: raw.installationId,
    groundingHash: raw.groundingHash, checks: checks.value, origins,
    ...(frozenBasis === undefined ? {} : { frozenBasis }), ...(raw.revisionOf === undefined ? {} : { revisionOf: raw.revisionOf }),
    ...(freshCases === undefined ? {} : { freshCases }) };

  return frozenBasis === undefined || npmContractGrounded(contract, frozenBasis.grounding) ? contract : undefined;
}

export function decodeNpmLearningGrounding(raw: unknown): NpmLearningGrounding | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["requirements", "samples"]) || !Array.isArray(raw.requirements) || raw.requirements.length > 64
    || !Array.isArray(raw.samples) || raw.samples.length > 64) return undefined;

  const requirements: NpmLearningGrounding["requirements"][number][] = [], samples: NpmLearningGrounding["samples"][number][] = [];

  for (const row of raw.requirements) {
    if (!recordOf(row) || !keysAre(row, ["ref", "text"]) || !textOf(row.ref, 512) || !textOf(row.text, 8192)) return undefined;
    requirements.push({ ref: row.ref, text: row.text });
  }

  for (const row of raw.samples) {
    if (!recordOf(row) || !keysAre(row, ["ref", "sample"], ["aliases"]) || !textOf(row.ref, 512)
      || (row.aliases !== undefined && (!Array.isArray(row.aliases) || row.aliases.length > 16 || new Set(row.aliases).size !== row.aliases.length
        || row.aliases.some(ref => !textOf(ref, 512) || ref === row.ref)))) return undefined;
    const sample = parseToolEvolutionSample(row.sample);
    if (!sample.ok) return undefined;
    samples.push({ ref: row.ref, sample: sample.value, ...(row.aliases === undefined ? {} : { aliases: [...row.aliases] }) });
  }

  return { requirements, samples };
}

export function npmContractGrounded(contract: NpmLearningContract, grounding: NpmLearningGrounding): boolean {
  if (contract.groundingHash !== contentHashOf(grounding)) return false;

  for (const origin of contract.origins) {
    if (origin.kind === "synthesized") {
      if (!grounding.requirements.some(requirement => requirement.ref === origin.ref)) return false;
    } else {
      const trusted = grounding.samples.find(row => (row.ref === origin.ref || row.aliases?.includes(origin.ref)) && row.sample.sampleId === origin.sampleId);
      const proposed = contract.checks.evidence.find(row => row.sampleId === origin.sampleId);
      if (trusted === undefined || canonicalJson(trusted.sample) !== canonicalJson(proposed)) return false;
    }
  }

  // Improvement keeps every previous case, including negative cases; new cases may extend it.
  return grounding.samples.every(row => contract.checks.evidence.some(sample => canonicalJson(sample) === canonicalJson(row.sample)));
}

export type NpmSourceRead = { readonly action: "read"; readonly paths: readonly string[]; readonly offset?: number };

export function decodeNpmSourceRead(raw: unknown): NpmSourceRead | undefined {
  return recordOf(raw) && keysAre(raw, ["action", "paths"], ["offset"]) && raw.action === "read" && Array.isArray(raw.paths)
    && raw.paths.length > 0 && raw.paths.length <= 8 && new Set(raw.paths).size === raw.paths.length
    && raw.paths.every(item => textOf(item, 512)) && (raw.offset === undefined || (typeof raw.offset === "number"
      && Number.isSafeInteger(raw.offset) && raw.offset >= 0 && raw.offset <= 2_000_000))
    ? { action: "read", paths: raw.paths, ...(raw.offset === undefined ? {} : { offset: raw.offset }) } : undefined;
}
