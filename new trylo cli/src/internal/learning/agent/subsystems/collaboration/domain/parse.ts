import { isSubagentHandoff } from "../../../../../protocol/subagent-handoff.js";
import { HANDOFF_FIELDS, type CollaborationContext, type CollaborationFact, type CollaborationPractice, type CollaborationResult } from "./contracts.js";

type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 && value.every(text)
  && new Set(value).size === value.length;
const exact = (value: Row, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const contains = (value: unknown, values: readonly string[]): boolean => typeof value === "string" && values.includes(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100000;
const localScope = (value: unknown): value is string => text(value) && !["global", "*", "broad"].includes(value.trim().toLowerCase());

export function isCollaborationContext(value: unknown): value is CollaborationContext {
  return row(value) && exact(value, ["scope", "teamRunId", "taskId", "memberId", "role", "round", "dependency"])
    && localScope(value.scope) && [value.teamRunId, value.taskId, value.memberId, value.role].every(text)
    && count(value.round) && value.round > 0 && contains(value.dependency, ["artifact", "independent"]);
}

export function isCollaborationResult(value: unknown): value is CollaborationResult {
  if (!row(value) || !exact(value, ["status", "check", "reworkCount", "missingFields", "capability", "evidenceRefs", "source"])) return false;
  return contains(value.status, ["completed", "failed", "cancelled", "unknown"])
    && contains(value.check, ["passed", "failed", "unverified"]) && count(value.reworkCount)
    && refs(value.missingFields) && value.missingFields.every(field => HANDOFF_FIELDS.includes(field as typeof HANDOFF_FIELDS[number]))
    && contains(value.capability, ["sufficient", "insufficient", "unknown"]) && refs(value.evidenceRefs)
    && contains(value.source, ["external_checker", "user", "member_report"])
    && (value.check === "unverified" || (value.source !== "member_report" && value.evidenceRefs.length > 0))
    && (value.source !== "member_report" || value.capability === "unknown");
}

const BASE_KEYS = ["schemaVersion", "factId", "scope", "recordedAt", "kind"];

export function isCollaborationFact(value: unknown): value is CollaborationFact {
  if (!row(value) || value.schemaVersion !== 1 || !text(value.factId) || !localScope(value.scope)
    || !text(value.recordedAt) || !Number.isFinite(Date.parse(value.recordedAt))) return false;
  switch (value.kind) {
    case "episode":
      return exact(value, [...BASE_KEYS, "context", "assignmentRef", "handoff", "result"])
        && isCollaborationContext(value.context) && value.context.scope === value.scope && text(value.assignmentRef)
        && (value.handoff === undefined || isSubagentHandoff(value.handoff)) && isCollaborationResult(value.result);
    case "fielding":
      return exact(value, [...BASE_KEYS, "context", "versionId", "proposalId", "requestId", "correctionIds"])
        && isCollaborationContext(value.context) && value.context.scope === value.scope && text(value.versionId)
        && text(value.proposalId) && text(value.requestId) && refs(value.correctionIds);
    case "outcome":
      return exact(value, [...BASE_KEYS, "fieldingId", "result"]) && text(value.fieldingId) && isCollaborationResult(value.result);
    case "correction":
      return exact(value, [...BASE_KEYS, "targetVersionId", "appliesTo", "action", "evidenceRef"])
        && text(value.targetVersionId) && isCorrectionScope(value.appliesTo)
        && contains(value.action, ["skip", "require_evidence"]) && text(value.evidenceRef);
    case "diagnosis":
      return exact(value, [...BASE_KEYS, "subjectFactId", "diagnosis", "versionId"])
        && text(value.subjectFactId) && contains(value.diagnosis, ["coordination", "member_capability", "unverified", "not_applicable", "supports"])
        && (value.versionId === undefined || text(value.versionId));
    default:
      return false;
  }
}

function isCorrectionScope(value: unknown): boolean {
  if (!row(value)) return false;
  switch (value.kind) {
    case "once": return exact(value, ["kind", "taskId"]) && text(value.taskId);
    case "class": return exact(value, ["kind", "dependency", "role"])
      && contains(value.dependency, ["artifact", "independent"]) && text(value.role);
    case "longterm": return exact(value, ["kind"]);
    default: return false;
  }
}

export function isCollaborationPractice(value: unknown): value is CollaborationPractice {
  return row(value) && exact(value, ["schema", "object", "problem", "dependency", "requiredFields", "sourceEpisodeIds", "sourceOutcomeIds"])
    && value.schema === "collaboration-practice/v1" && value.object === "handoff"
    && value.problem === "handoff_missing_context" && value.dependency === "artifact"
    && refs(value.requiredFields) && value.requiredFields.length > 0
    && value.requiredFields.every(field => HANDOFF_FIELDS.includes(field as typeof HANDOFF_FIELDS[number]))
    && refs(value.sourceEpisodeIds) && value.sourceEpisodeIds.length > 0 && refs(value.sourceOutcomeIds);
}
