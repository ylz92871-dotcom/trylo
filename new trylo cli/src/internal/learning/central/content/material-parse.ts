import { LEARNING_DOMAINS } from "../../control/contracts.js";
import { isLearningIssue } from "../../control/coordination-parse.js";
import { TOPIC_EVIDENCE_ORIGINS } from "../../domains/shared/topics/contracts.js";
import { fields, list, sequence, text } from "../../../validation/json-shape.js";
import { CONTENT_MATERIAL_FAILURES, CONTENT_MATERIAL_LIMITS as limits } from "./material-contract.js";
import type { ContentArtifactRef, ContentEvidenceRecord, ContentKnownAnswer, ContentLinks, ContentMaterial, ContentSourceAlias,
  ContentMaterialBatch, ContentMaterialResult, ContentPacketInput, ContentRequirement, ContentRetrievalQuery } from "./material-contract.js";

type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
const strings = (value: unknown, maximum: number = limits.refs): value is string[] =>
  list(value, 0, maximum) && value.every(id) && new Set(value).size === value.length;
export const isContentReferences = strings;
const statements = (value: unknown): value is string[] => list(value, 0, 32) && value.every(item => text(item, limits.statementChars));

export function isContentArtifactRef(value: unknown): value is ContentArtifactRef {
  return fields(value, ["id", "version"]) && id(value.id) && id(value.version);
}

function artifacts(value: unknown): value is ContentArtifactRef[] {
  return list(value, 0, 32) && value.every(isContentArtifactRef)
    && new Set(value.map(item => JSON.stringify([item.id, item.version]))).size === value.length;
}

function isLinks(value: unknown): value is ContentLinks {
  return fields(value, ["issueIds", "topicIds", "artifactRefs"]) && strings(value.issueIds)
    && strings(value.topicIds) && artifacts(value.artifactRefs);
}

export function isContentRecord(value: unknown): value is ContentEvidenceRecord {
  return fields(value, ["ref", "runId", "sequence", "scope", "origin", "text"])
    && id(value.ref) && id(value.runId) && id(value.scope) && sequence(value.sequence)
    && TOPIC_EVIDENCE_ORIGINS.some(origin => origin === value.origin) && text(value.text, limits.recordChars);
}

function isRequirement(value: unknown): value is ContentRequirement {
  return fields(value, ["id", "requirement", "conditions", "answerRequirement", "sourceRefs"])
    && id(value.id) && text(value.requirement, limits.statementChars) && statements(value.conditions)
    && text(value.answerRequirement, limits.statementChars) && strings(value.sourceRefs);
}

function isAnswer(value: unknown): value is ContentKnownAnswer {
  return fields(value, ["answerId", "question", "requirement", "answer", "conditions", "supportRefs", "artifactRefs"])
    && id(value.answerId) && [value.question, value.requirement, value.answer].every(item => text(item, limits.statementChars))
    && statements(value.conditions) && strings(value.supportRefs) && artifacts(value.artifactRefs);
}

function isMaterial(value: unknown): value is ContentMaterial {
  return fields(value, ["id", "kind", "subsystem", "context", "recordRefs", "requirementIds", "answerIds", "links"])
    && id(value.id) && ["requirement", "experience", "known_answer", "context", "feedback"].includes(String(value.kind))
    && ["method", "tool", "workflow", "skill", "collaboration"].includes(String(value.subsystem))
    && text(value.context, limits.statementChars) && strings(value.recordRefs)
    && strings(value.requirementIds, limits.requirements) && strings(value.answerIds, limits.answers) && isLinks(value.links);
}

function isSourceAlias(value: unknown): value is ContentSourceAlias {
  return fields(value, ["ref", "recordRefs"]) && id(value.ref)
    && list(value.recordRefs, 1, limits.records) && value.recordRefs.every(id) && new Set(value.recordRefs).size === value.recordRefs.length;
}

export function isContentBatch(value: unknown): value is ContentMaterialBatch {
  return row(value) && list(value.records, 0, limits.records) && value.records.every(isContentRecord)
    && list(value.requirements, 0, limits.requirements) && value.requirements.every(isRequirement)
    && list(value.answers, 0, limits.answers) && value.answers.every(isAnswer)
    && list(value.materials, 0, limits.materials) && value.materials.every(isMaterial)
    && (!("aliases" in value) || Object.hasOwn(value, "aliases") && list(value.aliases, 0, limits.refs) && value.aliases.every(isSourceAlias));
}

export function isContentPacketInput(value: unknown): value is ContentPacketInput {
  return row(value) && fields(value, ["scope", "domain", "boardSequence", "records", "requirements", "answers", "materials",
    ...("focus" in value ? ["focus"] : []), ...("requestedRefs" in value ? ["requestedRefs"] : []),
    ...(Object.hasOwn(value, "aliases") ? ["aliases"] : [])])
    && id(value.scope) && LEARNING_DOMAINS.some(domain => domain === value.domain) && sequence(value.boardSequence)
    && (!("focus" in value) || isLearningIssue(value.focus))
    && (!("requestedRefs" in value) || strings(value.requestedRefs)) && isContentBatch(value);
}

export function isContentRetrievalQuery(value: unknown): value is ContentRetrievalQuery {
  return fields(value, ["scope", "domain", "boardSequence", "issueIds", "topicIds", "artifactRefs", "sourceRefs"])
    && id(value.scope) && LEARNING_DOMAINS.some(domain => domain === value.domain) && sequence(value.boardSequence)
    && strings(value.issueIds) && strings(value.topicIds) && artifacts(value.artifactRefs) && strings(value.sourceRefs);
}

export function isContentSourceResult(value: unknown): value is ContentMaterialResult<ContentMaterialBatch> {
  return fields(value, ["ok", "value"]) && value.ok === true && isContentBatch(value.value)
    || fields(value, ["ok", "reason"]) && value.ok === false && CONTENT_MATERIAL_FAILURES.some(reason => reason === value.reason);
}
