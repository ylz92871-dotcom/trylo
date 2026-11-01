import { canonicalJson, sha256Hex } from "../../../control/hash.js";
import { decodeToolEvolutionVerification, isDigest, isIsoTime } from "./artifact.js";
import { isJsonValue, keysAre, recordOf, textOf } from "./parse.js";
import type { ToolEvolutionVerification } from "./verification.js";

export const MAX_TOOL_TRIALS = 2048;
/** A host-recorded trial fact; this is never a production verification receipt. */
export type ToolTrialRecord = {
  readonly schemaVersion: 1;
  readonly trialId: string;
  readonly versionId: string;
  readonly scope: string;
  readonly requestHash: string;
  readonly verification: ToolEvolutionVerification;
  readonly occurredAt: string;
};

export function decodeToolTrialRecord(value: unknown): ToolTrialRecord | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["schemaVersion", "trialId", "versionId", "scope", "requestHash", "verification", "occurredAt"])
    || value.schemaVersion !== 1 || !textOf(value.trialId, 128) || !textOf(value.versionId, 160) || !textOf(value.scope, 512)
    || !isDigest(value.requestHash) || !isIsoTime(value.occurredAt)) return undefined;
  const verification = decodeToolEvolutionVerification(value.verification);
  if (verification === undefined || verification.checks.length === 0
    || new Set(verification.checks.map(check => check.sampleId)).size !== verification.checks.length) return undefined;
  return { schemaVersion: 1, trialId: value.trialId, versionId: value.versionId, scope: value.scope,
    requestHash: value.requestHash, verification, occurredAt: value.occurredAt };
}

export function toolTrialKey(record: Pick<ToolTrialRecord, "versionId" | "trialId">): string {
  return sha256Hex(canonicalJson([record.versionId, record.trialId]));
}

/** Feedback exposes only check identities/outcomes, never held-out inputs or answers. */
export function toolTrialFeedback(records: readonly ToolTrialRecord[]): string | undefined {
  const failed = records.filter(record => record.verification.verdict === "fail").slice(-8);
  if (failed.length === 0) return undefined;
  return JSON.stringify(failed.map(record => ({ trialId: record.trialId,
    checks: record.verification.checks.filter(check => check.outcome !== "passed")
      .map(check => ({ sampleId: check.sampleId, role: check.role, outcome: check.outcome })) })));
}
