import type { Envelope } from "./envelope.js";

/** Bounded tool facts only: no arguments, outputs, credentials or reasoning. */
export type SubagentToolActivity =
  | { readonly id: string; readonly kind: "tool"; readonly tool: string }
  | { readonly id: string; readonly kind: "result"; readonly tool?: string; readonly ok: boolean };

export function isSubagentToolActivity(value: unknown): value is SubagentToolActivity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0
    && (row.kind === "tool" ? typeof row.tool === "string" && row.tool.length > 0
      : row.kind === "result" && typeof row.ok === "boolean" && (row.tool === undefined || typeof row.tool === "string"));
}

export function subagentToolActivity(envelope: Envelope): SubagentToolActivity | undefined {
  const payload = envelope.payload;
  const id = payload.toolCallId;
  const tool = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : undefined;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (envelope.kind === "tool_use" && tool !== undefined) return { id, kind: "tool", tool };
  if (envelope.kind === "tool_result") return { id, kind: "result", ...(tool === undefined ? {} : { tool }), ok: payload.status === "succeeded" };
  return undefined;
}
