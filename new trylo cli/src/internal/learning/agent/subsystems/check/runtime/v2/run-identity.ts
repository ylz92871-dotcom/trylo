import { contentHashOf } from "../../../../../control/hash.js";
import { parseCheckInput, parseCheckRequirements, parseCheckerVerdict } from "../../domain/v2/parse.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import type { CheckerFailure, CheckerOutcome, CheckerRun, CheckerRunClaim } from "./contracts.js";
import { checkerMaterialHasCredentials } from "./privacy.js";

export type CheckerRunRequest = Omit<CheckerRun, "schemaVersion" | "type" | "outcome">;

/** One canonical identity is used by admission, durable claims and terminal readback. */
export function runRequest(value: CheckerRun | CheckerRunClaim | CheckerRunRequest): CheckerRunRequest {
  return { runId: value.runId, versionId: value.versionId, scope: value.scope, sessionId: value.sessionId, turnId: value.turnId,
    requirements: value.requirements, input: value.input, inputDigest: value.inputDigest };
}

export function sameRunRequest(left: CheckerRun | CheckerRunClaim | CheckerRunRequest, right: CheckerRun | CheckerRunClaim | CheckerRunRequest): boolean {
  return contentHashOf(runRequest(left)) === contentHashOf(runRequest(right));
}

export function parseCheckerRunRequest(raw: unknown): { readonly ok: true; readonly value: CheckerRunRequest } | CheckerFailure {
  if (!isJsonValue(raw) || jsonBytes(raw) > 65_536 || !recordOf(raw)
    || !keysAre(raw, ["runId", "versionId", "scope", "sessionId", "turnId", "requirements", "input", "inputDigest"])
    || ![raw.runId, raw.versionId, raw.scope].every(value => textOf(value, 512))
    || ![raw.sessionId, raw.turnId].every(value => textOf(value, 160)) || typeof raw.inputDigest !== "string" || !/^[a-f0-9]{64}$/u.test(raw.inputDigest)) {
    return invalid("run request needs bounded exact identity and input digest");
  }

  if (checkerMaterialHasCredentials(raw)) return { ok: false, code: "check_evidence_ineligible", message: "credential-shaped material cannot become a durable checker input" };

  const requirements = parseCheckRequirements(raw.requirements), input = parseCheckInput(raw.input);
  if (!requirements.ok || !input.ok || requirements.value.ref !== input.value.task.requirementRef
    || requirements.value.digest !== input.value.task.requirementDigest || contentHashOf(input.value) !== raw.inputDigest) {
    return invalid("run input is not bound to its immutable requirement and digest");
  }

  return { ok: true, value: { runId: String(raw.runId), versionId: String(raw.versionId), scope: String(raw.scope),
    sessionId: String(raw.sessionId), turnId: String(raw.turnId), inputDigest: raw.inputDigest,
    requirements: requirements.value, input: input.value } };
}

function invalid(message: string): CheckerFailure { return { ok: false, code: "invalid_checker_run_request", message }; }

export function parseCheckerRunOutcome(raw: unknown, requirementRef: string): CheckerOutcome | undefined {
  if (!recordOf(raw)) return undefined;
  if (raw.kind === "cancelled" && keysAre(raw, ["kind"])) return { kind: "cancelled" };
  if (raw.kind === "checker_error" && keysAre(raw, ["kind", "code"]) && textOf(raw.code, 256)) return { kind: "checker_error", code: raw.code };
  const verdict = raw.kind === "checked" && keysAre(raw, ["kind", "verdict"]) ? parseCheckerVerdict(raw.verdict) : undefined;
  return verdict?.ok && verdict.value.findings.every(finding => finding.requirementRef === requirementRef)
    ? { kind: "checked", verdict: verdict.value } : undefined;
}
