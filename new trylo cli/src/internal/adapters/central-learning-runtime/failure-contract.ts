import type { ReasonCode } from "../../learning/control/reasons.js";

export const CENTRAL_RUNTIME_FAILURE_STAGES = ["initialization", "metadata", "drive", "transport", "persistence"] as const;

export type CentralRuntimeFailureStage = (typeof CENTRAL_RUNTIME_FAILURE_STAGES)[number];

const BOARD_FAILURE_CODES = ["learning_budget_binding"] as const satisfies readonly ReasonCode[];
// These are exact emitted codes, not patterns or a catalog of historical exceptions.
export const CENTRAL_RUNTIME_FAILURE_CODES = [...BOARD_FAILURE_CODES,
  "organization_sensitive_content", "runtime_configuration_invalid", "runtime_configuration_changed",
  "runtime_initialization_unavailable", "runtime_scope_mismatch", "runtime_io_failed", "runtime_owner_lost",
  "runtime_write_failed", "runtime_worker_metadata_uncommitted", "runtime_worker_scope_mismatch",
  "runtime_worker_busy", "runtime_worker_reply_invalid", "runtime_worker_progress_failed",
  "runtime_worker_failed", "runtime_worker_closed", "runtime_worker_out_of_memory",
  "runtime_worker_module_not_found", "runtime_worker_syntax_error", "runtime_worker_output_closed"] as const;

export type CentralRuntimeFailureCode = (typeof CENTRAL_RUNTIME_FAILURE_CODES)[number] | "unclassified";

export type CentralRuntimeFailure = { readonly stage: CentralRuntimeFailureStage; readonly code: CentralRuntimeFailureCode };

const stages = new Set<string>(CENTRAL_RUNTIME_FAILURE_STAGES);
const codes = new Map<string, CentralRuntimeFailureCode>(CENTRAL_RUNTIME_FAILURE_CODES.map(code => [code, code]));

codes.set("unclassified", "unclassified");

const marked = new WeakMap<object, CentralRuntimeFailure>();

/** Only own data fields cross the diagnostic boundary. No getters, prose parsing or coercion. */
function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function record(value: unknown): value is object { return typeof value === "object" && value !== null; }

function snapshot(stage: CentralRuntimeFailureStage, code: CentralRuntimeFailureCode): CentralRuntimeFailure {
  return Object.freeze({ stage, code });
}

export function isCentralRuntimeFailure(value: unknown): value is CentralRuntimeFailure {
  return readFailure(value) !== undefined;
}

function readFailure(value: unknown): CentralRuntimeFailure | undefined {
  try {
    if (!record(value) || Reflect.ownKeys(value).length !== 2) return undefined;
    const stage = data(value, "stage"), code = data(value, "code");
    if (typeof stage !== "string" || !stages.has(stage) || typeof code !== "string") return undefined;
    const canonical = codes.get(code);
    return canonical === undefined ? undefined : snapshot(stage as CentralRuntimeFailureStage, canonical);
  } catch { return undefined; } // An exotic object never grants a diagnostic payload.
}

/** An exact match returns the canonical table value, never an exception's arbitrary text. */
export function centralRuntimeFailure(error: unknown, stage: CentralRuntimeFailureStage): CentralRuntimeFailure {
  if (!record(error)) return snapshot(stage, "unclassified");

  const prior = marked.get(error);
  if (prior !== undefined) return prior;

  try {
    for (const key of ["code", "reason", "message"]) {
      const value = data(error, key), code = typeof value === "string" ? codes.get(value) : undefined;
      if (code !== undefined) return snapshot(stage, code);
    }
  } catch { /* A throwing proxy/access descriptor exposes no details. */ }

  return snapshot(stage, "unclassified");
}

/** Keep the original exception identity in this thread; the public representation is separate. */
export function markCentralRuntimeFailure(error: unknown, stage: CentralRuntimeFailureStage, original: unknown = error): unknown {
  const carrier = record(error) ? error : new Error("runtime_failure_unclassified");
  if (!marked.has(carrier)) marked.set(carrier, centralRuntimeFailure(original, stage));
  return carrier;
}

/** IPC receives a newly validated two-field value, without an exception, cause or stack. */
export function centralRuntimeFailureError(reason: string, failure: unknown, stage: CentralRuntimeFailureStage): Error {
  const error = new Error(reason);
  marked.set(error, readFailure(failure) ?? snapshot(stage, "unclassified"));
  return error;
}
