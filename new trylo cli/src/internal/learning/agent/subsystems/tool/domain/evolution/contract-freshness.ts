import { contentHashOf } from "../../../../../control/hash.js";
import { TOOL_EVOLUTION_MAX_SAMPLES, type ToolEvolutionSample } from "./contracts.js";
import { keysAre, recordOf, textOf } from "./parse.js";

/** Host-derived, before implementation. Old disclosed parent/task cases are
 * regression evidence; these two inputs were excluded from that disclosed set. */
export type ToolFreshContractCases = { readonly schemaVersion: 1; readonly parentVersionId?: string;
  readonly baselineInputsHash: string; readonly variationSampleId: string; readonly counterexampleSampleId: string };

type Failure = { readonly ok: false; readonly code: string; readonly message: string };

/** Check before buying a contract call. No old case is evicted to make room. */
export function toolFreshContractCapacity(baseline: readonly ToolEvolutionSample[]): Failure | { readonly ok: true; readonly minimumSamples: number } {
  if (new Set(baseline.map(sample => contentHashOf(sample.input))).size !== baseline.length) {
    return failure("npm_contract_disclosed_input_conflict", "Disclosed inputs must resolve to one canonical regression case before contract design");
  }

  const sourceDeficit = Math.max(0, 2 - baseline.filter(sample => sample.role === "source" && sample.expected.kind === "value").length);
  const minimumSamples = baseline.length + sourceDeficit + 2;

  return minimumSamples > TOOL_EVOLUTION_MAX_SAMPLES
    ? failure("npm_fresh_contract_capacity", "Preserving every disclosed case and a fresh variation/counterexample exceeds the existing sample cap; review the contract instead of dropping cases")
    : { ok: true, minimumSamples };
}

export function freezeToolFreshContractCases(input: { readonly baseline: readonly ToolEvolutionSample[];
  readonly samples: readonly ToolEvolutionSample[]; readonly parentVersionId?: string }): Failure | { readonly ok: true; readonly freshCases: ToolFreshContractCases } {
  const capacity = toolFreshContractCapacity(input.baseline);
  if (!capacity.ok) return capacity;

  if (input.samples.length > TOOL_EVOLUTION_MAX_SAMPLES || new Set(input.samples.map(sample => contentHashOf(sample.input))).size !== input.samples.length) {
    return failure("npm_fresh_contract_inputs_invalid", "Frozen checks must retain bounded unique inputs");
  }

  const known = new Set(input.baseline.map(sample => contentHashOf(sample.input)));
  const fresh = input.samples.filter(sample => !known.has(contentHashOf(sample.input)));
  const variation = fresh.find(sample => sample.role === "variation"), counterexample = fresh.find(sample => sample.role === "counterexample");
  if (variation === undefined || counterexample === undefined) return failure("npm_fresh_contract_required",
    "Freeze a variation and counterexample whose inputs are absent from all disclosed parent/task cases before implementing source");

  return { ok: true, freshCases: { schemaVersion: 1, baselineInputsHash: disclosedInputsHash(input.baseline),
    variationSampleId: variation.sampleId, counterexampleSampleId: counterexample.sampleId,
    ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }) } };
}

export function decodeToolFreshContractCases(raw: unknown): ToolFreshContractCases | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["schemaVersion", "baselineInputsHash", "variationSampleId", "counterexampleSampleId"], ["parentVersionId"])
    || raw.schemaVersion !== 1 || typeof raw.baselineInputsHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.baselineInputsHash)
    || !textOf(raw.variationSampleId, 128) || !textOf(raw.counterexampleSampleId, 128) || raw.variationSampleId === raw.counterexampleSampleId
    || (raw.parentVersionId !== undefined && !textOf(raw.parentVersionId, 160))) return undefined;
  return { schemaVersion: 1, baselineInputsHash: raw.baselineInputsHash, variationSampleId: raw.variationSampleId,
    counterexampleSampleId: raw.counterexampleSampleId, ...(raw.parentVersionId === undefined ? {} : { parentVersionId: raw.parentVersionId }) };
}

/** Validate selected IDs rather than selecting a different pair on replay. */
export function toolFreshContractCasesMatch(fresh: ToolFreshContractCases, input: { readonly baseline: readonly ToolEvolutionSample[];
  readonly samples: readonly ToolEvolutionSample[]; readonly parentVersionId?: string }): boolean {
  if (!toolFreshContractCapacity(input.baseline).ok || input.samples.length > TOOL_EVOLUTION_MAX_SAMPLES
    || new Set(input.samples.map(sample => contentHashOf(sample.input))).size !== input.samples.length
    || fresh.parentVersionId !== input.parentVersionId || fresh.baselineInputsHash !== disclosedInputsHash(input.baseline)) return false;
  const known = new Set(input.baseline.map(sample => contentHashOf(sample.input)));
  return [[fresh.variationSampleId, "variation"], [fresh.counterexampleSampleId, "counterexample"]].every(([id, role]) =>
    input.samples.some(sample => sample.sampleId === id && sample.role === role && !known.has(contentHashOf(sample.input))));
}

function disclosedInputsHash(samples: readonly ToolEvolutionSample[]): string {
  return contentHashOf([...new Set(samples.map(sample => contentHashOf(sample.input)))].sort());
}

function failure(code: string, message: string): Failure { return { ok: false, code, message }; }
