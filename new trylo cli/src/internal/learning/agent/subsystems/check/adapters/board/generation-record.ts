import { contentHashOf } from "../../../../../control/hash.js";
import { validateCheckEvaluation } from "../../domain/v2/evaluate.js";
import { parseLearnedChecker, parseCheckInput } from "../../domain/v2/parse.js";
import { keysAre, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import { checkerExposureFingerprints } from "../../domain/v2/exposure.js";
import { checkerExperienceHasSharedOracle } from "../../runtime/v2/feedback.js";
import { checkerExposureHistory } from "../../runtime/v2/exposure.js";
import { checkerMaterialHasCredentials } from "../../runtime/v2/privacy.js";
import type { CheckerCatalog, CheckerGeneration, CheckerGenerationStart, CheckerGenerationEvaluation } from "../../runtime/v2/contracts.js";

export function decodeGenerationStart(raw: Record<string, unknown>, catalog: CheckerCatalog): CheckerGenerationStart | undefined {
  if (!keysAre(raw, ["schemaVersion", "type", "requestId", "jobId", "scope", "ownerId", "attempt", "requirementRef", "requirementDigest",
    "promptDigest", "exposedInputs", "experienceRefs", "tokenReserve", "maxOutputTokens"])
    || ![raw.requestId, raw.jobId, raw.scope, raw.ownerId, raw.requirementRef].every(value => textOf(value, 512))
    || !digest(raw.requirementDigest) || !digest(raw.promptDigest) || !digests(raw.exposedInputs)
    || !Array.isArray(raw.experienceRefs) || raw.experienceRefs.length === 0 || raw.experienceRefs.length > 16
    || !integer(raw.attempt, 1, 3) || !integer(raw.tokenReserve, 1, 262144) || !integer(raw.maxOutputTokens, 1, 8192)
    || raw.maxOutputTokens > raw.tokenReserve) return undefined;

  const lease = catalog.leases.find(item => item.jobId === raw.jobId);
  if (lease === undefined || lease.scope !== raw.scope || lease.ownerId !== raw.ownerId || raw.attempt > lease.allowance.modelCalls
    || raw.requestId !== lease.jobId + ":generation:" + raw.attempt
    || catalog.generationStarts.filter(item => item.jobId === raw.jobId).length !== raw.attempt - 1
    || !raw.experienceRefs.every(ref => catalog.experiences.some(item => item.versionId === ref && item.value.scope === raw.scope
      && item.value.requirements.ref === raw.requirementRef && item.value.requirements.digest === raw.requirementDigest))) return undefined;

  const earlier = catalog.generations.filter(item => item.jobId === raw.jobId);
  if (earlier.length !== raw.attempt - 1 || earlier.reduce((sum, item) => sum + item.chargedTokens, 0) + raw.tokenReserve > lease.allowance.tokens) return undefined;

  return structuredClone(raw) as CheckerGenerationStart;
}

export function decodeGeneration(raw: Record<string, unknown>, catalog: CheckerCatalog): CheckerGeneration | undefined {
  if (!keysAre(raw, ["schemaVersion", "type", "requestId", "jobId", "scope", "model", "usage", "chargedTokens", "usageStatus", "outcome", "reason", "output"],
    ["candidate"])
    || ![raw.requestId, raw.jobId, raw.scope, raw.model, raw.reason].every(value => textOf(value, 512))
    || !recordOf(raw.usage) || !keysAre(raw.usage, ["inputTokens", "outputTokens"])
    || !integer(raw.usage.inputTokens, 0, Number.MAX_SAFE_INTEGER) || !integer(raw.usage.outputTokens, 0, Number.MAX_SAFE_INTEGER)
    || (raw.usageStatus !== "reported" && raw.usageStatus !== "unknown")
    || !integer(raw.chargedTokens, 0, 262144) || !["generated", "no_change", "rejected", "failed", "cancelled"].includes(String(raw.outcome))
    || !validOutput(raw.output)) return undefined;

  const started = catalog.generationStarts.find(item => item.requestId === raw.requestId);
  if (started === undefined || started.jobId !== raw.jobId || started.scope !== raw.scope || raw.chargedTokens > started.tokenReserve
    || (raw.usageStatus === "reported" && raw.chargedTokens !== Math.min(raw.usage.inputTokens + raw.usage.outputTokens, started.tokenReserve))
    || (raw.usageStatus === "unknown" && (raw.chargedTokens !== started.tokenReserve || raw.usage.inputTokens !== 0 || raw.usage.outputTokens !== 0))
    || (raw.outcome === "generated") !== (raw.candidate !== undefined)) return undefined;

  const candidate = raw.candidate === undefined ? undefined : parseLearnedChecker(raw.candidate);
  if (candidate !== undefined && (!candidate.ok || candidate.value.applicability.scope !== started.scope
    || candidate.value.applicability.requirementRef !== started.requirementRef || candidate.value.applicability.requirementDigest !== started.requirementDigest)) return undefined;

  return structuredClone(raw) as CheckerGeneration;
}

export function decodeGenerationEvaluation(raw: Record<string, unknown>, catalog: CheckerCatalog): CheckerGenerationEvaluation | undefined {
  if (!keysAre(raw, ["schemaVersion", "type", "requestId", "jobId", "scope", "candidate", "evaluation", "validationSamples"])) return undefined;

  const generated = catalog.generations.find(item => item.requestId === raw.requestId);
  const candidate = parseLearnedChecker(raw.candidate);
  if (generated === undefined || generated.jobId !== raw.jobId || generated.scope !== raw.scope || generated.candidate === undefined
    || !candidate.ok || contentHashOf(candidate.value) !== contentHashOf(generated.candidate)) return undefined;

  const applicability = candidate.value.applicability;
  const exposed = checkerExposureHistory(catalog, applicability.scope, applicability.requirementRef, applicability.requirementDigest);
  if (!validateCheckEvaluation(raw.evaluation, raw.validationSamples, candidate.value)
    || !Array.isArray(raw.validationSamples) || !raw.validationSamples.every(sample => authenticSample(sample, catalog))
    || raw.validationSamples.some(sample => !unseenHoldout(sample, exposed))) return undefined;

  return structuredClone(raw) as CheckerGenerationEvaluation;
}

function unseenHoldout(sample: unknown, exposed: ReadonlySet<string>): boolean {
  if (!recordOf(sample) || sample.role !== "holdout") return true;
  const input = parseCheckInput(sample.input);
  if (!input.ok) return false;
  return !checkerExposureFingerprints(input.value).some(fingerprint => exposed.has(fingerprint));
}

function authenticSample(sample: unknown, catalog: CheckerCatalog): boolean {
  if (!recordOf(sample) || !recordOf(sample.oracle)) return false;
  return catalog.experiences.some(item => {
    const experience = item.value, assessment = experience.assessment;
    if (assessment === undefined || !checkerExperienceHasSharedOracle(catalog, experience)) return false;
    const expected = assessment.verdict === "valid" ? "pass" : assessment.verdict === "invalid" ? "fail" : "not_applicable";
    return sample.id === experience.id && contentHashOf(sample.input) === contentHashOf(experience.facts) && sample.expected === expected
      && recordOf(sample.oracle) && sample.oracle.kind === assessment.kind && sample.oracle.sourceRef === assessment.sourceRef
      && sample.oracle.requirementDigest === experience.requirements.digest;
  });
}

function validOutput(raw: unknown): boolean {
  if (!recordOf(raw)) return false;
  if (raw.kind === "none") return keysAre(raw, ["kind"]);
  if (raw.kind === "withheld") return keysAre(raw, ["kind", "digest", "reason"]) && digest(raw.digest)
    && (raw.reason === "credential_shape" || raw.reason === "output_capacity");
  return raw.kind === "public" && keysAre(raw, ["kind", "text", "digest"]) && typeof raw.text === "string"
    && new TextEncoder().encode(raw.text).length <= 65536 && contentHashOf(raw.text) === raw.digest && !checkerMaterialHasCredentials(raw.text);
}

function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }

function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

function digests(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length <= 2048 && new Set(value).size === value.length && value.every(digest); }
