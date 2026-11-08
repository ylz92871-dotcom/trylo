import { fields, hasOnlyUnicodeScalars, identity, list, sequence, text } from "../../../validation/json-shape.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../control/coordination-contract.js";
import { COORDINATION_DECISION_LIMITS, isCentralLearningAllowance } from "../../control/coordination-parse.js";
import { isOrganizationExperienceChanges, isOrganizationKnowledge } from "../organization/validation.js";
import { isCentralThinkMaxOutputTokens } from "./generation.js";
import { isCentralKnowledgeHandoffs } from "./knowledge-handoff.js";
import type { CentralAgendaRead, CentralCompletedOperation, CentralDeliberationOutput, CentralLearningIntentDraft, CentralLearningOperation,
  CentralLearningRuntimeState, CentralLearningSubject, CentralRuntimeMaterial, CentralRuntimeWork } from "./contracts.js";

/** Serialization capacities only. They do not rank goals, judge truth or determine when to learn. */
export const CENTRAL_RUNTIME_LIMITS = Object.freeze({ intents: 128, completed: 256, running: 128, materials: 256,
  references: 256, statements: 64, knowledge: 64, textChars: 32768, jsonChars: 131072, jsonDepth: 32 });

export function isCentralThoughtMaxTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
}

const limits = CENTRAL_RUNTIME_LIMITS;
const reference = (value: unknown): value is string => text(value, COORDINATION_DECISION_LIMITS.sourceRefMaxChars) && !/[\u0000-\u001f]/.test(value);
const ids = (value: unknown, maximum = limits.references): value is string[] => list(value, 0, maximum)
  && value.every(reference) && new Set(value).size === value.length;
export const isCentralRuntimeReferences = ids;
const scalarText = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum
  && hasOnlyUnicodeScalars(value);
const prose = (value: unknown): value is string => scalarText(value, limits.textChars);
const statements = (value: unknown): value is string[] => list(value, 0, limits.statements) && value.every(prose);
const fitsJson = (value: unknown): boolean => JSON.stringify(value).length <= limits.jsonChars;

function json(value: unknown, depth = 0): boolean {
  if (depth > limits.jsonDepth) return false;

  if (value === null || typeof value === "boolean") return true;

  // Domain-owned frames may contain a serialized, validated public context.
  // Their whole opaque envelope remains bounded independently of public prose.
  if (typeof value === "string") return scalarText(value, limits.jsonChars);

  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) return value.length <= limits.references && value.every(item => json(item, depth + 1));

  if (typeof value !== "object" || value === null) return false;

  const prototype = Object.getPrototypeOf(value);

  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length
    && Object.keys(value).length <= limits.references && Object.values(value).every(item => json(item, depth + 1));
}

export function isCentralLearningSubject(value: unknown): value is CentralLearningSubject {
  return fields(value, ["plane", "domain", "issueId"]) && value.plane === "agent"
    && CENTRAL_LEARNING_AGENT_DOMAINS.some(domain => domain === value.domain) && reference(value.issueId)
    || fields(value, ["plane", "ledgerRef", "questionRef"]) && value.plane === "user"
      && reference(value.ledgerRef) && reference(value.questionRef)
    || fields(value, ["plane", "questionRef"]) && value.plane === "central" && reference(value.questionRef);
}

export function isCentralRuntimeMaterial(value: unknown): value is CentralRuntimeMaterial {
  return fields(value, ["ref", "kind", "text", "sourceRefs"]) && reference(value.ref) && prose(value.text) && ids(value.sourceRefs)
    && ["source", "knowledge", "feedback", "organization", "numerical_advice", "work_result"].some(kind => kind === value.kind);
}

