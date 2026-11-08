import type { JsonValue } from "../../protocol/envelope.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../learning/control/coordination-contract.js";
import type { ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { fields, text } from "../../validation/json-shape.js";

export interface NativeFeedbackUnitPublicView {
  readonly schemaVersion: 1;
  readonly role: "unit_public_view";
  readonly domain: ContentDomainFeedbackChange["domain"];
  readonly issueId: string;
  readonly factRef: string;
  readonly unitRef: string;
  readonly revisionRef: string;
  readonly changeKind: ContentDomainFeedbackChange["kind"];
  readonly recordKind: string;
  readonly payload: JsonValue;
}

const reference = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);

function json(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;

  if (value === null || typeof value === "string" || typeof value === "boolean") return true;

  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every(item => json(item, depth + 1));

  if (typeof value !== "object" || value === null) return false;

  const prototype = Object.getPrototypeOf(value);

  return (prototype === null || prototype === Object.prototype) && Reflect.ownKeys(value).length === Object.keys(value).length
    && Object.keys(value).every(key => Object.getOwnPropertyDescriptor(value, key)?.get === undefined && json(Reflect.get(value, key), depth + 1));
}

export function isNativeFeedbackUnitPublicView(value: unknown): value is NativeFeedbackUnitPublicView {
  return fields(value, ["schemaVersion", "role", "domain", "issueId", "factRef", "unitRef", "revisionRef", "changeKind", "recordKind", "payload"])
    && value.schemaVersion === 1 && value.role === "unit_public_view"
    && CENTRAL_LEARNING_AGENT_DOMAINS.some(domain => domain === value.domain)
    && ["delivery", "adoption", "quality", "correction", "approval", "dependency"].includes(String(value.changeKind))
    && reference(value.issueId) && reference(value.factRef) && reference(value.unitRef) && reference(value.revisionRef)
    && reference(value.recordKind) && json(value.payload);
}

/** Preserve only the selected original payload and its fixed owner identity.
 * Frame heads, selectors and lesson context cannot change this public unit. */
export function createNativeFeedbackUnitPublicView(change: ContentDomainFeedbackChange, recordKind: string,
  payload: JsonValue): NativeFeedbackUnitPublicView {
  const value: NativeFeedbackUnitPublicView = { schemaVersion: 1, role: "unit_public_view", domain: change.domain,
    issueId: change.issueId, factRef: change.factRef, unitRef: change.unitRef, revisionRef: change.revisionRef,
    changeKind: change.kind, recordKind, payload };
  if (!isNativeFeedbackUnitPublicView(value)) throw new Error("native_feedback_unit_public_view_invalid");
  return value;
}
