import path from "node:path";
import { contentHashOf } from "../../learning/control/hash.js";
import { decodeNpmToolProductionPlan } from "../../learning/domains/tool/evolution/npm-production-plan.js";
import { toolProductionVersion } from "../../learning/domains/tool/evolution/production-plan.js";
import type { ToolEvolutionSample } from "../../learning/domains/tool/evolution/contracts.js";
import type { CandidateExecution } from "../../learning/domains/tool/evolution/execution.js";
import { VALIDATION_STAGE_ORDER, type StageResult, type ValidationRecord, type ValidationStageName } from "../../tooling/contract/types.js";
import { validateManifest } from "../../tooling/package-spi/manifest.js";
import { npmInstallId } from "../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan } from "./npm-install-plan.js";
import { readNpmInstall } from "./npm-install-files.js";
import { executeNpmTool, type NpmRuntimeOptions } from "./npm-runtime.js";
import { probeNpmLifecycle, probeNpmPermissionBounds } from "./npm-runtime-probes.js";
import { hasEmbeddedSecret } from "./embedded-secret.js";

/** Independent root checker derives a real record; installation receipts never contain pass flags. */
export async function verifyNpmToolProduction(raw: unknown, options: NpmRuntimeOptions, signal: AbortSignal) {
  const plan = decodeNpmToolProductionPlan(raw), stages: StageResult[] = [];
  const versionId = plan === undefined ? "invalid-npm-production-package" : toolProductionVersion(plan);
  let installed: Awaited<ReturnType<typeof readNpmInstall>>;
  const check = async (stage: ValidationStageName, action: () => Promise<boolean> | boolean, detail: string) => {
    let passed = false;
    if (!signal.aborted && stages.every(row => row.passed)) {
      try { passed = await action(); } catch { passed = false; }
    }
    stages.push({ stage, passed, detail: passed ? detail : signal.aborted ? "verification cancelled" : `${stage} did not establish its required evidence` });
  };
  await check("source_license_provenance", async () => {
    if (plan === undefined || decodeNpmInstallPlan(plan.installation) === undefined) return false;
    installed = await readNpmInstall(path.join(options.installationRoot, npmInstallId(plan.installation)), plan.installation);
    return installed !== undefined;
  }, "Every reviewed exact archive, SHA512 integrity, source pointer, manifest and license/NOTICE hash matched the complete runtime closure; source pointers remain caller-reviewed provenance");
  await check("archive_path_manifest_schema", () => plan !== undefined && installed !== undefined && validateManifest(plan.manifest).ok,
    "Real source archives reconstructed all physical files; archive paths, dependency edges, platform/engine, hooks and explicit CLI/MCP ABI checked");
  await check("static_secret_malware_api", () => installed !== undefined && !installed.files.some(file => hasEmbeddedSecret(file.body)),
    "Known embedded credential material signatures absent; format labels alone are not key material; native binaries, bundled trees and installation hooks forbidden; arbitrary source is confined, not declared malware-free");
  const execute = (input: ToolEvolutionSample["input"]) => plan === undefined ? Promise.resolve({ kind: "unavailable" as const, detail: "invalid plan" }) : executeNpmTool(plan, input, options, signal);
  await check("type_build_unit", () => plan !== undefined && samples(plan.checks.evidence.filter(row => row.role === "source"), execute),
    "Two caller-owned source cases executed the actual package dependency closure and matched exact outputs");
  await check("sandbox_smoke", () => plan !== undefined,
    "Source cases also proved startup/exit and capture; MCP profile additionally negotiated initialize, listed and hash-matched its selected schema, and called the selected tool");
  await check("permission_malicious_bounds", () => probeNpmPermissionBounds(options, signal),
    "Same broker/child flags refused sibling-file reads, writes, subprocess creation and connection to a live positive-control loopback listener; synthetic inherited secret absent");
  await check("cancel_timeout_crash", () => probeNpmLifecycle(options, signal),
    "Same confined launch classified actual child exit 23, deadline and cancellation without replay or host fallback");
  await check("idempotency_side_effects", async () => {
    const first = plan?.checks.evidence.find(row => row.role === "source"); return first !== undefined && match(first, await execute(first.input));
  }, "Repeated source case matched in a fresh private snapshot with no package write, secret, child-process or network grants");
  await check("baseline_regression", () => plan !== undefined && samples(plan.checks.evidence.filter(row => row.role !== "source"), execute),
    "Caller-frozen variation and counterexample matched actual package results; this is interface regression evidence, not cross-task net benefit");
  await check("independent_verdict", () => stages.length === 9 && stages.every(row => row.passed),
    "Trusted npm checker derived the verdict from source revalidation and all real execution stages; explicit activation is still required");
  const pass = stages.length === VALIDATION_STAGE_ORDER.length && stages.every((row, index) => row.stage === VALIDATION_STAGE_ORDER[index] && row.passed);
  const record: ValidationRecord = { validationId: `validation:${versionId}:${contentHashOf(stages)}`, packageVersionId: versionId, actor: "verifier", verdict: pass ? "pass" : "fail", stages };
  return { kind: signal.aborted ? "cancelled" as const : pass ? "verified" as const : "failed" as const, record };
}
async function samples(rows: readonly ToolEvolutionSample[], execute: (input: ToolEvolutionSample["input"]) => Promise<CandidateExecution>): Promise<boolean> {
  if (rows.length === 0) return false;
  for (const row of rows) if (!match(row, await execute(row.input))) return false;
  return true;
}
function match(row: ToolEvolutionSample, result: CandidateExecution): boolean {
  const actual = result.kind === "value" ? result : result.kind === "tool_error" ? { kind: "error", code: result.code } : undefined;
  return actual !== undefined && contentHashOf(actual) === contentHashOf(row.expected);
}
