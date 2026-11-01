import { contentHashOf } from "../../../control/hash.js";
import { decodeNpmInstallData, npmInstallId, type NpmInstallPlan } from "../../../../tooling/contract/npm-install.js";
import type { ToolRuntimeDescriptor } from "../../../../tooling/contract/descriptor.js";
import type { NodePackageToolManifest } from "../../../../tooling/contract/types.js";
import type { ToolEvolutionRequest } from "./contracts.js";
import { isJsonValue, jsonBytes, keysAre, parseToolRuntimeDescriptor, parseToolEvolutionRequest, recordOf, textOf } from "./parse.js";
import { safePackagePath } from "../../../../tooling/contract/npm-source.js";

export type NpmToolRuntime =
  | { readonly profile: "confined_npm_cli_v1"; readonly bin: string; readonly entrypoint: string }
  | { readonly profile: "confined_npm_mcp_v1"; readonly bin: string; readonly entrypoint: string; readonly toolName: string; readonly protocolVersion: "2025-03-26" | "2024-11-05" };
export type NpmToolProductionPlan = {
  readonly type: "npm_tool_production_package"; readonly schemaVersion: 1; readonly workspaceId: string;
  readonly origin: { readonly versionId: string; readonly contentHash: string; readonly scope: string; readonly capability: string; readonly trainingInputs: readonly string[] };
  readonly candidate: ToolRuntimeDescriptor; readonly checks: ToolEvolutionRequest; readonly manifest: NodePackageToolManifest;
  readonly installation: NpmInstallPlan; readonly runtime: NpmToolRuntime;
};
export const NPM_CLI_INPUT_SCHEMA = { type: "object", properties: { argv: { type: "array", items: { type: "string" }, maxItems: 32 }, stdin: { type: "string", maxLength: 8192 } }, required: ["argv", "stdin"], additionalProperties: false } as const;

export function decodeNpmToolInterface(raw: unknown) {
  if (!isJsonValue(raw) || jsonBytes(raw) > 96 * 1024 || !recordOf(raw) || !keysAre(raw, ["descriptor", "runtime"])
    || !recordOf(raw.descriptor) || !keysAre(raw.descriptor, ["identity", "description", "inputSchema", "mastery"]) || !runtimeShape(raw.runtime)) return undefined;
  const parsed = parseToolRuntimeDescriptor(raw.descriptor);
  if (!parsed.ok) return undefined;
  return { descriptor: parsed.value, runtime: structuredClone(raw.runtime) };
}

/** Installation never infers an interface or its expected answers: callers freeze both explicitly. */
export function createNpmToolProductionPlan(input: { readonly workspaceId: string; readonly installation: NpmInstallPlan;
  readonly descriptor: ToolRuntimeDescriptor; readonly runtime: NpmToolRuntime; readonly checks: ToolEvolutionRequest }) {
  const root = input.installation.packages.find(row => row.location === input.installation.tree.root.location);
  if (root === undefined) return undefined;
  return decodeNpmToolProductionPlan({ type: "npm_tool_production_package", schemaVersion: 1, workspaceId: input.workspaceId,
    origin: { versionId: npmInstallId(input.installation), contentHash: contentHashOf(input.installation), scope: input.installation.tree.scope, capability: input.checks.capability, trainingInputs: [] },
    candidate: input.descriptor, checks: input.checks, runtime: input.runtime, installation: input.installation,
    manifest: npmManifest(input.descriptor.identity, input.checks.capability, input.runtime, root.review.licenseSpdx, root.review.version) });
}

export function decodeNpmToolProductionPlan(raw: unknown): NpmToolProductionPlan | undefined {
  if (!isJsonValue(raw, 48) || jsonBytes(raw) > 3 * 1024 * 1024 || !recordOf(raw)
    || !keysAre(raw, ["type", "schemaVersion", "workspaceId", "origin", "candidate", "checks", "manifest", "installation", "runtime"])
    || raw.type !== "npm_tool_production_package" || raw.schemaVersion !== 1 || !textOf(raw.workspaceId, 512)
    || !recordOf(raw.candidate) || !keysAre(raw.candidate, ["identity", "description", "inputSchema", "mastery"]) || !runtimeShape(raw.runtime)) return undefined;
  const selected = decodeNpmToolInterface({ descriptor: raw.candidate, runtime: raw.runtime });
  const checks = parseToolEvolutionRequest(raw.checks), installation = decodeNpmInstallData(raw.installation);
  if (selected === undefined || !checks.ok || checks.value.operation !== "create" || checks.value.prior !== undefined || installation === undefined
    || checks.value.scope !== installation.tree.scope) return undefined;
  if (new Set(checks.value.evidence.map(row => contentHashOf(row.input))).size !== checks.value.evidence.length) return undefined;
  const candidate = selected.descriptor;
  if (raw.runtime.profile === "confined_npm_cli_v1" && contentHashOf(candidate.inputSchema) !== contentHashOf(NPM_CLI_INPUT_SCHEMA)) return undefined;
  const root = installation.packages.find(row => row.location === installation.tree.root.location);
  if (root === undefined) return undefined;
  const origin = { versionId: npmInstallId(installation), contentHash: contentHashOf(installation), scope: installation.tree.scope, capability: checks.value.capability, trainingInputs: [] };
  const manifest = npmManifest(candidate.identity, checks.value.capability, raw.runtime, root.review.licenseSpdx, root.review.version);
  if (contentHashOf(raw.origin) !== contentHashOf(origin) || contentHashOf(raw.manifest) !== contentHashOf(manifest)) return undefined;
  return { type: raw.type, schemaVersion: 1, workspaceId: raw.workspaceId, origin, candidate, checks: checks.value, manifest, installation, runtime: structuredClone(raw.runtime) };
}
function runtimeShape(raw: unknown): raw is NpmToolRuntime {
  if (!recordOf(raw) || !textOf(raw.bin, 100) || !/^[a-zA-Z0-9_.-]+$/.test(raw.bin) || typeof raw.entrypoint !== "string" || !safePackagePath(raw.entrypoint)) return false;
  return raw.profile === "confined_npm_cli_v1" ? keysAre(raw, ["profile", "bin", "entrypoint"])
    : raw.profile === "confined_npm_mcp_v1" && keysAre(raw, ["profile", "bin", "entrypoint", "toolName", "protocolVersion"])
      && textOf(raw.toolName, 128) && /^[a-zA-Z0-9_-]+$/.test(raw.toolName) && ["2025-03-26", "2024-11-05"].includes(String(raw.protocolVersion));
}
function npmManifest(identity: string, capability: string, runtime: NpmToolRuntime, licenseSpdx: NodePackageToolManifest["licenseSpdx"], version: string): NodePackageToolManifest {
  return { runtimeProfile: runtime.profile, moduleFormat: "node_package", inputTransport: runtime.profile === "confined_npm_cli_v1" ? "argv_stdin" : "mcp_stdio",
    identity, version, origin: "direct", licenseSpdx, entrypoint: runtime.entrypoint, capabilities: [capability], permissions: [],
    processIsolation: true, cwdWhitelist: [], envWhitelist: [], secretsWhitelist: [], healthProbe: true, alwaysLoad: false, shouldDefer: true,
    cancelSupported: true, timeoutMs: 15_000, idempotencyKeyRequired: true, sideEffectCommitPoint: "none", stdoutBytes: 65_536, stderrBytes: 65_536,
    resultChars: 32_768, postinstall: "forbidden", thirdPartyTypes: "isolated" };
}
