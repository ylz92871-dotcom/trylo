import { fields, identity, list, sequence, text } from "../../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { organizationEvidenceReadRef, organizationKnowledgeHeadReadRef, readOrganizationEvidenceRef } from "./addresses.js";
import type { OrganizationExperienceUse, OrganizationFeedback, OrganizationKnowledge, OrganizationRecord, OrganizationRecallPacket,
  OrganizationRecallQuery } from "./contracts.js";

const ref = (value: unknown) => text(value, 512) && !/[\u0000-\u001f]/.test(value);
export const organizationRefs = (value: unknown, minimum = 0): value is string[] =>
  list(value, minimum, 64) && value.every(ref) && new Set(value).size === value.length;
const prose = (value: unknown) => text(value, 4096);
const statements = (value: unknown): value is string[] => list(value, 0, 32) && value.every(prose);
const keys = (value: unknown): value is string[] => list(value, 0, 32) && value.every(identity) && new Set(value).size === value.length;
const owns = (value: unknown, key: string) => typeof value === "object" && value !== null && Object.hasOwn(value, key);

export function isOrganizationRecallQuery(value: unknown): value is OrganizationRecallQuery {
  return fields(value, ["purpose", "conditionKeys", "sourceRefs", "maximumEntries", "maximumCharacters",
    ...(owns(value, "offset") ? ["offset"] : [])])
    && prose(value.purpose) && keys(value.conditionKeys) && organizationRefs(value.sourceRefs)
    && sequence(value.maximumEntries) && value.maximumEntries >= 1 && value.maximumEntries <= 8
    && sequence(value.maximumCharacters) && value.maximumCharacters >= 512 && value.maximumCharacters <= 32768
    && (!owns(value, "offset") || sequence(value.offset) && value.offset <= 4096);
}

export function isOrganizationKnowledge(value: unknown): value is OrganizationKnowledge {
  return fields(value, ["kind", "knowledgeId", "supersedes", "statement", "conditions", "conditionKeys", "exceptions",
    "exceptionKeys", "implication", "supportFactIds", "counterexampleFactIds", "state"])
    && value.kind === "knowledge" && identity(value.knowledgeId) && (value.supersedes === null || identity(value.supersedes))
    && prose(value.statement) && prose(value.conditions) && keys(value.conditionKeys) && prose(value.exceptions)
    && keys(value.exceptionKeys) && prose(value.implication) && organizationRefs(value.supportFactIds, 1)
    && organizationRefs(value.counterexampleFactIds) && ["proposed", "revised", "withdrawn"].includes(String(value.state));
}

function feedbackResult(value: unknown): boolean {
  if (fields(value, ["kind", "usage"]) && value.kind === "cost") {
    const usage = value.usage;
    return fields(usage, ["kind", "reason"]) && usage.kind === "unknown" && prose(usage.reason)
      || fields(usage, ["kind", "tokens", "calls", "steps"]) && usage.kind === "reported"
        && sequence(usage.tokens) && sequence(usage.calls) && sequence(usage.steps);
  }

  if (fields(value, ["kind", "summary", "remaining", "resultRefs"]) && value.kind === "progress") {
    return prose(value.summary) && statements(value.remaining) && organizationRefs(value.resultRefs);
  }

  if (fields(value, ["kind", "state", "artifactRefs", "exposureRef"]) && value.kind === "adoption") {
    return ["not_observed", "used", "withdrawn"].includes(String(value.state)) && organizationRefs(value.artifactRefs)
      && (value.exposureRef === null || ref(value.exposureRef))
      && (value.state !== "used" || value.exposureRef !== null && value.artifactRefs.length > 0);
  }

  if (fields(value, ["kind", "state", "summary", "exposureRef", "attribution"]) && value.kind === "outcome") {
    return ["pending", "observed", "unknown"].includes(String(value.state)) && prose(value.summary)
      && (value.exposureRef === null || ref(value.exposureRef))
      && ["unknown", "source_reported"].includes(String(value.attribution))
      && (value.state !== "observed" || value.exposureRef !== null)
      && (value.state === "observed" || value.attribution === "unknown");
  }

  return fields(value, ["kind", "statement", "conditions"]) && value.kind === "correction"
    && prose(value.statement) && prose(value.conditions);
}

export function isOrganizationFeedback(value: unknown): value is OrganizationFeedback {
  return fields(value, ["kind", "decisionRef", "unitRef", "supersedes", "sourceRefs", "result"])
    && value.kind === "feedback" && identity(value.decisionRef) && ref(value.unitRef)
    && (value.supersedes === null || identity(value.supersedes)) && organizationRefs(value.sourceRefs, 1)
    && !value.sourceRefs.some(item => item.startsWith("organization-record:") || item.startsWith("organization-recall:"))
    && feedbackResult(value.result);
}