function operationShape(value: unknown): value is CentralLearningOperation {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;

  const keys = ["kind", "operationId", "purpose", "expectedChange", "sourceRefs"];
  if (value.kind === "think" ? !fields(value, [...keys, ...(Object.hasOwn(value, "maxOutputTokens") ? ["maxOutputTokens"] : [])])
    : value.kind === "read" ? !fields(value, [...keys, "refs", "maximumChars"])
      : value.kind === "consult" ? !fields(value, [...keys, "allowance"])
        : value.kind === "dispatch" ? !fields(value, [...keys, "allowance", ...(Object.hasOwn(value, "destination") ? ["destination"] : [])]) : true) return false;

  if (!("operationId" in value) || !("purpose" in value) || !("expectedChange" in value) || !("sourceRefs" in value)
    || !identity(value.operationId) || !prose(value.purpose) || !prose(value.expectedChange) || !ids(value.sourceRefs)) return false;

  if (value.kind === "think" && Object.hasOwn(value, "maxOutputTokens")
    && (!("maxOutputTokens" in value) || !isCentralThinkMaxOutputTokens(value.maxOutputTokens))) return false;

  if (value.kind === "read") return "refs" in value && "maximumChars" in value && ids(value.refs)
    && sequence(value.maximumChars) && value.maximumChars > 0 && value.maximumChars <= limits.jsonChars;

  if (value.kind === "dispatch" && "destination" in value) {
    const destination = value.destination;
    if (!(fields(destination, ["plane"]) && destination.plane === "user"
      || fields(destination, ["plane", "domain"]) && destination.plane === "agent"
        && CENTRAL_LEARNING_AGENT_DOMAINS.some(domain => domain === destination.domain))) return false;
  }

  return value.kind === "think" || "allowance" in value && fields(value.allowance,
    ["schemaVersion", "unit", "maxTokens", "maxCalls", "maxSteps", "maxPromptChars"]) && isCentralLearningAllowance(value.allowance);
}

export function isCentralLearningOperation(value: unknown): value is CentralLearningOperation {
  return operationShape(value) && fitsJson(value);
}

export function isCentralAgendaRead(value: unknown): value is CentralAgendaRead {
  return isCentralLearningOperation(value) && value.kind === "read" && value.refs.length > 0;
}

function isWait(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const keys = ["kind", "sourceRefs", "reason"];
  if (value.kind === "until" ? !fields(value, [...keys, "at"])
    : !["facts", "use_feedback", "resources"].some(kind => kind === value.kind) || !fields(value, keys)) return false;
  return "sourceRefs" in value && ids(value.sourceRefs) && "reason" in value && prose(value.reason)
    && (value.kind !== "until" || "at" in value && sequence(value.at));
}

function isContinuation(value: unknown): boolean {
  return fields(value, ["kind"]) && value.kind === "open"
    || fields(value, ["kind", "operation"]) && value.kind === "ready" && isCentralLearningOperation(value.operation)
    || fields(value, ["kind", "wait"]) && value.kind === "waiting" && isWait(value.wait)
    || fields(value, ["kind", "goalState", "reason"]) && value.kind === "ended" && prose(value.reason)
      && ["open", "answered", "withdrawn"].some(state => state === value.goalState);
}

export function isCentralLearningIntent(value: unknown): value is CentralLearningIntentDraft {
  if (typeof value !== "object" || value === null) return false;

  if (!fields(value, ["intentId", "subject", "goal", "rationale", "conditions", "knowledge", "residual", "commitment",
    "revisionReason", "sourceRefs", "continuation", ...(Object.hasOwn(value, "derivation") ? ["derivation"] : [])]) || !identity(value.intentId) || !isCentralLearningSubject(value.subject)
    || ![value.goal, value.rationale, value.revisionReason].every(prose) || !statements(value.conditions) || !statements(value.residual)
    || !ids(value.sourceRefs) || !isContinuation(value.continuation)) return false;

  if (Object.hasOwn(value, "derivation") && !(fields(value.derivation, ["relation", "whenRelevant", "parentRefs", "citations"])
    && prose(value.derivation.relation) && prose(value.derivation.whenRelevant) && ids(value.derivation.parentRefs)
    && list(value.derivation.citations, 0, 32) && value.derivation.citations.every(citation => fields(citation, ["evidenceRef", "quote"])
      && reference(citation.evidenceRef) && prose(citation.quote)))) return false;

  return list(value.knowledge, 0, limits.knowledge) && value.knowledge.every(item => fields(item, ["statement", "conditions", "sourceRefs"])
    && prose(item.statement) && prose(item.conditions) && ids(item.sourceRefs))
    && fields(value.commitment, ["purpose", "assumptions", "reconsiderWhen"]) && prose(value.commitment.purpose)
    && statements(value.commitment.assumptions) && statements(value.commitment.reconsiderWhen);
}

