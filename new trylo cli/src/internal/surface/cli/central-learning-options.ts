import type { CentralLearningAllowance } from "../../learning/control/coordination-contract.js";
import { isCentralLearningAllowance } from "../../learning/control/coordination-parse.js";
import { isCentralThoughtMaxTokens } from "../../learning/central/runtime/validation.js";

/** Explicit total-model resource ceiling for one persistent workspace pool. It is
 * neither a per-turn refill nor Permission to execute or activate an asset. */
export type CentralLearningOption = CentralLearningAllowance;

export function readCentralLearningOption(values: ReadonlyMap<string, string>):
  { readonly ok: true; readonly value?: CentralLearningOption; readonly thoughtMaxTokens?: number } | { readonly ok: false; readonly message: string } {
  const tokens = values.get("central-learning-budget"), calls = values.get("central-learning-calls");
  const prompt = values.get("central-learning-prompt-chars"), thought = values.get("central-learning-thought-tokens");
  if (tokens === undefined && calls === undefined && prompt === undefined && thought === undefined) return { ok: true };

  if (tokens === undefined || calls === undefined || !/^\d+$/.test(tokens) || !/^\d+$/.test(calls)
    || prompt !== undefined && !/^\d+$/.test(prompt)) {
    return { ok: false, message: "central learning requires --central-learning-budget and --central-learning-calls as positive integers" };
  }

  const value: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: Number(tokens),
    maxCalls: Number(calls), maxSteps: Number(calls), maxPromptChars: prompt === undefined ? 100_000 : Number(prompt) };

  if (thought !== undefined && (!/^\d+$/.test(thought) || !isCentralThoughtMaxTokens(Number(thought)))) {
    return { ok: false, message: "central thought tokens must be a positive safe integer in 1..1000000000" };
  }

  return isCentralLearningAllowance(value) ? { ok: true, value, ...(thought === undefined ? {} : { thoughtMaxTokens: Number(thought) }) }
    : { ok: false, message: "central learning requires tokens 1..1000000000, calls 1..64 and prompt chars 0..1000000000" };
}
