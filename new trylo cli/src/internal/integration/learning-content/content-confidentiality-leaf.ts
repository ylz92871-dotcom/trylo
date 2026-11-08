import { redactText } from "../../credentials/redact.js";
import { redactSecretShapes } from "../../protocol/redact.js";

/** The original credential policies apply to all leaves, including decoded host metadata. */
export function isContentValueCredentialSafe(value: unknown, secrets: readonly string[]): boolean {
  const pending: unknown[] = [value], seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (redactText(current, secrets) !== current || redactSecretShapes(current) !== current) return false;
    } else if (current !== null && typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) pending.push(...current);
      else for (const [key, member] of Object.entries(current)) pending.push(key, member);
    }
  }

  return true;
}