function isOrganizationRecallPacketV1(value: unknown): value is OrganizationRecallPacket {
  return fields(value, ["schemaVersion", "scope", "recallRef", "query", "entries", "materialJson", "interpretation",
    ...(owns(value, "navigation") ? ["navigation"] : [])])
    && value.schemaVersion === 1 && text(value.scope, 4096) && identity(value.recallRef) && isOrganizationRecallQuery(value.query)
    && list(value.entries, 0, 8) && value.entries.every(entry => fields(entry,
      ["factId", "knowledge", "matchedConditions", "missingConditions", "matchedExceptions", "evidence", "evidenceRevisions"])
      && identity(entry.factId) && isOrganizationKnowledge(entry.knowledge) && keys(entry.matchedConditions)
      && keys(entry.missingConditions) && keys(entry.matchedExceptions) && list(entry.evidence, 1, 64)
      && entry.evidence.every(fact => fields(fact, ["factId", "sequence", "value"]) && identity(fact.factId)
        && sequence(fact.sequence) && isOrganizationFeedback(fact.value))
      && list(entry.evidenceRevisions, 0, 64) && entry.evidenceRevisions.every(revision =>
        fields(revision, ["citedFactId", "effectiveFactId"]) && identity(revision.citedFactId) && identity(revision.effectiveFactId)))
    && typeof value.materialJson === "string" && value.materialJson.length <= value.query.maximumCharacters
    && value.interpretation === "organization_hypotheses_not_business_evidence"
    && (!owns(value, "navigation") || fields(value.navigation, ["remainingEntries", "nextQuery"])
      && sequence(value.navigation.remainingEntries)
      && (value.navigation.nextQuery === null || isOrganizationRecallQuery(value.navigation.nextQuery)));
}

function evidenceCoverage(value: unknown, factId: string, delivered: number): boolean {
  if (!fields(value, ["asOfSequence", "total", "delivered", "unread", "citedSupportCount",
    "citedCounterexampleCount", "relatedCount", "readRef", "unreadByKind", "priorityReadRef", "interpretation"])
    || !sequence(value.asOfSequence) || !sequence(value.total) || !sequence(value.delivered) || !sequence(value.unread)
    || !sequence(value.citedSupportCount) || !sequence(value.citedCounterexampleCount) || !sequence(value.relatedCount)
    || value.delivered !== delivered || value.total !== value.delivered + value.unread
    || !fields(value.unreadByKind, ["progress", "cost", "adoption", "outcome", "correction"])
    || !sequence(value.unreadByKind.progress) || !sequence(value.unreadByKind.cost) || !sequence(value.unreadByKind.adoption)
    || !sequence(value.unreadByKind.outcome) || !sequence(value.unreadByKind.correction)
    || value.unreadByKind.progress + value.unreadByKind.cost + value.unreadByKind.adoption
      + value.unreadByKind.outcome + value.unreadByKind.correction !== value.unread
    || value.interpretation !== "unread_is_unknown_adoption_is_exposure_not_validation") return false;
  try {
    const priority = value.priorityReadRef === null ? null : typeof value.priorityReadRef === "string" ? readOrganizationEvidenceRef(value.priorityReadRef) : undefined;
    return value.readRef === organizationEvidenceReadRef(factId, value.asOfSequence)
      && (priority === null || priority !== undefined && priority.factId === factId
        && priority.asOfSequence === value.asOfSequence && priority.offset < value.total);
  } catch { return false; }
}

function recallEntryV2(value: unknown): boolean {
  return fields(value, ["factId", "knowledge", "matchedConditions", "missingConditions", "matchedExceptions",
    "evidence", "evidenceRevisions", "evidenceCoverage"])
    && identity(value.factId) && isOrganizationKnowledge(value.knowledge) && keys(value.matchedConditions)
    && keys(value.missingConditions) && keys(value.matchedExceptions) && list(value.evidence, 0, 64)
    && value.evidence.every(fact => fields(fact, ["factId", "sequence", "value"]) && identity(fact.factId)
      && sequence(fact.sequence) && isOrganizationFeedback(fact.value))
    && list(value.evidenceRevisions, 0, 64) && value.evidenceRevisions.every(revision =>
      fields(revision, ["citedFactId", "effectiveFactId"]) && identity(revision.citedFactId) && identity(revision.effectiveFactId))
    && evidenceCoverage(value.evidenceCoverage, value.factId, value.evidence.length);
}

