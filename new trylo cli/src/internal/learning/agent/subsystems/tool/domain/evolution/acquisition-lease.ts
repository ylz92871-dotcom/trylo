import { contentHashOf } from "../../../../../control/hash.js";
import { isIsoTime } from "./artifact.js";
import { keysAre, recordOf } from "./parse.js";

export const ACQUISITION_START_LEASE_MS = 600_000;

export type AcquisitionAdaptationLease = {
  readonly type: "tool_acquisition_adaptation_lease";
  readonly schemaVersion: 1;
  readonly originalJobId: string;
  readonly approvalId: string;
  readonly installationId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly expiresAt: string;
};

const identity = (raw: unknown, prefix: string): raw is string => typeof raw === "string" && new RegExp(`^${prefix}_v1_[a-f0-9]{64}$`).test(raw);

export function acquisitionAdaptationLeaseId(lease: AcquisitionAdaptationLease): string {
  return `tool-adaptation-lease_v1_${contentHashOf(lease)}`;
}

export function acquisitionRecoveryReviewId(raw: unknown): string { return `tool-adaptation-recovery-review_v1_${contentHashOf(raw)}`; }

export function isAcquisitionRecoveryReviewId(raw: unknown): raw is string { return identity(raw, "tool-adaptation-recovery-review"); }

export function decodeAcquisitionAdaptationLease(raw: unknown): AcquisitionAdaptationLease | undefined {
  return recordOf(raw) && keysAre(raw, ["type", "schemaVersion", "originalJobId", "approvalId", "installationId", "jobId", "attempt", "startedAt", "expiresAt"])
    && raw.type === "tool_acquisition_adaptation_lease" && raw.schemaVersion === 1 && identity(raw.originalJobId, "tool-learning")
    && identity(raw.approvalId, "tool-decision") && identity(raw.installationId, "npm-install") && identity(raw.jobId, "tool-adaptation")
    && typeof raw.attempt === "number" && Number.isSafeInteger(raw.attempt) && raw.attempt >= 1 && raw.attempt <= 3
    && isIsoTime(raw.startedAt) && isIsoTime(raw.expiresAt) && Date.parse(raw.expiresAt) - Date.parse(raw.startedAt) === ACQUISITION_START_LEASE_MS
    ? raw as AcquisitionAdaptationLease : undefined;
}
