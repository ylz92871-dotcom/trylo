import { isDigest, isIsoTime } from "./artifact.js";
import { isJsonValue, keysAre, recordOf, textOf } from "./parse.js";

export const MAX_TOOL_USES = 4096;
export function candidateToolName(identity: string, candidateHash: string): string {
  return `learned__${identity.slice(0, 32)}_${candidateHash.slice(0, 12)}`;
}
export function isCandidateToolName(name: string): boolean {
  return /^learned__[A-Za-z][A-Za-z0-9_-]{0,31}_[a-f0-9]{12}$/.test(name);
}
export const TOOL_USE_EXECUTIONS = ["returned", "tool_error", "timeout", "protocol_error", "cancelled", "unavailable"] as const;
export type ToolUseRecord = {
  readonly schemaVersion: 1;
  readonly useId: string;
  readonly versionId: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly workspaceId: string;
  readonly contentHash: string;
  readonly inputHash: string;
  readonly outputHash?: string;
  readonly execution: (typeof TOOL_USE_EXECUTIONS)[number];
  readonly quality: "unverified";
  readonly occurredAt: string;
};

export function isToolUseRecord(value: unknown): value is ToolUseRecord {
  return recordOf(value) && isJsonValue(value) && keysAre(value,
    ["schemaVersion", "useId", "versionId", "scope", "sessionId", "toolCallId", "workspaceId", "contentHash", "inputHash", "execution", "quality", "occurredAt"], ["outputHash"])
    && value.schemaVersion === 1 && textOf(value.useId, 160) && textOf(value.versionId, 160) && textOf(value.scope, 512)
    && textOf(value.sessionId, 160) && textOf(value.toolCallId, 256) && textOf(value.workspaceId, 160)
    && isDigest(value.contentHash) && isDigest(value.inputHash) && isIsoTime(value.occurredAt) && value.quality === "unverified"
    && TOOL_USE_EXECUTIONS.some(kind => kind === value.execution)
    && (value.execution === "returned" ? isDigest(value.outputHash) : value.outputHash === undefined);
}

export function toolUseFeedback(records: readonly ToolUseRecord[]): string | undefined {
  const failures = records.filter(item => item.execution === "tool_error" || item.execution === "timeout" || item.execution === "protocol_error").slice(-8);
  return failures.length === 0 ? undefined : JSON.stringify({ quality: "unverified", executionFailures:
    failures.map(item => ({ useId: item.useId, toolCallId: item.toolCallId, execution: item.execution })) });
}
