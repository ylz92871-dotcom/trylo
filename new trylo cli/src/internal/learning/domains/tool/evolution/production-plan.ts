import { contentHashOf } from "../../../control/hash.js";
import type { JsonFunctionToolPackageManifest } from "../../../../tooling/contract/types.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "./contracts.js";
import type { ToolEvolutionArtifact } from "./artifact.js";
import { isDigest, isToolEvolutionVersionId } from "./artifact.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionCandidate, parseToolEvolutionRequest, recordOf, textOf } from "./parse.js";
import { decodeNpmToolProductionPlan, type NpmToolProductionPlan } from "./npm-production-plan.js";

export const TOOL_PRODUCTION_PROFILE = "confined_json_function_v1";
export type ToolProductionLicense = "MIT" | "ISC" | "BSD-2-Clause" | "BSD-3-Clause" | "0BSD";
export function isToolProductionLicense(value: unknown): value is ToolProductionLicense {
  return typeof value === "string" && ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"].includes(value);
}
export type GeneratedToolProductionPlan = {
  readonly type: "tool_production_package";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly origin: { readonly versionId: string; readonly contentHash: string; readonly scope: string; readonly capability: string; readonly trainingInputs: readonly string[] };
  readonly candidate: ToolEvolutionCandidate;
  readonly checks: ToolEvolutionRequest;
  readonly manifest: JsonFunctionToolPackageManifest;
};
export type ToolProductionPlan = GeneratedToolProductionPlan | NpmToolProductionPlan;

/** Board remains the only activation owner; each tool has a separate slot within its workspace. */
export function toolProductionScope(plan: Pick<ToolProductionPlan, "workspaceId" | "candidate">): string {
  return `tool-production:v1:${contentHashOf({ workspaceId: plan.workspaceId, identity: plan.candidate.identity })}`;
}
export function toolProductionVersion(plan: ToolProductionPlan): string { return `tool-production_v1_${contentHashOf(plan)}`; }
export function isToolProductionVersion(value: unknown): value is string { return typeof value === "string" && /^tool-production_v1_[a-f0-9]{64}$/.test(value); }

/** Only a caller-frozen, independently supplied check request can create a production plan. */
export function createToolProductionPlan(input: {
  readonly workspaceId: string; readonly originVersionId: string; readonly artifact: ToolEvolutionArtifact;
  readonly checks: ToolEvolutionRequest; readonly license: ToolProductionLicense;
}) {
  if (!isToolEvolutionVersionId(input.originVersionId, input.artifact)) return failure("invalid_origin_version");
  const plan: GeneratedToolProductionPlan = { type: "tool_production_package", schemaVersion: 1, workspaceId: input.workspaceId,
    origin: { versionId: input.originVersionId, contentHash: contentHashOf({ type: "tool_evolution_candidate", ...input.artifact }),
      scope: input.artifact.request.scope, capability: input.artifact.request.capability,
      trainingInputs: [...new Set(input.artifact.request.evidence.map(sample => contentHashOf(sample.input)))].sort() },
    candidate: input.artifact.candidate, checks: input.checks, manifest: scriptManifest(input.artifact.candidate.identity, input.artifact.request.capability, input.license) };
  const decoded = decodeToolProductionPlan(plan);
  return decoded === undefined || decoded.type !== "tool_production_package" ? failure("invalid_production_plan") : { ok: true as const, plan: decoded, versionId: toolProductionVersion(decoded), scope: toolProductionScope(decoded) };
}

/** A persisted plan is data, never a verdict, activation or executable grant. */
export function decodeToolProductionPlan(raw: unknown): ToolProductionPlan | undefined {
  if (recordOf(raw) && raw.type === "npm_tool_production_package") return decodeNpmToolProductionPlan(raw);
  if (!isJsonValue(raw, 24) || !recordOf(raw) || jsonBytes(raw) > 512 * 1024
    || !keysAre(raw, ["type", "schemaVersion", "workspaceId", "origin", "candidate", "checks", "manifest"])
    || raw.type !== "tool_production_package" || raw.schemaVersion !== 1 || !textOf(raw.workspaceId, 512)
    || !recordOf(raw.origin) || !keysAre(raw.origin, ["versionId", "contentHash", "scope", "capability", "trainingInputs"])
    || typeof raw.origin.versionId !== "string" || !/^tool-evolution(?:_v1)?_[a-f0-9]{64}$/.test(raw.origin.versionId)
    || !isDigest(raw.origin.contentHash) || !textOf(raw.origin.scope, 512) || !textOf(raw.origin.capability, 2048)
    || !Array.isArray(raw.origin.trainingInputs) || raw.origin.trainingInputs.length === 0 || raw.origin.trainingInputs.length > 32
    || !raw.origin.trainingInputs.every(isDigest) || new Set(raw.origin.trainingInputs).size !== raw.origin.trainingInputs.length
    || !recordOf(raw.manifest) || !isToolProductionLicense(raw.manifest.licenseSpdx)) return undefined;
  const candidate = parseToolEvolutionCandidate(JSON.stringify(raw.candidate)), checks = parseToolEvolutionRequest(raw.checks);
  if (!candidate.ok || !checks.ok || checks.value.operation !== "create" || checks.value.prior !== undefined
    || checks.value.scope !== raw.origin.scope || checks.value.capability !== raw.origin.capability) return undefined;
  // Held-out role names alone do not make a sample independent of generation.
  const training = new Set(raw.origin.trainingInputs);
  if (new Set(checks.value.evidence.map(sample => contentHashOf(sample.input))).size !== checks.value.evidence.length
    || checks.value.evidence.some(sample => sample.role !== "source" && training.has(contentHashOf(sample.input)))) return undefined;
  const manifest = scriptManifest(candidate.value.identity, raw.origin.capability, raw.manifest.licenseSpdx);
  if (contentHashOf(raw.manifest) !== contentHashOf(manifest)) return undefined;
  return { type: raw.type, schemaVersion: 1, workspaceId: raw.workspaceId, origin: { versionId: raw.origin.versionId,
    contentHash: raw.origin.contentHash, scope: raw.origin.scope, capability: raw.origin.capability, trainingInputs: [...raw.origin.trainingInputs] },
    candidate: candidate.value, checks: checks.value, manifest };
}

function scriptManifest(identity: string, capability: string, licenseSpdx: ToolProductionLicense): JsonFunctionToolPackageManifest {
  return { runtimeProfile: TOOL_PRODUCTION_PROFILE, moduleFormat: "commonjs", inputTransport: "json", identity, version: "1.0.0", origin: "self_created",
    licenseSpdx, entrypoint: "candidate.cjs", capabilities: [capability], permissions: [], processIsolation: true,
    cwdWhitelist: [], envWhitelist: [], secretsWhitelist: [], healthProbe: true, alwaysLoad: false, shouldDefer: true,
    cancelSupported: true, timeoutMs: 5000, idempotencyKeyRequired: true, sideEffectCommitPoint: "none", stdoutBytes: 65_536,
    stderrBytes: 65_536, resultChars: 32_768, postinstall: "forbidden", thirdPartyTypes: "isolated" };
}
function failure(code: string) { return { ok: false as const, code, message: "production plan must bind the origin, workspace and fresh caller-owned checks" }; }
