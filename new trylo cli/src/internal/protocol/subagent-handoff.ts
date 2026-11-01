import type { JsonObject } from "./envelope.js";

export type SubagentHandoff = { readonly scope: string; readonly artifacts: readonly string[]; readonly evidence: readonly string[];
  readonly pending: readonly string[]; readonly blockers: readonly string[] };
export type SubagentDelivery = { readonly submissionId: string; readonly parentToolCallId: string;
  readonly state: "started" | "answered"; readonly round: number };

export function isSubagentDelivery(value: unknown): value is SubagentDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.submissionId === "string" && row.submissionId.length > 0 && row.submissionId.length <= 1024
    && typeof row.parentToolCallId === "string" && row.parentToolCallId.length > 0 && row.parentToolCallId.length <= 1024
    && (row.state === "started" || row.state === "answered") && Number.isSafeInteger(row.round) && Number(row.round) > 0;
}

export function isSubagentHandoff(value: unknown): value is SubagentHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 5 && typeof row.scope === "string" && row.scope.trim().length > 0 && row.scope.length <= 4000
    && ["artifacts", "evidence", "pending", "blockers"].every(key => Array.isArray(row[key]) && row[key].length <= 16
      && row[key].every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 1000))
    && Buffer.byteLength(JSON.stringify(row), "utf8") <= 16000;
}

const refs: JsonObject = { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1000 } };
export const HANDOFF_SCHEMA: JsonObject = { type: "object", additionalProperties: false, properties: {
  scope: { type: "string", minLength: 1, maxLength: 4000 }, artifacts: refs, evidence: refs, pending: refs, blockers: refs,
}, required: ["scope", "artifacts", "evidence", "pending", "blockers"] };

/** References are supplied context, never authority to expand the assigned scope. */
export function handoffMessage(message: string, handoff: SubagentHandoff): string {
  const items = (values: readonly string[]): string => values.length === 0 ? "无" : values.map(value => `- ${value}`).join("\n");
  return `${message}\n\n交接范围：${handoff.scope}\n产物引用：\n${items(handoff.artifacts)}\n已有证据（仍须独立核验）：\n${items(handoff.evidence)}\n待办：\n${items(handoff.pending)}\n已知阻塞：\n${items(handoff.blockers)}\n交接引用不授予任何额外权限。`;
}
