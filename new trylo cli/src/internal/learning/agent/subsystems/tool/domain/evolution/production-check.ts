import { contentHashOf } from "../../../../../control/hash.js";
import { VALIDATION_STAGE_ORDER, type ValidationRecord, type ValidationStageName } from "../../../../../../tooling/contract/types.js";
import type { ToolProductionPlan } from "./production-plan.js";
import type { CandidateExecution } from "./execution.js";
import type { ToolEvolutionSample } from "./contracts.js";
import { keysAre, recordOf } from "./parse.js";

type CaseSet = "source" | "heldout" | "repeat";

const EXECUTION_KINDS = ["value", "tool_error", "timeout", "protocol_error", "unavailable", "cancelled"] as const;

export type ToolProductionSampleFailure = { readonly caseSet: CaseSet; readonly executionKind: CandidateExecution["kind"];
  readonly cause: "sample_mismatch" | "execution_unavailable" | "execution_timeout" | "execution_protocol" | "cancelled" };

export type ToolProductionCheckDiagnosis = {
  readonly schemaVersion: 1; readonly planHash: string; readonly checksHash: string; readonly stage: ValidationStageName;
  readonly cause: ToolProductionSampleFailure["cause"] | "provenance" | "archive_schema" | "static_security" | "permission_bounds" | "runtime_lifecycle" | "unclassified";
  readonly caseSet?: CaseSet; readonly executionKind?: CandidateExecution["kind"];
};

export type ToolProductionFailureEvidence = {
  readonly reportVersionId: string; readonly productionVersionId: string; readonly checkJobId: string;
  readonly parentVersionId: string; readonly checksHash: string; readonly stage: ToolProductionCheckDiagnosis["stage"];
  readonly caseSet: CaseSet; readonly executionKind: "value" | "tool_error";
};

/** Outcome-only attribution. Neither hidden case identity nor its input, expected
 * result or actual value crosses the independent checker boundary. */
export function toolProductionSampleFailure(sample: ToolEvolutionSample, execution: CandidateExecution, caseSet: CaseSet): ToolProductionSampleFailure | undefined {
  const actual = execution.kind === "value" ? execution : execution.kind === "tool_error" ? { kind: "error", code: execution.code } : undefined;
  if (actual !== undefined && contentHashOf(actual) === contentHashOf(sample.expected)) return undefined;
  return { caseSet, executionKind: execution.kind, cause: executionFailureCause(execution.kind) };
}

export function toolProductionCheckDiagnosis(plan: ToolProductionPlan, record: ValidationRecord, sampleFailure?: ToolProductionSampleFailure): ToolProductionCheckDiagnosis | undefined {
  const stage = record.stages.find(row => !row.passed)?.stage;
  if (record.verdict !== "fail" || stage === undefined) return undefined;

  const matchesCase = stage === "type_build_unit" && sampleFailure?.caseSet === "source"
    || stage === "baseline_regression" && sampleFailure?.caseSet === "heldout"
    || stage === "idempotency_side_effects" && sampleFailure?.caseSet === "repeat";
  const failure = matchesCase ? sampleFailure : undefined;
  const cause = failure?.cause ?? (stage === "source_license_provenance" ? "provenance"
    : stage === "archive_path_manifest_schema" ? "archive_schema" : stage === "static_secret_malware_api" ? "static_security"
      : stage === "permission_malicious_bounds" ? "permission_bounds" : stage === "cancel_timeout_crash" ? "runtime_lifecycle" : "unclassified");

  return { schemaVersion: 1, planHash: contentHashOf(plan), checksHash: contentHashOf(plan.checks), stage, cause,
    ...(failure === undefined ? {} : { caseSet: failure.caseSet, executionKind: failure.executionKind }) };
}

/** Structural binding only, never an issuance or activation verdict. The trusted
 * verifier constructs this sidecar from the real execution; callers cannot turn
 * a diagnostic report into authority by replaying this decoder. */
export function decodeToolProductionCheckDiagnosis(raw: unknown, plan: ToolProductionPlan, record: ValidationRecord): ToolProductionCheckDiagnosis | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["schemaVersion", "planHash", "checksHash", "stage", "cause"], ["caseSet", "executionKind"])
    || raw.schemaVersion !== 1 || raw.planHash !== contentHashOf(plan) || raw.checksHash !== contentHashOf(plan.checks)
    || record.verdict !== "fail" || record.stages.length !== VALIDATION_STAGE_ORDER.length
    || record.stages.some((row, index) => row.stage !== VALIDATION_STAGE_ORDER[index] || typeof row.passed !== "boolean")
    || raw.stage !== record.stages.find(row => !row.passed)?.stage) return undefined;

  const caseSet = raw.caseSet === "source" || raw.caseSet === "heldout" || raw.caseSet === "repeat" ? raw.caseSet : undefined;
  const executionKind = EXECUTION_KINDS.find(kind => kind === raw.executionKind);
  if ((raw.caseSet !== undefined && caseSet === undefined) || (raw.executionKind !== undefined && executionKind === undefined)
    || (caseSet === undefined) !== (executionKind === undefined)) return undefined;

  const expected = toolProductionCheckDiagnosis(plan, record, caseSet === undefined || executionKind === undefined ? undefined
    : { caseSet, executionKind, cause: executionFailureCause(executionKind) });

  return expected !== undefined && contentHashOf(expected) === contentHashOf(raw) ? expected : undefined;
}

function executionFailureCause(kind: CandidateExecution["kind"]): ToolProductionSampleFailure["cause"] {
  return kind === "value" || kind === "tool_error" ? "sample_mismatch" : kind === "unavailable" ? "execution_unavailable"
    : kind === "timeout" ? "execution_timeout" : kind === "protocol_error" ? "execution_protocol" : "cancelled";
}

export function toolProductionImplementationFailure(diagnosis: ToolProductionCheckDiagnosis): diagnosis is ToolProductionCheckDiagnosis & {
  readonly caseSet: CaseSet; readonly executionKind: "value" | "tool_error";
} {
  return diagnosis.cause === "sample_mismatch" && (diagnosis.executionKind === "value" || diagnosis.executionKind === "tool_error")
    && (diagnosis.stage === "type_build_unit" && diagnosis.caseSet === "source"
      || diagnosis.stage === "baseline_regression" && diagnosis.caseSet === "heldout"
      || diagnosis.stage === "idempotency_side_effects" && diagnosis.caseSet === "repeat");
}
