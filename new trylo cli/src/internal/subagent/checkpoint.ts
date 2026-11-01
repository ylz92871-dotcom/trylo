import type { ProviderMessage } from "../ports/provider.js";
import { isTranscript, type Transcript } from "../protocol/transcript.js";
import { isSubagentBudgetSnapshot, type SubagentBudgetSnapshot } from "../protocol/subagent-budget.js";
import type { ResolvedRole } from "./role.js";
import type { TeamMemberIdentity } from "./team.js";
import { toolPairingOf } from "../protocol/tool-pairing.js";
import { isTranscriptItem } from "../protocol/transcript.js";

/** A replay boundary, never a serialized execution, approval, or provider cache. */
export type SubagentCheckpoint = {
  readonly version: 1;
  readonly taskId: string;
  readonly agentId: string;
  readonly round: number;
  readonly phase: "round_ready" | "interrupted";
  readonly nickname: string;
  readonly instruction: string;
  readonly role: string;
  readonly roleBinding: string;
  readonly model?: string;
  readonly teamMember?: TeamMemberIdentity;
  readonly allowedTools: readonly string[];
  readonly dependencies: readonly string[];
  readonly idleTimeoutMs: number;
  readonly budget: SubagentBudgetSnapshot;
  readonly cursor: number;
  readonly transcript: Transcript;
  readonly forkMessages: readonly ProviderMessage[];
  /** Image bytes are deliberately not persisted in the v1 session journal. */
  readonly contextUnavailable?: true;
};

export type CheckpointLookup = { readonly kind: "ready"; readonly checkpoint: SubagentCheckpoint }
  | { readonly kind: "invalid"; readonly taskId: string; readonly message: string }
  | { readonly kind: "missing" };

export type SubagentCheckpointPort = {
  save(checkpoint: SubagentCheckpoint): Promise<void>;
  read(target: string): CheckpointLookup;
  list(): readonly Exclude<CheckpointLookup, { readonly kind: "missing" }>[];
};

/** Tool allowances are re-intersected separately; revocation does not change identity. */
export function roleBinding(resolved: ResolvedRole): string {
  const role = resolved.role;
  return JSON.stringify([role.name, role.prompt ?? null, role.model ?? null, role.maxIterations ?? null,
    role.disallowedTools ?? [], role.skills ?? []]);
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const identity = (value: unknown): value is string => text(value) && value.length <= 1024;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1024 && value.every(text);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function portableMessage(value: unknown): value is ProviderMessage {
  if (!record(value) || typeof value.content !== "string" || !["user", "system", "assistant", "tool"].includes(String(value.role))) return false;
  if (Object.keys(value).some(key => !["role", "content", "toolCallId", "toolCalls"].includes(key))) return false;
  if (value.role === "tool" && !text(value.toolCallId)) return false;
  if (value.toolCallId !== undefined && !text(value.toolCallId)) return false;
  return value.toolCalls === undefined || value.role === "assistant" && Array.isArray(value.toolCalls)
    && value.toolCalls.every(call => record(call) && Object.keys(call).every(key => ["toolCallId", "name", "arguments", "originalArguments"].includes(key))
      && isTranscriptItem({ ...call, kind: "tool_call", sequence: 0 }));
}

/** The boundary rejects opaque fields, notably authority and native continuation state. */
export function isSubagentCheckpoint(value: unknown): value is SubagentCheckpoint {
  if (!record(value) || value.version !== 1) return false;
  if (Object.keys(value).some(key => !["version", "taskId", "agentId", "round", "phase", "nickname", "instruction", "role", "roleBinding",
    "model", "teamMember", "allowedTools", "dependencies", "idleTimeoutMs", "budget", "cursor", "transcript", "forkMessages", "contextUnavailable"].includes(key))) return false;
  const member = value.teamMember;
  return [value.taskId, value.agentId].every(identity) && [value.nickname, value.instruction, value.roleBinding].every(text)
    && text(value.role) && value.role.length <= 128
    && count(value.round) && value.round > 0 && ["round_ready", "interrupted"].includes(String(value.phase))
    && (value.model === undefined || text(value.model))
    && (member === undefined || record(member) && Object.keys(member).length === 2 && identity(member.teamRunId) && identity(member.memberId))
    && strings(value.allowedTools) && strings(value.dependencies) && value.dependencies.length <= 16
    && count(value.idleTimeoutMs) && value.idleTimeoutMs > 0 && value.idleTimeoutMs <= 300_000
    && isSubagentBudgetSnapshot(value.budget) && count(value.cursor) && isTranscript(value.transcript) && toolPairingOf(value.transcript).orphans.length === 0
    && Array.isArray(value.forkMessages) && value.forkMessages.every(portableMessage)
    && (value.contextUnavailable === undefined || value.contextUnavailable === true);
}

export function portableFork(messages: readonly ProviderMessage[] = []): { readonly forkMessages: readonly ProviderMessage[]; readonly contextUnavailable?: true } {
  if (messages.some(message => (message.attachments?.length ?? 0) > 0 || (message.imageReferences?.length ?? 0) > 0)) {
    return { forkMessages: [], contextUnavailable: true };
  }
  return { forkMessages: messages.map(({ attachments: _attachments, imageReferences: _references, ...message }) => message) };
}
