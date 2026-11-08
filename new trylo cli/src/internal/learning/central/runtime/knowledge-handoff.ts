import { fields, identity, list, text } from "../../../validation/json-shape.js";
import type { CentralKnowledgeHandoffDecision } from "./contracts.js";

export const CENTRAL_KNOWLEDGE_HANDOFF_LIMIT = 16;

function publish(value: unknown): boolean {
  return fields(value, ["kind", "intentId", "knowledgeHash", "whenRelevant", "uncertainty"])
    && Reflect.ownKeys(value).length === 5 && value.kind === "publish"
    && identity(value.intentId) && typeof value.knowledgeHash === "string" && /^[a-f0-9]{64}$/.test(value.knowledgeHash)
    && text(value.whenRelevant, 8192) && text(value.uncertainty, 8192);
}

function withdraw(value: unknown): boolean {
  return fields(value, ["kind", "publicationRef", "why"]) && Reflect.ownKeys(value).length === 3
    && value.kind === "withdraw" && identity(value.publicationRef) && text(value.why, 8192);
}

export function isCentralKnowledgeHandoffDecision(value: unknown): value is CentralKnowledgeHandoffDecision {
  return publish(value) || withdraw(value);
}

export function isCentralKnowledgeHandoffs(value: unknown): value is readonly CentralKnowledgeHandoffDecision[] {
  if (!list(value, 1, CENTRAL_KNOWLEDGE_HANDOFF_LIMIT) || Reflect.ownKeys(value).length !== value.length + 1
    || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
    || !value.every(isCentralKnowledgeHandoffDecision)) return false;
  const identities = value.map(row => row.kind === "publish" ? `publish:${row.intentId}:${row.knowledgeHash}` : `withdraw:${row.publicationRef}`);
  return new Set(identities).size === identities.length;
}
