import type { ToolRunnerPort } from "../../../../../ports/tool-runner-port.js";
import type { ToolEvolutionRequest, ToolEvolutionCandidate, ToolEvolutionRequirement } from "../domain/evolution/contracts.js";
import { parseToolEvolutionCandidate, parseToolEvolutionRequest } from "../domain/evolution/parse.js";
import type { ToolEvolutionVerification, ToolEvolutionVerifier } from "../domain/evolution/verification.js";
import { hasCompleteSampleCoverage } from "../domain/evolution/verification.js";
import { canonicalJson, sha256Hex } from "../../../../control/hash.js";
import type { ToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import { generateToolEvolutionCandidate, toolEvolutionSourceState, type ToolEvolutionGenerationAllowance } from "./evolution-source-generation.js";
import { invokeToolEvolutionPort as invokePort } from "./evolution-generation-transport.js";

export type { ToolEvolutionArtifact } from "../domain/evolution/artifact.js";

export type ToolEvolutionArchive = {
  save(artifact: ToolEvolutionArtifact): Promise<{ readonly ok: true; readonly proposalId: string; readonly versionId: string }
    | { readonly ok: false; readonly code: string; readonly message: string }>;
};

export type ToolEvolutionOutcome =
  | { readonly kind: "candidate"; readonly proposalId: string; readonly versionId: string; readonly artifact: ToolEvolutionArtifact; readonly attempts: number }
  | { readonly kind: "failed"; readonly code: string; readonly message: string; readonly attempts: number; readonly verification?: ToolEvolutionVerification; readonly rejectionCode?: string }
  | { readonly kind: "cancelled"; readonly attempts: number };

export type ToolEvolutionRuntimeOptions = {
  readonly runner: ToolRunnerPort;
  readonly verifier: ToolEvolutionVerifier;
  readonly archive: ToolEvolutionArchive;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly initialFeedback?: string;
  readonly requirements?: readonly ToolEvolutionRequirement[];
  /** Read the already-bound original grant; never issue or refresh resources here. */
  readonly generationAllowance?: () => Promise<ToolEvolutionGenerationAllowance | undefined>;
};

/** The worker proposes; the execution adapter checks; only the existing Board archives assets. */
export function createToolEvolutionRuntime(options: ToolEvolutionRuntimeOptions) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("an explicit generation timeout must be a positive integer");
  }
  return {
    async evolve(raw: unknown, signal: AbortSignal): Promise<ToolEvolutionOutcome> {
      const parsed = parseToolEvolutionRequest(raw);
      if (!parsed.ok) return { kind: "failed", code: parsed.code, message: parsed.message, attempts: 0 };

      const request = parsed.value;
      const sourceState = toolEvolutionSourceState(request, options.generationAllowance !== undefined);
      let failure: string | undefined = options.initialFeedback;
      let last: ToolEvolutionVerification | undefined;
      let rejectionCode: string | undefined;
      const limit = request.maxAttempts ?? 1;

      for (let attempt = 1; attempt <= limit; attempt += 1) {
        if (signal.aborted) return { kind: "cancelled", attempts: attempt - 1 };

        const generated = await generateToolEvolutionCandidate(options, request, attempt, sourceState, signal, failure);
        if (generated.kind === "cancelled") return { kind: "cancelled", attempts: attempt };

        if (generated.kind === "failed") return { ...generated, attempts: attempt };

        const candidate = parseToolEvolutionCandidate(generated.text, request.prior?.source);
        if (!candidate.ok) {
          failure = `${candidate.code}: ${candidate.message}`;
          rejectionCode = candidate.code;
          continue;
        }

        const accepted = await acceptToolEvolutionCandidate(options, request, candidate.value, signal, attempt);
        if (accepted.kind === "failed" && accepted.code === "sample_checks_failed") {
          rejectionCode = accepted.code;
          failure = accepted.message;
          last = accepted.verification;
          continue;
        }

        return accepted;
      }

      return { kind: "failed", code: "candidate_rejected", message: failure ?? "no candidate passed the caller-owned sample checks", attempts: limit,
        ...(rejectionCode === undefined ? {} : { rejectionCode }), ...(last === undefined ? {} : { verification: last }) };
    },
  };
}

/** Generated and statically composed tools share the same verification and immutable archival boundary. */
export async function acceptToolEvolutionCandidate(options: Pick<ToolEvolutionRuntimeOptions, "verifier" | "archive" | "now">,
  request: ToolEvolutionRequest, candidate: ToolEvolutionCandidate, signal: AbortSignal, attempts: number): Promise<ToolEvolutionOutcome> {
  if (signal.aborted) return { kind: "cancelled", attempts };

  const verified = await invokePort(() => options.verifier.verify(candidate, request, signal));
  if (!verified.ok) return { kind: "failed", code: "verification_unavailable", message: verified.message, attempts };

  const report = verified.value;
  if (report.verdict === "cancelled" || signal.aborted) return { kind: "cancelled", attempts };

  if (report.verdict === "unavailable") return { kind: "failed", code: "verification_unavailable", message: "candidate execution checks could not run", attempts, verification: report };

  if (report.candidateHash !== sha256Hex(canonicalJson(candidate)) || report.samplesHash !== sha256Hex(canonicalJson(request.evidence))) {
    return { kind: "failed", code: "verification_binding_mismatch", message: "verification did not cover these exact candidate bytes and samples", attempts };
  }

  if (!hasCompleteSampleCoverage(request, report)) return { kind: "failed", code: "sample_checks_failed", attempts, verification: report,
    message: report.checks.filter(check => check.outcome !== "passed").map(check => `${check.sampleId}: ${check.outcome}: ${check.detail}`).join("\n") || "verification did not cover each sample identity and role exactly once" };

  const artifact: ToolEvolutionArtifact = { schemaVersion: 1, request, candidate, verification: report, generatedAt: new Date(options.now()).toISOString() };
  const archived = await invokePort(() => options.archive.save(artifact));
  if (!archived.ok) return { kind: "failed", code: "archive_unavailable", message: archived.message, attempts, verification: report };

  if (!archived.value.ok) return { kind: "failed", code: archived.value.code, message: archived.value.message, attempts, verification: report };

  return { kind: "candidate", ...archived.value, artifact, attempts };
}