export function isCentralCompletedOperation(value: unknown): value is CentralCompletedOperation {
  if (typeof value !== "object" || value === null) return false;
  return fields(value, ["intentId", "operation", "outcome", "resultRefs", "publicResult", ...(Object.hasOwn(value, "wait") ? ["wait"] : [])]) && identity(value.intentId)
    && isCentralLearningOperation(value.operation) && ["returned", "failed", "unknown"].some(outcome => outcome === value.outcome)
    && ids(value.resultRefs) && prose(value.publicResult) && (!Object.hasOwn(value, "wait") || isWait(value.wait));
}

export function isCentralRuntimeWork(value: unknown): value is CentralRuntimeWork {
  return fields(value, ["intentId", "operation", "workRef", "frame"]) && identity(value.intentId) && reference(value.workRef)
    && isCentralLearningOperation(value.operation) && value.operation.kind === "dispatch" && typeof value.frame === "object"
    && value.frame !== null && !Array.isArray(value.frame) && json(value.frame) && fitsJson(value);
}

export function isCentralDeliberationOutput(value: unknown): value is CentralDeliberationOutput {
  if (typeof value !== "object" || value === null) return false;

  const optional = ["agendaRead", "alternatives", "organizationUse", "organizationKnowledge", "knowledgeHandoffs"].filter(key => Object.hasOwn(value, key));
  const agendaRead = "agendaRead" in value ? value.agendaRead : undefined;

  return fields(value, ["schemaVersion", "intents", "publicExplanation", "sourceRefs", ...optional]) && value.schemaVersion === 1
    && list(value.intents, 0, limits.intents) && value.intents.every(isCentralLearningIntent)
    && new Set(value.intents.map(item => item.intentId)).size === value.intents.length
    && prose(value.publicExplanation) && ids(value.sourceRefs)
    && (!Object.hasOwn(value, "agendaRead") || isCentralAgendaRead(agendaRead)
      && !value.intents.some(intent => intent.continuation.kind === "ready"
        && intent.continuation.operation.operationId === agendaRead.operationId))
    && (!Object.hasOwn(value, "alternatives") || list(value.alternatives, 0, 32) && value.alternatives.every(item => text(item, 4096)))
    && (!Object.hasOwn(value, "organizationUse") || fields(value.organizationUse, ["recallRef", "changes"])
      && identity(value.organizationUse.recallRef) && isOrganizationExperienceChanges(value.organizationUse.changes))
    && (!Object.hasOwn(value, "organizationKnowledge") || list(value.organizationKnowledge, 0, limits.knowledge)
      && value.organizationKnowledge.every(isOrganizationKnowledge)
      && new Set(value.organizationKnowledge.map(item => item.knowledgeId)).size === value.organizationKnowledge.length)
    && (!Object.hasOwn(value, "knowledgeHandoffs") || isCentralKnowledgeHandoffs(value.knowledgeHandoffs))
    && fitsJson(value);
}

export function isCentralLearningRuntimeState(value: unknown): value is CentralLearningRuntimeState {
  const optional = typeof value === "object" && value !== null && Object.hasOwn(value, "agendaRead") ? ["agendaRead"] : [];
  if (!fields(value, ["schemaVersion", "scope", "intents", "completed", "running", "materials", "consumedSourceRefs", ...optional])
    || value.schemaVersion !== 1 || !identity(value.scope) || !list(value.intents, 0, limits.intents) || !value.intents.every(isCentralLearningIntent)
    || !list(value.completed, 0, limits.completed) || !value.completed.every(isCentralCompletedOperation)
    || !list(value.running, 0, limits.running) || !value.running.every(isCentralRuntimeWork)
    || !list(value.materials, 0, limits.materials) || !value.materials.every(isCentralRuntimeMaterial) || !ids(value.consumedSourceRefs)
    || Object.hasOwn(value, "agendaRead") && !isCentralAgendaRead(value.agendaRead)) return false;

  const operations = [...value.completed, ...value.running].map(item => item.operation.operationId);

  if (isCentralAgendaRead(value.agendaRead)) {
    const pending = value.agendaRead;
    if (value.intents.some(intent => intent.continuation.kind === "ready"
      && intent.continuation.operation.operationId === pending.operationId)) return false;
    operations.push(pending.operationId);
  }

  return new Set(value.intents.map(item => item.intentId)).size === value.intents.length
    && new Set(value.materials.map(item => item.ref)).size === value.materials.length
    && new Set(value.running.map(item => item.workRef)).size === value.running.length
    && new Set(operations).size === operations.length && fitsJson(value);
}
