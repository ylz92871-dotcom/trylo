import { contentHashOf } from "../../../../../control/hash.js";
import { parseLearnedChecker, validateCheckerGrounding } from "../../domain/v2/parse.js";
import type { CheckExperience } from "../../domain/v2/contracts.js";
import { checkerMaterialHasCredentials } from "./privacy.js";
import { failure, saveCheckerRecord } from "../../adapters/board/store.js";
import type { CheckerEngineOptions, CheckerGeneration, CheckerGenerationStart } from "./contracts.js";

type GenerationContext = { readonly started: CheckerGenerationStart; readonly prompt: string; readonly experiences: readonly CheckExperience[];
  readonly feedbackRefs: readonly string[]; readonly parentVersionId: string | undefined };

/** Persist both sides of a provider boundary; an unfinished reservation is never safe to retry after restart. */
export async function generateCheckerAttempt(options: CheckerEngineOptions, context: GenerationContext, signal: AbortSignal) {
  const saved = await saveCheckerRecord(options.boardRoot, context.started, new Date(options.now()).toISOString());
  if (!saved.ok) return saved;

  let generated: Awaited<ReturnType<CheckerEngineOptions["generator"]["generate"]>>;

  try {
    generated = await options.generator.generate({ requestId: context.started.requestId, prompt: context.prompt,
      maxOutputTokens: context.started.maxOutputTokens, signal });
  } catch {
    // Transport failure can happen after the provider consumed its entire reservation.
    return persistGeneration(options, context.started, { model: "unknown", usage: { inputTokens: 0, outputTokens: 0 },
      chargedTokens: context.started.tokenReserve, usageStatus: "unknown", output: { kind: "none" }, outcome: signal.aborted ? "cancelled" : "failed",
      reason: signal.aborted ? "cancelled" : "learning_adapter_unavailable" });
  }

  if (!validUsage(generated.usage)) return persistGeneration(options, context.started, { model: "unknown",
    usage: { inputTokens: 0, outputTokens: 0 }, chargedTokens: context.started.tokenReserve, usageStatus: "unknown", output: { kind: "none" },
    outcome: "failed", reason: "invalid_provider_usage" });

  const actualTokens = generated.usage.inputTokens + generated.usage.outputTokens;
  const common = { model: safeIdentity(generated.model), usage: generated.usage, usageStatus: "reported" as const,
    chargedTokens: Math.min(actualTokens, context.started.tokenReserve) };

  if (options.collection() === "disabled") return persistGeneration(options, context.started,
    { ...common, output: { kind: "none" }, outcome: "cancelled", reason: "collection_disabled" });

  const output = generated.status === "generated" ? qualifyOutput(generated.text) : { kind: "none" as const };

  if (signal.aborted || generated.status === "cancelled") return persistGeneration(options, context.started,
    { ...common, output, outcome: "cancelled", reason: "cancelled" });

  if (actualTokens > context.started.tokenReserve) return persistGeneration(options, context.started,
    { ...common, output, outcome: "failed", reason: "provider_token_overrun" });

  if (generated.status !== "generated") return persistGeneration(options, context.started,
    { ...common, output, outcome: "failed", reason: safeCode(generated.code) });

  if (output.kind !== "public") return persistGeneration(options, context.started,
    { ...common, output, outcome: "rejected", reason: output.kind === "withheld" ? output.reason : "generation_failed" });

  if (isNoChange(generated.text)) return persistGeneration(options, context.started,
    { ...common, output, outcome: "no_change", reason: "model_found_no_grounded_improvement" });

  const parsed = parseLearnedChecker(generated.text);
  if (!parsed.ok) return persistGeneration(options, context.started, { ...common, output, outcome: "rejected", reason: parsed.code });

  const grounded = validateCheckerGrounding(parsed.value, context.experiences, context.feedbackRefs);
  if (!grounded.ok) return persistGeneration(options, context.started, { ...common, output, outcome: "rejected", reason: grounded.code });

  if (grounded.value.parentVersionId !== undefined && grounded.value.parentVersionId !== context.parentVersionId) {
    return persistGeneration(options, context.started, { ...common, output, outcome: "rejected", reason: "checker_parent_mismatch" });
  }

  const candidate = context.parentVersionId === undefined ? grounded.value : { ...grounded.value, parentVersionId: context.parentVersionId };

  return persistGeneration(options, context.started, { ...common, output, outcome: "generated", reason: "grounded_candidate", candidate });
}

async function persistGeneration(options: CheckerEngineOptions, started: CheckerGenerationStart,
  evidence: Omit<CheckerGeneration, "schemaVersion" | "type" | "requestId" | "jobId" | "scope">) {
  const record: CheckerGeneration = { schemaVersion: 2, type: "checker_generation", requestId: started.requestId,
    jobId: started.jobId, scope: started.scope, ...evidence };
  const stored = await saveCheckerRecord(options.boardRoot, record, new Date(options.now()).toISOString());
  return stored.ok ? { ok: true as const, record } : failure(stored.code, stored.message);
}

function qualifyOutput(text: string): CheckerGeneration["output"] {
  const digest = contentHashOf(text);
  if (checkerMaterialHasCredentials(text) || jsonContainsCredentials(text)) return { kind: "withheld", digest, reason: "credential_shape" };
  if (new TextEncoder().encode(text).length > 65536) return { kind: "withheld", digest, reason: "output_capacity" };
  return { kind: "public", digest, text };
}

function jsonContainsCredentials(text: string): boolean {
  try { return checkerMaterialHasCredentials(JSON.parse(text)); }
  catch { return false; } // Non-JSON public output is retained as parse-failure evidence.
}

function isNoChange(text: string): boolean {
  try { const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 3 && "schemaVersion" in value && value.schemaVersion === 2
    && "decision" in value && value.decision === "no_change" && "reason" in value
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 2048; }
  catch { return false; } // Malformed output follows the canonical checker parser.
}

function safeCode(code: string): string { return /^[a-z][a-z0-9_:-]{0,127}$/u.test(code) ? code : "generation_failed"; }

function safeIdentity(value: string): string { return value.length > 0 && value.length <= 512 && !checkerMaterialHasCredentials(value) ? value : "unknown"; }

function validUsage(value: { readonly inputTokens: number; readonly outputTokens: number }): boolean {
  return [value.inputTokens, value.outputTokens].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 262144);
}
