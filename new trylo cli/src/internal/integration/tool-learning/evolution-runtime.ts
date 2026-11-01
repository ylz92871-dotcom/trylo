import type { ToolRunnerPort } from "../../ports/tool-runner-port.js";
import type { ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import { TOOL_EVOLUTION_DEFAULT_GENERATION_MS, TOOL_EVOLUTION_MAX_GENERATION_MS } from "../../learning/domains/tool/evolution/contracts.js";
import { parseToolEvolutionCandidate, parseToolEvolutionRequest } from "../../learning/domains/tool/evolution/parse.js";
import { evolutionPrompt } from "../../learning/domains/tool/evolution/prompt.js";
import type { ToolEvolutionVerification, ToolEvolutionVerifier } from "../../learning/domains/tool/evolution/verification.js";
import { hasCompleteSampleCoverage } from "../../learning/domains/tool/evolution/verification.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";
export type { ToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";

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
};

/** The worker proposes; the execution adapter checks; only the existing Board archives assets. */
export function createToolEvolutionRuntime(options: ToolEvolutionRuntimeOptions) {
  const timeoutMs = options.timeoutMs ?? TOOL_EVOLUTION_DEFAULT_GENERATION_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > TOOL_EVOLUTION_MAX_GENERATION_MS) {
    throw new Error("generation timeout must be an integer in 1..300000 ms");
  }
  return {
    async evolve(raw: unknown, signal: AbortSignal): Promise<ToolEvolutionOutcome> {
      const parsed = parseToolEvolutionRequest(raw);
      if (!parsed.ok) return { kind: "failed", code: parsed.code, message: parsed.message, attempts: 0 };
      const request = parsed.value;
      let failure: string | undefined = options.initialFeedback;
      let last: ToolEvolutionVerification | undefined;
      let rejectionCode: string | undefined;
      const limit = request.maxAttempts ?? 1;
      for (let attempt = 1; attempt <= limit; attempt += 1) {
        if (signal.aborted) return { kind: "cancelled", attempts: attempt - 1 };
        const generated = await generate({ ...options, timeoutMs }, request, attempt, signal, failure);
        if (generated.kind === "cancelled") return { kind: "cancelled", attempts: attempt };
        if (generated.kind === "failed") return { ...generated, attempts: attempt };
        const candidate = parseToolEvolutionCandidate(generated.text);
        if (!candidate.ok) {
          failure = `${candidate.code}: ${candidate.message}`;
          rejectionCode = candidate.code;
          continue;
        }
        const verified = await invokePort(() => options.verifier.verify(candidate.value, request, signal));
        if (!verified.ok) return { kind: "failed", code: "verification_unavailable", message: verified.message, attempts: attempt };
        last = verified.value;
        if (last.verdict === "cancelled" || signal.aborted) return { kind: "cancelled", attempts: attempt };
        if (last.verdict === "unavailable") return { kind: "failed", code: "verification_unavailable", message: "candidate was not accepted because its execution checks could not run", attempts: attempt, verification: last };
        const expectedHash = sha256Hex(canonicalJson(candidate.value));
        const expectedSamples = sha256Hex(canonicalJson(request.evidence));
        if (last.candidateHash !== expectedHash || last.samplesHash !== expectedSamples) {
          return { kind: "failed", code: "verification_binding_mismatch", message: "verification did not cover these exact candidate bytes and samples", attempts: attempt };
        }
        if (!hasCompleteSampleCoverage(request, last)) {
          rejectionCode = "sample_checks_failed";
          failure = last.checks.filter(check => check.outcome !== "passed").map(check => `${check.sampleId}: ${check.outcome}: ${check.detail}`).join("\n") || "verification did not cover each sample identity and role exactly once";
          continue;
        }
        const artifact: ToolEvolutionArtifact = { schemaVersion: 1, request, candidate: candidate.value, verification: last, generatedAt: new Date(options.now()).toISOString() };
        const archived = await invokePort(() => options.archive.save(artifact));
        if (!archived.ok) return { kind: "failed", code: "archive_unavailable", message: archived.message, attempts: attempt, verification: last };
        const saved = archived.value;
        if (!saved.ok) return { kind: "failed", code: saved.code, message: saved.message, attempts: attempt, verification: last };
        return { kind: "candidate", ...saved, artifact, attempts: attempt };
      }
      return { kind: "failed", code: "candidate_rejected", message: failure ?? "no candidate passed the caller-owned sample checks", attempts: limit,
        ...(rejectionCode === undefined ? {} : { rejectionCode }), ...(last === undefined ? {} : { verification: last }) };
    },
  };
}

/** External ports have outcome contracts; a thrown implementation failure must not fake completion. */
async function invokePort<T>(run: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}

type Generated = { readonly kind: "text"; readonly text: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | { readonly kind: "cancelled" };

async function generate(options: ToolEvolutionRuntimeOptions, request: ToolEvolutionRequest, attempt: number, signal: AbortSignal, failure?: string): Promise<Generated> {
  const taskId = `tool-evolution-${sha256Hex(canonicalJson(request)).slice(0, 20)}-${options.now()}-${attempt}`;
  let submitted = false;
  let cancellation: Promise<Awaited<ReturnType<typeof invokePort<boolean>>>> | undefined;
  const cancel = (): void => { cancellation = invokePort(() => options.runner.cancel(taskId, "tool evolution cancelled")); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) return { kind: "cancelled" };
    await options.runner.submit({ taskId, name: "tool-evolution-generate", input: { prompt: evolutionPrompt(request, failure) }, timeoutMs: options.timeoutMs ?? TOOL_EVOLUTION_DEFAULT_GENERATION_MS });
    submitted = true;
    if (signal.aborted) { await options.runner.cancel(taskId, "tool evolution cancelled"); return { kind: "cancelled" }; }
    const result = await options.runner.wait(taskId, options.timeoutMs ?? TOOL_EVOLUTION_DEFAULT_GENERATION_MS);
    if (result.observed === "timeout") {
      await options.runner.cancel(taskId, "tool evolution observation deadline");
      return { kind: "failed", code: "generation_timeout", message: "background generation exceeded its observation deadline and was cancelled" };
    }
    if (result.status === "cancelled" || signal.aborted) return { kind: "cancelled" };
    if (result.status !== "completed" || typeof result.output !== "string") {
      return { kind: "failed", code: result.error?.code ?? "generation_failed", message: result.error?.message ?? "background worker did not return candidate text" };
    }
    return { kind: "text", text: result.output };
  } catch (error) {
    if (submitted) await options.runner.cancel(taskId, "tool evolution worker failure");
    return signal.aborted ? { kind: "cancelled" } : { kind: "failed", code: "generation_failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    signal.removeEventListener("abort", cancel);
    // A listener cannot throw into AbortController or leave a rejected promise unobserved.
    // Await the captured outcome here; synchronous cleanup failures are handled by the caller above.
    if (cancellation !== undefined) await cancellation;
  }
}
