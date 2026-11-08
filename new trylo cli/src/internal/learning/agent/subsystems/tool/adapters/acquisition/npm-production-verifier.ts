import path from "node:path";
import { contentHashOf } from "../../../../../control/hash.js";
import { decodeNpmToolProductionPlan } from "../../domain/evolution/npm-production-plan.js";
import { toolProductionVersion } from "../../domain/evolution/production-plan.js";
import type { ToolEvolutionSample } from "../../domain/evolution/contracts.js";
import type { CandidateExecution } from "../../domain/evolution/execution.js";
import { VALIDATION_STAGE_ORDER, type StageResult, type ValidationRecord, type ValidationStageName } from "../../../../../../tooling/contract/types.js";
import { validateManifest } from "../../../../../../tooling/package-spi/manifest.js";
import { npmInstallId } from "../../../../../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan } from "./npm-install-plan.js";
import { readNpmInstall } from "./npm-install-files.js";
import { executeNpmTool, type NpmRuntimeOptions } from "./npm-runtime.js";
import { probeNpmLifecycle, probeNpmPermissionBounds } from "./npm-runtime-probes.js";
import { hasEmbeddedSecret } from "./embedded-secret.js";
import { adaptNpmFiles } from "./npm-adaptation-files.js";
import { toolProductionCheckDiagnosis, toolProductionSampleFailure } from "../../domain/evolution/production-check.js";

/** Independent root checker derives a real record; installation receipts never contain pass flags. */
export async function verifyNpmToolProduction(raw: unknown, options: NpmRuntimeOptions, signal: AbortSignal) {
  const plan = decodeNpmToolProductionPlan(raw), stages: StageResult[] = [];
  const versionId = plan === undefined ? "invalid-npm-production-package" : toolProductionVersion(plan);
  let sampleFailure: ReturnType<typeof toolProductionSampleFailure>;
  let installed: Awaited<ReturnType<typeof readNpmInstall>>;
  let effective: ReturnType<typeof adaptNpmFiles> | undefined;
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
    if (installed === undefined) return false;
    effective = adaptNpmFiles(plan, installed.files);
    return true;
  }, "Every exact registry archive, SHA512 integrity, manifest and license/NOTICE hash matched the complete runtime closure; repository/commit labels remain caller-reviewed or publisher claims, never a verified build-origin claim");
  await check("archive_path_manifest_schema", () => plan !== undefined && installed !== undefined && validateManifest(plan.manifest).ok,
    "Real source archives reconstructed all physical files; archive paths, dependency edges, platform/engine, hooks and explicit CLI/MCP ABI checked");
  await check("static_secret_malware_api", () => installed !== undefined && effective !== undefined
    && !installed.files.some(file => hasEmbeddedSecret(file.body)) && !effective.some(file => hasEmbeddedSecret(file.body)),
    "Known embedded credential material signatures absent; format labels alone are not key material; native binaries, bundled trees and installation hooks forbidden; arbitrary source is confined, not declared malware-free");
  const execute = (input: ToolEvolutionSample["input"]) => plan === undefined ? Promise.resolve({ kind: "unavailable" as const, detail: "invalid plan" }) : executeNpmTool(plan, input, options, signal);

  await check("type_build_unit", () => plan !== undefined && samples(plan.checks.evidence.filter(row => row.role === "source"), execute,
    "source", failure => { sampleFailure = failure; }),
    "Two caller-owned source cases executed the actual reviewed package closure with its versioned adapter/overlays and matched exact outputs");
  await check("sandbox_smoke", () => plan !== undefined,
    "Source cases also proved startup/exit and capture; MCP profile additionally negotiated initialize, listed and hash-matched its selected schema, and called the selected tool");
  await check("permission_malicious_bounds", () => probeNpmPermissionBounds(options, signal),
    "Same broker/child flags refused sibling-file reads, writes, subprocess creation and connection to a live positive-control loopback listener; synthetic inherited secret absent");
  await check("cancel_timeout_crash", () => probeNpmLifecycle(options, signal),
    "Same confined launch classified actual child exit 23, deadline and cancellation without replay or host fallback");
  await check("idempotency_side_effects", async () => {
    const first = plan?.checks.evidence.find(row => row.role === "source");
    if (first === undefined) return false;
    sampleFailure = toolProductionSampleFailure(first, await execute(first.input), "repeat");
    return sampleFailure === undefined;
  }, "Repeated source case matched in a fresh private snapshot with no package write, secret, child-process or network grants");
  await check("baseline_regression", () => plan !== undefined && samples(plan.checks.evidence.filter(row => row.role !== "source"), execute,
    "heldout", failure => { sampleFailure = failure; }),
    "Caller-frozen variation and counterexample matched actual package results; this is interface regression evidence, not cross-task net benefit");
  await check("independent_verdict", () => stages.length === 9 && stages.every(row => row.passed),
    "Trusted npm checker derived the verdict from source revalidation and all real execution stages; explicit activation is still required");
  const pass = stages.length === VALIDATION_STAGE_ORDER.length && stages.every((row, index) => row.stage === VALIDATION_STAGE_ORDER[index] && row.passed);
  const record: ValidationRecord = { validationId: `validation:${versionId}:${contentHashOf(stages)}`, packageVersionId: versionId, actor: "verifier", verdict: pass ? "pass" : "fail", stages };
  const diagnosis = plan === undefined || signal.aborted ? undefined : toolProductionCheckDiagnosis(plan, record, sampleFailure);

  return { kind: signal.aborted ? "cancelled" as const : pass ? "verified" as const : "failed" as const, record,
    ...(diagnosis === undefined ? {} : { diagnosis }) };
}

async function samples(rows: readonly ToolEvolutionSample[], execute: (input: ToolEvolutionSample["input"]) => Promise<CandidateExecution>,
  caseSet: "source" | "heldout", onFailure: (failure: NonNullable<ReturnType<typeof toolProductionSampleFailure>>) => void): Promise<boolean> {
  if (rows.length === 0) return false;
  for (const row of rows) {
    const failure = toolProductionSampleFailure(row, await execute(row.input), caseSet);
    if (failure !== undefined) {
      onFailure(failure);
      return false;
    }
  }
  return true;
}
