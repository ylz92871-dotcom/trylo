import type { CollaborationRuntimeReceipt } from "../../protocol/collaboration-resource.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../protocol/collaboration-resource.js";
import type { ExperienceBoundaryReceipt } from "../../protocol/collaboration-experience.js";
import { isExperienceOwner } from "../agent/subsystems/collaboration/experience/parse.js";
import { experienceOwnerFingerprint } from "../agent/subsystems/collaboration/experience/policy.js";
import { isExperienceFeedbackFields } from "./collaboration-feedback-contract.js";

type Row = Record<string, unknown>;

const row = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, n: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= n && !v.includes("\0");
const exact = (v: Row, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const optional = (v: unknown, n: number) => v === undefined || text(v, n);
const list = (v: unknown, n: number, maxChars = 512): v is string[] => Array.isArray(v) && v.length <= n
  && v.every(item => text(item, maxChars)) && new Set(v).size === v.length;
const timestamp = (v: unknown) => text(v, 64) && Number.isFinite(Date.parse(v));

function boundary(v: unknown): v is ExperienceBoundaryReceipt["boundary"] {
  return row(v) && exact(v, ["executionId", "taskId", "round", "role", "memberId", "teamRunId", "configurationRef", "requestId"])
    && text(v.executionId, 512) && text(v.taskId, 512) && text(v.role, 128) && Number.isSafeInteger(v.round) && Number(v.round) >= 0
    && optional(v.memberId, 200) && optional(v.teamRunId, 512) && optional(v.configurationRef, 512) && optional(v.requestId, 512);
}

export function isCollaborationRuntimeReceipt(v: unknown): v is CollaborationRuntimeReceipt {
  if (!row(v) || v.schemaVersion !== 1 || !text(v.receiptId, 512) || !text(v.scope, 512)
    || !timestamp(v.recordedAt)) return false;

  if (v.phase === "use_feedback") return exact(v, ["schemaVersion", "receiptId", "phase", "scope", "owner", "versionIds", "usageReceiptId", "summary", "sourceRefs", "outcome", "recordedAt", "assessments"])
    && isExperienceFeedbackFields(v);

  if (!boundary(v.boundary)) return false;

  if (v.phase === "loaded" || v.phase === "dispatched") {
    return exact(v, ["schemaVersion", "receiptId", "phase", "scope", "owner", "ownerFingerprint", "versionIds", "boundary", "recordedAt"])
      && isExperienceOwner(v.owner) && v.ownerFingerprint === experienceOwnerFingerprint(v.owner)
      && list(v.versionIds, 32) && v.versionIds.length > 0
      && (v.phase === "loaded" || text(v.boundary.requestId, 512) && text(v.boundary.configurationRef, 512));
  }

  return (v.phase === "resource_query" || v.phase === "resource_result")
    && exact(v, ["schemaVersion", "receiptId", "phase", "scope", "issueId", "jobId", "grantId", "requestId", "owner", "query", "resultRefs", "summary", "status", "boundary", "recordedAt"])
    && text(v.issueId, 512) && text(v.jobId, 512) && text(v.grantId, 512) && text(v.requestId, 512)
    && ["tool", "expert", "experience", "research"].includes(String(v.owner)) && text(v.query, COLLABORATION_RESOURCE_LIMITS.queryMaxChars)
    && text(v.summary, COLLABORATION_RESOURCE_LIMITS.summaryMaxChars)
    && list(v.resultRefs, COLLABORATION_RESOURCE_LIMITS.maxResultRefs, COLLABORATION_RESOURCE_LIMITS.referenceMaxChars)
    && (v.phase === "resource_query" ? v.status === undefined && v.resultRefs.length === 0
      : ["available", "empty", "unavailable"].includes(String(v.status)) && (v.status !== "available" || v.resultRefs.length > 0));
}
