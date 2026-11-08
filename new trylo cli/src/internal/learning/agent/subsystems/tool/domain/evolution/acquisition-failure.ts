import { contentHashOf } from "../../../../../control/hash.js";
import { isToolPipelineCounter } from "./pipeline-lifetime.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "./parse.js";

export const TOOL_ACQUISITION_FAILURE_PHASES = ["resolve", "preparation_permission", "preparation", "plan_commit", "install_permission", "install", "receipt_commit"] as const;

export type ToolAcquisitionFailurePhase = typeof TOOL_ACQUISITION_FAILURE_PHASES[number];

export type ToolAcquisitionFailureDiagnostic = { readonly packageName: string; readonly version?: string;
  readonly stage: "metadata_fetch" | "metadata_projection" | "selected_archive_semantics"; readonly code: string };

export type ToolAcquisitionFailure = { readonly type: "tool_acquisition_failure"; readonly schemaVersion: 1;
  readonly jobId: string; readonly attempt: number; readonly decisionVersionId: string; readonly scope: string; readonly capability: string;
  readonly candidate: { readonly platform: "npm"; readonly id: string; readonly version: string };
  readonly phase: ToolAcquisitionFailurePhase; readonly code: string; readonly diagnostics: readonly ToolAcquisitionFailureDiagnostic[];
  readonly installationId?: string };

export type ToolAcquisitionFailureEvidence = ToolAcquisitionFailure & { readonly ref: string };

export type ToolAcquisitionFailureRecovery = "investigate" | "retry_explicitly" | "await_stop";

const DIAGNOSTIC_CODES = new Set(["cancelled", "insecure_scheme", "host_not_allowed", "too_many_redirects", "http_error", "too_large", "timeout", "network_failure", "not_json",
  "malformed_metadata", "domain_mismatch", "search_unsupported", "not_derivable", "invalid_npm_metadata", "unsupported_npm_dependency", "unsupported_npm_source", "npm_shrinkwrap_unsupported", "npm_bundled_dependency_unsupported"]);
const INVESTIGATE_CODES = new Set(["invalid_npm_candidate", "unsupported_npm_dependency", "unsupported_npm_source", "npm_shrinkwrap_unsupported", "npm_bundled_dependency_unsupported",
  "npm_install_hook_forbidden", "install_hook_forbidden", "unsupported_dependency_closure", "npm_source_review_incomplete", "npm_archive_integrity_mismatch", "hash_mismatch", "manifest_mismatch", "license_mismatch",
  "npm_metadata_identity_mismatch", "npm_engine_mismatch", "npm_platform_mismatch", "npm_dependency_mismatch", "invalid_npm_lock", "invalid_npm_metadata", "npm_unreachable_package",
  "quarantine_corrupt", "unsafe_archive_path", "unsupported_archive_entry", "invalid_archive", "archive_limit", "npm_install_archive_limit", "npm_tree_limit", "npm_lock_limit", "npm_install_target_mismatch"]);

export function safeToolAcquisitionFailureCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,159}$/.test(value) ? value : "acquisition_operation_failed";
}

export function toolAcquisitionFailureVersion(failure: ToolAcquisitionFailure): string { return `tool-acquisition-failure_v1_${contentHashOf(failure)}`; }

export function toolAcquisitionFailureRecovery(failure: Pick<ToolAcquisitionFailure, "code" | "diagnostics">): ToolAcquisitionFailureRecovery {
  return failure.code === "npm_resolver_stop_unconfirmed" ? "await_stop"
    : INVESTIGATE_CODES.has(failure.code) || failure.diagnostics.some(row => row.stage === "selected_archive_semantics") ? "investigate" : "retry_explicitly";
}

export function toolAcquisitionChoiceStillBlocked(failure: ToolAcquisitionFailure, candidate: { readonly platform: string; readonly id: string; readonly version: string }): boolean {
  return toolAcquisitionFailureRecovery(failure) === "investigate" && candidate.platform === failure.candidate.platform
    && candidate.id === failure.candidate.id && candidate.version === failure.candidate.version;
}

/** Copy only the host's small code vocabulary; no error prose, stderr, scratch paths or arbitrary keys. */
export function safeToolAcquisitionDiagnostics(raw: unknown): readonly ToolAcquisitionFailureDiagnostic[] {
  if (!Array.isArray(raw)) return [];

  const rows = raw.slice(0, 16).flatMap(value => {
    if (!recordOf(value) || !textOf(value.packageName, 256) || !/^(?:@[a-z0-9][a-z0-9._-]{0,80}\/)?[a-z0-9][a-z0-9._-]{0,80}$/.test(value.packageName)
      || value.version !== undefined && (!textOf(value.version, 80) || !/^[0-9A-Za-z.+-]+$/.test(value.version))
      || !["metadata_fetch", "metadata_projection", "selected_archive_semantics"].includes(String(value.stage))
      || typeof value.code !== "string" || !DIAGNOSTIC_CODES.has(value.code)) return [];
    return [{ packageName: value.packageName, ...(value.version === undefined ? {} : { version: value.version }),
      stage: value.stage as ToolAcquisitionFailureDiagnostic["stage"], code: value.code }];
  });

  return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function decodeToolAcquisitionFailure(raw: unknown): ToolAcquisitionFailure | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 16_384 || !recordOf(raw)
    || !keysAre(raw, ["type", "schemaVersion", "jobId", "attempt", "decisionVersionId", "scope", "capability", "candidate", "phase", "code", "diagnostics"], ["installationId"])
    || raw.type !== "tool_acquisition_failure" || raw.schemaVersion !== 1 || typeof raw.jobId !== "string" || !/^tool-learning_v1_[a-f0-9]{64}$/.test(raw.jobId)
    || !isToolPipelineCounter(raw.attempt)
    || typeof raw.decisionVersionId !== "string" || !/^tool-decision_v1_[a-f0-9]{64}$/.test(raw.decisionVersionId)
    || !textOf(raw.scope, 512) || !textOf(raw.capability, 2_048) || !recordOf(raw.candidate)
    || !keysAre(raw.candidate, ["platform", "id", "version"]) || raw.candidate.platform !== "npm" || !textOf(raw.candidate.id, 512) || !textOf(raw.candidate.version, 160)
    || !TOOL_ACQUISITION_FAILURE_PHASES.includes(raw.phase as ToolAcquisitionFailurePhase) || typeof raw.code !== "string" || raw.code !== safeToolAcquisitionFailureCode(raw.code)
    || !Array.isArray(raw.diagnostics) || raw.diagnostics.length > 16 || contentHashOf(raw.diagnostics) !== contentHashOf(safeToolAcquisitionDiagnostics(raw.diagnostics))
    || raw.installationId !== undefined && (typeof raw.installationId !== "string" || !/^npm-install_v1_[a-f0-9]{64}$/.test(raw.installationId))) return undefined;
  return { type: raw.type, schemaVersion: 1, jobId: raw.jobId, attempt: raw.attempt, decisionVersionId: raw.decisionVersionId, scope: raw.scope,
    capability: raw.capability, candidate: { platform: "npm", id: raw.candidate.id, version: raw.candidate.version }, phase: raw.phase as ToolAcquisitionFailurePhase,
    code: raw.code, diagnostics: safeToolAcquisitionDiagnostics(raw.diagnostics), ...(raw.installationId === undefined ? {} : { installationId: raw.installationId }) };
}
