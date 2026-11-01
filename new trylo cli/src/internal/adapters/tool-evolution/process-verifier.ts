import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ToolEvolutionSample } from "../../learning/domains/tool/evolution/contracts.js";
import type { CandidateExecution } from "../../learning/domains/tool/evolution/execution.js";
import type { ToolEvolutionCheck, ToolEvolutionVerification, ToolEvolutionVerifier } from "../../learning/domains/tool/evolution/verification.js";
import { createToolCandidateExecutor, type ProcessToolExecutorOptions } from "./process-executor.js";

export type ProcessToolVerifierOptions = ProcessToolExecutorOptions;

/** Expected answers remain with the checker; the shared executor sees input only. */
export function createToolEvolutionVerifier(options: ProcessToolVerifierOptions): ToolEvolutionVerifier {
  const executor = createToolCandidateExecutor(options);
  return {
    async verify(candidate, request, signal) {
      const candidateHash = sha256Hex(canonicalJson(candidate));
      const samplesHash = sha256Hex(canonicalJson(request.evidence));
      const checks: ToolEvolutionCheck[] = [];
      const report = (verdict: ToolEvolutionVerification["verdict"]): ToolEvolutionVerification => ({ verdict, candidateHash, samplesHash, checks });
      if (signal.aborted) return report("cancelled");
      if (request.evidence.length === 0 || request.evidence.some(sample => sample.sampleId.trim().length === 0)
        || new Set(request.evidence.map(sample => sample.sampleId)).size !== request.evidence.length) return report("fail");
      for (const sample of request.evidence) {
        const check = checkResult(sample, await executor.execute(candidate, sample.input, signal));
        checks.push(check);
        if (check.outcome === "cancelled") return report("cancelled");
        if (check.outcome === "execution_unavailable") return report("unavailable");
      }
      return report(checks.every(check => check.outcome === "passed") ? "pass" : "fail");
    },
  };
}

function checkResult(sample: ToolEvolutionSample, result: CandidateExecution): ToolEvolutionCheck {
  const checked = (outcome: ToolEvolutionCheck["outcome"], detail: string): ToolEvolutionCheck => ({ sampleId: sample.sampleId, role: sample.role, outcome, detail });
  if (result.kind === "cancelled") return checked("cancelled", "verification cancelled");
  if (result.kind === "unavailable") return checked("execution_unavailable", result.detail);
  if (result.kind === "timeout") return checked("timeout", result.detail);
  if (result.kind === "protocol_error") return checked("unexpected_error", result.detail);
  const actual = result.kind === "value" ? result : { kind: "error", code: result.code };
  return canonicalJson(actual) === canonicalJson(sample.expected)
    ? checked("passed", "fresh confined process matched expectation")
    : checked("wrong_result", "actual result differs from the caller-owned expectation");
}
