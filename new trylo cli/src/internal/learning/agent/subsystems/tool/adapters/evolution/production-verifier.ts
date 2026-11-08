import { contentHashOf } from "../../../../../control/hash.js";
import { decodeToolProductionPlan, toolProductionVersion } from "../../domain/evolution/production-plan.js";
import type { ToolEvolutionCandidate, ToolEvolutionSample } from "../../domain/evolution/contracts.js";
import type { CandidateExecution } from "../../domain/evolution/execution.js";
import { VALIDATION_STAGE_ORDER, type StageResult, type ValidationRecord, type ValidationStageName } from "../../../../../../tooling/contract/types.js";
import { validateManifest } from "../../../../../../tooling/package-spi/manifest.js";
import { createToolCandidateExecutor, type ProcessToolExecutorOptions } from "../../../../../../adapters/tool-evolution/process-executor.js";
import { checkJsonFunctionSource } from "../../../../../../adapters/tool-evolution/json-function-policy.js";
import { probeProductionLifecycle, probeProductionPermissionBounds } from "./production-runtime-probes.js";
import { toolProductionCheckDiagnosis, toolProductionSampleFailure, type ToolProductionCheckDiagnosis } from "../../domain/evolution/production-check.js";

export type ProductionVerification = { readonly kind: "verified" | "failed" | "cancelled"; readonly record: ValidationRecord;
  readonly diagnosis?: ToolProductionCheckDiagnosis };

/** Real checks produce every stage. No API accepts caller-supplied pass flags or a validation record. */
export async function verifyToolProductionPlan(raw: unknown, options: ProcessToolExecutorOptions, signal: AbortSignal): Promise<ProductionVerification> {
  const decoded = decodeToolProductionPlan(raw), plan = decoded?.type === "tool_production_package" ? decoded : undefined, stages: StageResult[] = [];
  const versionId = plan === undefined ? "invalid-production-package" : toolProductionVersion(plan);
  let sampleFailure: ReturnType<typeof toolProductionSampleFailure>;
  const check = async (stage: ValidationStageName, action: () => Promise<boolean> | boolean, detail: string): Promise<boolean> => {
    if (signal.aborted || stages.some(row => !row.passed)) {
      stages.push({ stage, passed: false, detail: signal.aborted ? "verification cancelled" : "not run after a failed prerequisite" });
      return false;
    }
    let passed: boolean;
    try { passed = await action(); }
    catch { passed = false; }
    stages.push({ stage, passed, detail: passed ? detail : `${stage} did not establish its required evidence` });
    return passed;
  };

  await check("source_license_provenance", () => plan !== undefined && plan.manifest.origin === "self_created" && plan.origin.trainingInputs.length > 0,
    "Frozen generated source lineage and user-declared first-party license; no third-party package dependency");
  await check("archive_path_manifest_schema", () => plan !== undefined && validateManifest(plan.manifest).ok,
    "Immutable single-script package, fixed entrypoint, exact manifest and JSON bounds; no external archive extraction");
  await check("static_secret_malware_api", () => plan !== undefined && checkJsonFunctionSource(plan.candidate.source).ok,
    "Strict source grammar and forbidden-host vocabulary checked; runtime confinement remains mandatory");
  const executor = createToolCandidateExecutor({ ...options, profile: "confined_json_function_v1", timeoutMs: plan?.manifest.timeoutMs ?? 5000 });
  let sourcePassed = false;

  await check("type_build_unit", async () => {
    if (plan === undefined) return false;
    sourcePassed = await checkSamples(plan.candidate, plan.checks.evidence.filter(row => row.role === "source"), executor.execute, signal,
      "source", failure => { sampleFailure = failure; });
    return sourcePassed;
  }, "JavaScript compiled under strict semantics and frozen source-case units matched in fresh confined processes");
  await check("sandbox_smoke", () => sourcePassed,
    "Source cases also establish startup, bounded JSON protocol, normal exit and cleanup in the real confinement backend");
  await check("permission_malicious_bounds", () => probeProductionPermissionBounds(options, signal),
    "Fixed runtime probes refused sibling-file reads and loopback connection to a live positive-control listener");
  await check("cancel_timeout_crash", () => probeProductionLifecycle(options, signal),
    "Actual confined crash, deadline and cancellation classified without success or unconfined fallback");
  await check("idempotency_side_effects", async () => {
    if (plan === undefined) return false;
    const first = plan.checks.evidence.find(row => row.role === "source");
    if (first === undefined) return false;
    sampleFailure = toolProductionSampleFailure(first, await executor.execute(plan.candidate, first.input, signal), "repeat");
    return sampleFailure === undefined;
  }, "A repeated source input in another fresh process preserved its caller-owned expected result; IO remains denied");
  await check("baseline_regression", () => plan !== undefined && checkSamples(plan.candidate, plan.checks.evidence.filter(row => row.role !== "source"),
    executor.execute, signal, "heldout", failure => { sampleFailure = failure; }),
    "Fresh variation and counterexample inputs, disjoint from generation inputs, matched the frozen caller regression oracle; not an agent net-benefit claim");
  await check("independent_verdict", () => stages.length === 9 && stages.every(row => row.passed),
    "Trusted deterministic checker derived this verdict from all prior stages; generator output is not a verdict");
  const pass = stages.length === VALIDATION_STAGE_ORDER.length && stages.every((row, index) => row.stage === VALIDATION_STAGE_ORDER[index] && row.passed);
  const record: ValidationRecord = { validationId: `validation:${versionId}:${contentHashOf(stages)}`,
    packageVersionId: versionId, actor: "verifier", verdict: pass ? "pass" : "fail", stages };
  const diagnosis = plan === undefined || signal.aborted ? undefined : toolProductionCheckDiagnosis(plan, record, sampleFailure);

  return { kind: signal.aborted ? "cancelled" : pass ? "verified" : "failed", record, ...(diagnosis === undefined ? {} : { diagnosis }) };
}

type Execute = (candidate: ToolEvolutionCandidate, input: ToolEvolutionSample["input"], signal: AbortSignal) => Promise<CandidateExecution>;

async function checkSamples(candidate: ToolEvolutionCandidate, samples: readonly ToolEvolutionSample[], execute: Execute, signal: AbortSignal,
  caseSet: "source" | "heldout", onFailure: (failure: NonNullable<ReturnType<typeof toolProductionSampleFailure>>) => void): Promise<boolean> {
  if (samples.length === 0) return false;

  for (const sample of samples) {
    if (signal.aborted) return false;
    const failure = toolProductionSampleFailure(sample, await execute(candidate, sample.input, signal), caseSet);
    if (failure !== undefined) {
      onFailure(failure);
      return false;
    }
  }

  return true;
}
