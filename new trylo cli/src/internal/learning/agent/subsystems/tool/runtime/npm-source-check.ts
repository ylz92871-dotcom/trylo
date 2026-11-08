import { contentHashOf } from "../../../../control/hash.js";
import type { JsonValue } from "../../../../../protocol/envelope.js";
import type { ToolEvolutionSample } from "../domain/evolution/contracts.js";
import type { CandidateExecution } from "../domain/evolution/execution.js";
import type { NpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../domain/evolution/parse.js";
import type { NpmAdaptationServices } from "./npm-adaptation-types.js";

export type NpmSourceCheck =
  | { readonly kind: "passed"; readonly interpretation: string }
  | { readonly kind: "blocked"; readonly reason: "execution_unavailable"; readonly interpretation: string;
      readonly executionKind?: Exclude<CandidateExecution["kind"], "value" | "tool_error"> }
  | { readonly kind: "failed"; readonly sampleId: string; readonly input: JsonValue; readonly expected: ToolEvolutionSample["expected"];
      readonly result: JsonValue; readonly interpretation: string };

const PASSED = "Source cases matched; held-out cases, independent production admission and explicit activation remain required";
const BLOCKED = "No execution evidence; preserve the candidate for an explicit production check";
const FAILED = "Frozen source contract failed; this is debugging evidence, not a production verdict";

export function npmSourceExecutionUnavailable(executionKind?: Exclude<CandidateExecution["kind"], "value" | "tool_error">): Extract<NpmSourceCheck, { readonly kind: "blocked" }> {
  return { kind: "blocked", reason: "execution_unavailable", interpretation: BLOCKED, ...(executionKind === undefined ? {} : { executionKind }) };
}

/** Only construction examples are returned to the implementation model. Held-out answers stay private. */
export async function checkNpmSourceImplementation(plan: NpmToolProductionPlan,
  execute: NonNullable<NpmAdaptationServices["execute"]>, signal: AbortSignal): Promise<NpmSourceCheck> {
  for (const sample of plan.checks.evidence.filter(row => row.role === "source")) {
    const result = await execute(plan, sample.input, signal);
    if (result.kind === "unavailable") return npmSourceExecutionUnavailable();

    if (result.kind !== "value" && result.kind !== "tool_error") {
      // Exact overlay preflight failures identify a repairable implementation.
      // Missing broker replies and deadlines do not establish a wrong answer.
      const code = result.kind === "protocol_error" && ["npm_patch_source_mismatch", "npm_adapter_path_conflict"].includes(result.detail) ? result.detail : undefined;
      if (code === undefined) return npmSourceExecutionUnavailable(result.kind);
      return { kind: "failed", sampleId: sample.sampleId, input: sample.input, expected: sample.expected,
        result: { kind: result.kind, code }, interpretation: FAILED };
    }

    const actual = result.kind === "value" ? result : { kind: "error", code: result.code };
    if (contentHashOf(actual) !== contentHashOf(sample.expected)) return { kind: "failed", sampleId: sample.sampleId,
      input: sample.input, expected: sample.expected, result: actual, interpretation: FAILED };
  }
  return { kind: "passed", interpretation: PASSED };
}

export function decodeNpmSourceCheck(raw: unknown, plan: Pick<NpmToolProductionPlan, "checks">): NpmSourceCheck | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || !textOf(raw.interpretation, 512)) return undefined;

  if (raw.kind === "passed" && keysAre(raw, ["kind", "interpretation"])) return { kind: "passed", interpretation: PASSED };

  if (raw.kind === "blocked" && raw.reason === "execution_unavailable" && keysAre(raw, ["kind", "reason", "interpretation"], ["executionKind"])) {
    if (raw.executionKind !== undefined && raw.executionKind !== "unavailable" && raw.executionKind !== "timeout"
      && raw.executionKind !== "protocol_error" && raw.executionKind !== "cancelled") return undefined;
    return npmSourceExecutionUnavailable(raw.executionKind);
  }

  if (raw.kind !== "failed" || !keysAre(raw, ["kind", "sampleId", "expected", "result", "interpretation"], ["input"]) || !isJsonValue(raw.result)) return undefined;

  const sample = plan.checks.evidence.find(row => row.role === "source" && row.sampleId === raw.sampleId);

  return sample !== undefined && contentHashOf(sample.expected) === contentHashOf(raw.expected)
    && (raw.input === undefined || contentHashOf(sample.input) === contentHashOf(raw.input))
    ? { kind: "failed", sampleId: sample.sampleId, input: sample.input, expected: sample.expected, result: raw.result, interpretation: FAILED } : undefined;
}

