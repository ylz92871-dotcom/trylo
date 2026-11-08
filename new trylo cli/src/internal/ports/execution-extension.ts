import type { JsonObject } from "../protocol/envelope.js";

/** Immutable per-session extension configuration. Extensions can describe an
 * adopted execution plan, never replace the session's execution/effect owner.
 * Additive in journal v1; no record means the extension was never adopted.
 */
export type ExecutionExtensionMetadata = {
  readonly schemaVersion: 1;
  readonly owner: string;
  readonly instanceId: string;
  readonly configuration: JsonObject;
};

export function isExecutionExtensionMetadata(value: unknown): value is ExecutionExtensionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && typeof item.owner === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(item.owner)
    && typeof item.instanceId === "string" && item.instanceId.length > 0 && item.instanceId.length <= 256
    && typeof item.configuration === "object" && item.configuration !== null && !Array.isArray(item.configuration);
}
