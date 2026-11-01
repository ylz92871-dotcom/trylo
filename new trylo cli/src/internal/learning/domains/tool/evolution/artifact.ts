import { canonicalJson, sha256Hex } from "../../../control/hash.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionCandidate, parseToolEvolutionRequest, recordOf } from "./parse.js";
import { TOOL_EVOLUTION_MAX_JSON_DEPTH, TOOL_EVOLUTION_MAX_SAMPLES, type ToolEvolutionCandidate, type ToolEvolutionRequest } from "./contracts.js";
import { hasCompleteSampleCoverage, hasExactSampleCoverage, type ToolEvolutionCheck, type ToolEvolutionVerification } from "./verification.js";

export type ToolEvolutionArtifact = {
  readonly schemaVersion: 1;
  readonly request: ToolEvolutionRequest;
  readonly candidate: ToolEvolutionCandidate;
  readonly verification: ToolEvolutionVerification;
  readonly generatedAt: string;
};

/** Decode persisted/untrusted content before it can become executable input. */
export function decodeToolEvolutionArtifact(value: unknown): ToolEvolutionArtifact | undefined {
  if (!recordOf(value) || !isJsonValue(value, TOOL_EVOLUTION_MAX_JSON_DEPTH + 2) || jsonBytes(value) > 512 * 1024
    || !keysAre(value, ["schemaVersion", "request", "candidate", "verification", "generatedAt"])
    || value.schemaVersion !== 1 || !isIsoTime(value.generatedAt)) return undefined;
  const request = parseToolEvolutionRequest(value.request);
  const candidate = parseToolEvolutionCandidate(JSON.stringify(value.candidate));
  const verification = decodeToolEvolutionVerification(value.verification);
  if (!request.ok || !candidate.ok || verification === undefined || !hasCompleteSampleCoverage(request.value, verification)
    || !verificationBinds(candidate.value, request.value, verification)) return undefined;
  return { schemaVersion: 1, request: request.value, candidate: candidate.value, verification, generatedAt: value.generatedAt };
}

export function decodeToolEvolutionVerification(value: unknown): ToolEvolutionVerification | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["verdict", "candidateHash", "samplesHash", "checks"])
    || !isDigest(value.candidateHash) || !isDigest(value.samplesHash) || !Array.isArray(value.checks)
    || value.checks.length > TOOL_EVOLUTION_MAX_SAMPLES || !value.checks.every(isCheck)
    || (value.verdict !== "pass" && value.verdict !== "fail")) return undefined;
  const allPassed = value.checks.length > 0 && value.checks.every(check => check.outcome === "passed");
  if ((value.verdict === "pass") !== allPassed) return undefined;
  return { verdict: value.verdict, candidateHash: value.candidateHash, samplesHash: value.samplesHash, checks: value.checks };
}

export function verificationBinds(candidate: ToolEvolutionCandidate, request: ToolEvolutionRequest, report: ToolEvolutionVerification): boolean {
  return report.candidateHash === sha256Hex(canonicalJson(candidate)) && report.samplesHash === sha256Hex(canonicalJson(request.evidence))
    && hasExactSampleCoverage(request, report);
}

/** Version identity includes generation provenance, not just the executable bytes. */
export function toolEvolutionVersionId(artifact: ToolEvolutionArtifact): string {
  return `tool-evolution_v1_${sha256Hex(canonicalJson(artifact))}`;
}

export function isToolEvolutionVersionId(versionId: string, artifact: ToolEvolutionArtifact): boolean {
  const legacy = sha256Hex(canonicalJson({ request: artifact.request, candidate: artifact.candidate, verification: artifact.verification }));
  return versionId === toolEvolutionVersionId(artifact) || versionId === `tool-evolution_${legacy}`;
}

export function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isCheck(value: unknown): value is ToolEvolutionCheck {
  return recordOf(value) && keysAre(value, ["sampleId", "role", "outcome", "detail"])
    && typeof value.sampleId === "string" && value.sampleId.trim().length > 0 && value.sampleId.length <= 128
    && (value.role === "source" || value.role === "variation" || value.role === "counterexample")
    && (value.outcome === "passed" || value.outcome === "wrong_result" || value.outcome === "unexpected_error" || value.outcome === "timeout")
    && typeof value.detail === "string" && value.detail.length <= 1000;
}
