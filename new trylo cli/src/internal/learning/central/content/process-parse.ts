import { fields, list, text } from "../../../validation/json-shape.js";
import type { ContentPacket } from "./material-contract.js";
import type { ContentApplication, ContentCitation, ContentComparison, ContentKnowledge, ContentRelation,
  ContentResult, KnownApplicationDraft, RelationAssessment, ResidualReviewDraft } from "./process-contract.js";

const statements = (value: unknown): value is string => text(value, 4096);
const identity = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
const refs = (value: unknown): value is string[] => list(value, 0, 32) && value.every(identity) && new Set(value).size === value.length;

function citations(value: unknown): value is ContentCitation[] {
  return list(value, 1, 8) && value.every(row => fields(row, ["evidenceRef", "quote"])
    && identity(row.evidenceRef) && text(row.quote, 256));
}

function knowledge(value: unknown): value is ContentKnowledge {
  return fields(value, ["id", "statement", "conditions", "citations"]) && identity(value.id)
    && statements(value.statement) && statements(value.conditions) && citations(value.citations);
}

function application(value: unknown): value is ContentApplication {
  return fields(value, ["id", "requirementRefs", "answerRefs", "binding", "result", "conditions", "citations"])
    && identity(value.id) && refs(value.requirementRefs) && refs(value.answerRefs)
    && statements(value.binding) && statements(value.result) && statements(value.conditions) && citations(value.citations);
}

function relation(value: unknown): value is ContentRelation {
  return fields(value, ["id", "question", "whenRelevant", "expectedChange", "citations"]) && identity(value.id)
    && text(value.question, 600) && text(value.whenRelevant, 600) && text(value.expectedChange, 600) && citations(value.citations);
}

function known(value: unknown): value is KnownApplicationDraft {
  return fields(value, ["schemaVersion", "knowledge", "applications", "relations", "preparations"])
    && value.schemaVersion === 1 && list(value.knowledge, 0, 16) && value.knowledge.every(knowledge)
    && list(value.applications, 0, 16) && value.applications.every(application)
    && list(value.relations, 0, 16) && value.relations.every(relation)
    && list(value.preparations, 0, 16) && value.preparations.every(row => fields(row, ["description", "sourceRefs"])
      && statements(row.description) && refs(row.sourceRefs));
}

function assessment(value: unknown): value is RelationAssessment {
  return fields(value, ["relationId", "disposition", "applicationIds", "reason"]) && identity(value.relationId)
    && ["answered", "residual", "unsupported"].includes(String(value.disposition)) && refs(value.applicationIds) && statements(value.reason);
}

function comparison(value: unknown): value is ContentComparison {
  return fields(value, ["relationId", "priorRef", "kind", "reason", "citations"])
    && identity(value.relationId) && identity(value.priorRef)
    && ["same_question", "covered", "changed_conditions", "different_target", "undetermined"].includes(String(value.kind))
    && statements(value.reason) && citations(value.citations);
}

function review(value: unknown): value is ResidualReviewDraft {
  if (!fields(value, ["schemaVersion", "assessments", "comparisons", "selectedRelationId", "recommendation"])
    || value.schemaVersion !== 1 || !list(value.assessments, 0, 16) || !value.assessments.every(assessment)
    || !list(value.comparisons, 0, 32) || !value.comparisons.every(comparison)
    || (value.selectedRelationId !== null && !identity(value.selectedRelationId))) return false;

  const row = value.recommendation;

  return fields(row, ["kind", "reason", "citations"]) && ["continue", "revise", "end", "undetermined"].includes(String(row.kind))
    && statements(row.reason) && list(row.citations, 0, 8) && row.citations.every(citation => citations([citation]));
}

function parse<T>(json: string, guard: (value: unknown) => value is T): ContentResult<T> {
  if (typeof json !== "string" || json.length > 65536) return { ok: false, reason: "content_capacity" };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { ok: false, reason: "content_json_invalid" }; }
  return guard(raw) ? { ok: true, value: raw } : { ok: false, reason: "content_shape_invalid" };
}

/** Quotes always refer to the immutable full record, never the catalog or a neighboring source. */
export function validContentCitations(items: readonly ContentCitation[], packet: ContentPacket): boolean {
  return items.every(citation => {
    const record = packet.records.find(row => row.ref === citation.evidenceRef);
    if (record === undefined) return false;
    const start = record.text.indexOf(citation.quote);
    return start >= 0 && record.text.indexOf(citation.quote, start + 1) === -1;
  });
}

export function readKnownApplication(json: string, packet: ContentPacket): ContentResult<KnownApplicationDraft> {
  const parsed = parse(json, known);
  if (!parsed.ok) return parsed;

  const value = parsed.value;

  for (const group of [value.knowledge, value.applications, value.relations]) {
    if (new Set(group.map(row => row.id)).size !== group.length) return { ok: false, reason: "content_reference_invalid" };
    if (group.some(row => !validContentCitations(row.citations, packet))) return { ok: false, reason: "content_quote_invalid" };
  }

  const visible = new Set(packet.records.map(row => row.ref));

  // Semantic application is the domain model's responsibility; these checks prove only that it used visible identities.
  if (value.applications.some(row => [...row.requirementRefs, ...row.answerRefs].some(ref => !visible.has(ref)))
    || value.preparations.some(row => row.sourceRefs.some(ref => !visible.has(ref)))) return { ok: false, reason: "content_reference_invalid" };

  return parsed;
}

export function readResidualReview(json: string, packet: ContentPacket, applied: KnownApplicationDraft): ContentResult<ResidualReviewDraft> {
  const parsed = parse(json, review);
  if (!parsed.ok) return parsed;

  const value = parsed.value, ids = new Set(applied.relations.map(row => row.id));
  const applicationIds = new Set(applied.applications.map(row => row.id));

  if (value.assessments.length !== ids.size || new Set(value.assessments.map(row => row.relationId)).size !== ids.size
    || value.assessments.some(row => !ids.has(row.relationId))) return { ok: false, reason: "content_review_incomplete" };

  if (value.assessments.some(row => row.applicationIds.some(id => !applicationIds.has(id))
    || (row.disposition === "answered" && row.applicationIds.length === 0))) return { ok: false, reason: "content_reference_invalid" };

  const visible = new Set(packet.records.map(row => row.ref));
  if (value.comparisons.some(row => !ids.has(row.relationId) || !visible.has(row.priorRef)
    || (row.kind === "covered" && !value.assessments.some(item => item.relationId === row.relationId && item.disposition === "answered")))) {
    return { ok: false, reason: "content_reference_invalid" };
  }

  if (value.comparisons.some(row => !validContentCitations(row.citations, packet))
    || !validContentCitations(value.recommendation.citations, packet)) return { ok: false, reason: "content_quote_invalid" };

  if (value.selectedRelationId !== null && !value.assessments.some(row => row.relationId === value.selectedRelationId && row.disposition === "residual")) {
    return { ok: false, reason: "content_selection_invalid" };
  }

  return parsed;
}