function knowledgeBodyRequired(value: unknown): boolean {
  if (!fields(value, ["factId", "knowledgeId", "readRef", "originalCharacters", "reason"])
    || !identity(value.factId) || !identity(value.knowledgeId) || !sequence(value.originalCharacters)
    || value.originalCharacters === 0 || value.reason !== "knowledge_body_required_not_delivered") return false;
  try { return value.readRef === organizationKnowledgeHeadReadRef(value.factId); } catch { return false; }
}

function isOrganizationRecallPacketV2(value: unknown): value is OrganizationRecallPacket {
  if (!fields(value, ["schemaVersion", "scope", "recallRef", "query", "entries", "materialJson", "interpretation",
    "navigation", "evidencePolicy", "knowledgeBodyRequired"])
    || value.schemaVersion !== 2 || !text(value.scope, 4096) || !identity(value.recallRef) || !isOrganizationRecallQuery(value.query)
    || !list(value.entries, 0, 8) || !value.entries.every(recallEntryV2)
    || typeof value.materialJson !== "string" || value.materialJson.length > value.query.maximumCharacters
    || value.interpretation !== "organization_hypotheses_not_business_evidence"
    || !fields(value.navigation, ["remainingEntries", "nextQuery"]) || !sequence(value.navigation.remainingEntries)
    || value.navigation.nextQuery !== null && !isOrganizationRecallQuery(value.navigation.nextQuery)
    || value.evidencePolicy !== "bounded_current_source_heads_v2" || !list(value.knowledgeBodyRequired, 0, 8)
    || !value.knowledgeBodyRequired.every(knowledgeBodyRequired)) return false;

  let body: unknown;

  try { body = JSON.parse(value.materialJson); } catch { return false; }

  if (!fields(body, ["schemaVersion", "role", "entries", "navigation", "omittedForCapacity", "knowledgeBodyRequired",
    "evidencePolicy", "costInterpretation", "retrievalGuidance"])
    || body.schemaVersion !== 2 || body.role !== value.interpretation || !sequence(body.omittedForCapacity)
    || !prose(body.costInterpretation) || body.retrievalGuidance !== null && !prose(body.retrievalGuidance)
    || body.evidencePolicy !== value.evidencePolicy || canonicalJson(body.entries) !== canonicalJson(value.entries)
    || canonicalJson(body.navigation) !== canonicalJson(value.navigation)
    || canonicalJson(body.knowledgeBodyRequired) !== canonicalJson(value.knowledgeBodyRequired)
    || canonicalJson(body) !== value.materialJson) return false;

  return value.recallRef === `organization-recall:${contentHashOf({ scope: value.scope, query: value.query, materialJson: value.materialJson })}`;
}

export function isOrganizationRecallPacket(value: unknown): value is OrganizationRecallPacket {
  // Historical packet rules deliberately remain separate, including both V1
  // navigation shapes. Only explicit V2 data receives the new delivery contract.
  return isOrganizationRecallPacketV1(value) || isOrganizationRecallPacketV2(value);
}

export function isOrganizationExperienceChanges(value: unknown): value is OrganizationExperienceUse["changes"] {
  return list(value, 0, 8) && value.every(change => fields(change, ["knowledgeFactId", "choice", "before", "after", "reason"])
      && identity(change.knowledgeFactId) && ["program", "investment", "timing", "wait", "unchanged"].includes(String(change.choice))
      && prose(change.before) && prose(change.after) && prose(change.reason));
}

function experienceUse(value: unknown): boolean {
  return value === null || fields(value, ["packet", "deliveryRef", "changes"])
    && isOrganizationRecallPacket(value.packet) && ref(value.deliveryRef) && isOrganizationExperienceChanges(value.changes);
}

export function isOrganizationRecord(value: unknown): value is OrganizationRecord {
  if (isOrganizationKnowledge(value) || isOrganizationFeedback(value)) return true;
  return fields(value, ["kind", "decisionRef", "purposeRef", "context", "program", "expectation", "alternatives", "issueRefs", "stageRefs", "sourceRefs", "experienceUse"])
    && value.kind === "decision" && identity(value.decisionRef) && identity(value.purposeRef)
    && fields(value.context, ["purpose", "conditionKeys", "known", "residual"]) && prose(value.context.purpose)
    && keys(value.context.conditionKeys) && statements(value.context.known) && statements(value.context.residual)
    && fields(value.program, ["programRef", "depth", "timing"]) && ref(value.program.programRef) && prose(value.program.depth)
    && ["now", "defer", "wait", "stop"].includes(String(value.program.timing))
    && fields(value.expectation, ["change", "uncertainties"]) && prose(value.expectation.change) && statements(value.expectation.uncertainties)
    && statements(value.alternatives) && organizationRefs(value.issueRefs) && organizationRefs(value.stageRefs) && organizationRefs(value.sourceRefs, 1)
    && experienceUse(value.experienceUse);
}
