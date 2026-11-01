import type { ToolEvolutionCandidate, ToolEvolutionRequest, ToolEvolutionSample } from "./contracts.js";

/** Reports are produced by an execution adapter, never accepted from generated text. */
export type ToolEvolutionCheck = {
  readonly sampleId: string;
  readonly role: ToolEvolutionSample["role"];
  readonly outcome: "passed" | "wrong_result" | "unexpected_error" | "timeout" | "cancelled" | "execution_unavailable";
  readonly detail: string;
};

export type ToolEvolutionVerification = {
  readonly verdict: "pass" | "fail" | "cancelled" | "unavailable";
  readonly candidateHash: string;
  readonly samplesHash: string;
  readonly checks: readonly ToolEvolutionCheck[];
};

export type ToolEvolutionVerifier = {
  verify(candidate: ToolEvolutionCandidate, request: ToolEvolutionRequest, signal: AbortSignal): Promise<ToolEvolutionVerification>;
};

/** Exact identity and role coverage matters: N copies of one passing sample are not N checks. */
export function hasCompleteSampleCoverage(request: ToolEvolutionRequest, report: ToolEvolutionVerification): boolean {
  return report.verdict === "pass" && hasExactSampleCoverage(request, report) && report.checks.every(check => check.outcome === "passed");
}

export function hasExactSampleCoverage(request: ToolEvolutionRequest, report: ToolEvolutionVerification): boolean {
  const ids = new Set(report.checks.map(check => check.sampleId));
  return report.checks.length === request.evidence.length && ids.size === request.evidence.length
    && request.evidence.every(sample => report.checks.some(check => check.sampleId === sample.sampleId
      && check.role === sample.role));
}
