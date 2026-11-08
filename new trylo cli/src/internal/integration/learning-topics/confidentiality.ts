import { redactText } from "../../credentials/redact.js";
import { redactJsonValue, redactSecretShapes } from "../../protocol/redact.js";
import type { TopicEvidenceWindow } from "../../learning/domains/shared/topics/contracts.js";

/** Check parsed data against the existing host redactors without changing a question or its evidence identity. */
export function isRedactedTopicData(value: unknown, secrets: readonly string[]): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (redactJsonValue(redactText(current, secrets)) !== current) return false;
    } else if (Array.isArray(current)) pending.push(...current);
    else if (current !== null && typeof current === "object") {
      for (const [key, member] of Object.entries(current)) pending.push(key, member);
    }
  }

  return true;
}

/** An already parsed window can carry the owner's canonical workspace identity.
 * Its evidence text and every other value retain the original confidentiality policy. */
export function isRedactedCanonicalTopicWindow(window: TopicEvidenceWindow, scope: string, secrets: readonly string[]): boolean {
  return window.scope === scope && window.records.every(record => record.scope === scope)
    && isRedactedTopicData({ ...window, scope: "[canonical_scope]",
      records: window.records.map(record => ({ ...record, scope: "[canonical_scope]" })) }, secrets)
    && redactText(scope, secrets) === scope && redactSecretShapes(scope) === scope;
}
