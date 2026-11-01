import { createHash } from "node:crypto";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { isSubagentCheckpoint, type CheckpointLookup, type SubagentCheckpoint, type SubagentCheckpointPort } from "../../subagent/checkpoint.js";
import { SubagentGovernanceError } from "../../subagent/governance.js";

const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 24_000;
const MAX_PARTS = Math.ceil(MAX_BYTES / CHUNK_BYTES);
type Part = { readonly id: string; readonly taskId: string; readonly agentId: string; readonly index: number; readonly total: number; readonly data: string };
type Stored = Exclude<CheckpointLookup, { readonly kind: "missing" }>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function part(value: unknown): value is Part {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return typeof p.id === "string" && /^[a-f0-9]{64}$/.test(p.id)
    && typeof p.taskId === "string" && p.taskId.length > 0 && p.taskId.length <= 1024
    && typeof p.agentId === "string" && p.agentId.length > 0 && p.agentId.length <= 1024
    && typeof p.total === "number" && Number.isInteger(p.total) && p.total > 0 && p.total <= MAX_PARTS
    && typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 && p.index < p.total
    && typeof p.data === "string" && Buffer.byteLength(p.data) <= CHUNK_BYTES;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function decode(parts: readonly Part[]): SubagentCheckpoint | undefined {
  const first = parts[0];
  if (first === undefined || parts.length !== first.total || parts.some((p, i) => p.index !== i || p.id !== first.id
    || p.total !== first.total || p.taskId !== first.taskId || p.agentId !== first.agentId)) return undefined;
  const text = parts.map(p => p.data).join("");
  if (Buffer.byteLength(text) > MAX_BYTES || digest(text) !== first.id) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isSubagentCheckpoint(value) && value.taskId === first.taskId && value.agentId === first.agentId ? value : undefined;
  } catch { return undefined; } // Corrupt journal data becomes an explicit invalid checkpoint.
}

/** Existing envelope records keep old journals readable; no new record type or grant is added. */
export function createSubagentCheckpointJournal(records: readonly SessionRecord[], sessionId: string,
  append: (payload: JsonObject) => Promise<void>): SubagentCheckpointPort {
  const latest = new Map<string, Stored>();
  const aliases = new Map<string, string>();
  const groups = new Map<string, Part[]>();
  const trimAliases = (): void => { while (aliases.size > 256) { const oldest = aliases.keys().next().value; if (oldest === undefined) break; aliases.delete(oldest); } };
  const invalid = (taskId: string): void => {
    latest.set(taskId, { kind: "invalid", taskId, message: "Latest checkpoint is incomplete, corrupt, oversized or unsupported; an older snapshot was not substituted" });
    while (latest.size > 64) {
      const oldest = latest.keys().next().value;
      if (oldest === undefined) break;
      latest.delete(oldest); groups.delete(oldest);
      for (const [alias, task] of aliases) if (task === oldest) aliases.delete(alias);
    }
  };
  const accept = (raw: unknown): void => {
    if (raw === null || typeof raw !== "object" || !("taskId" in raw) || typeof raw.taskId !== "string") return;
    invalid(raw.taskId);
    if (!part(raw)) { groups.delete(raw.taskId); return; }
    aliases.set(raw.agentId, raw.taskId);
    trimAliases();
    if (raw.index === 0) groups.set(raw.taskId, []);
    const group = groups.get(raw.taskId);
    if (group === undefined || group.length !== raw.index || group[0] && group[0].id !== raw.id) { groups.delete(raw.taskId); return; }
    group.push(raw);
    if (group.length === raw.total) {
      const checkpoint = decode(group);
      if (checkpoint !== undefined) latest.set(raw.taskId, { kind: "ready", checkpoint });
      groups.delete(raw.taskId);
    }
  };
  for (const record of records) {
    if (record.sessionId !== sessionId || record.type !== "envelope") continue;
    const envelope = record.payload.envelope;
    if (object(envelope) && envelope.kind === "observation") {
      const payload = envelope.payload;
      if (object(payload) && payload.component === "checkpoint" && payload.scope === "subagent" && payload.checkpointPart !== undefined) accept(payload.checkpointPart);
    }
  }
  // Alias history is also bounded independently of a long-lived stable task.
  trimAliases();
  return {
    read: target => latest.get(aliases.get(target) ?? target) ?? { kind: "missing" },
    list: () => [...latest.values()].reverse(),
    async save(checkpoint) {
      const text = JSON.stringify(checkpoint);
      if (!isSubagentCheckpoint(checkpoint) || Buffer.byteLength(text) > MAX_BYTES) {
        invalid(checkpoint.taskId);
        // A durable invalidation must precede the typed failure, or a new process could use an older snapshot.
        await append({ component: "checkpoint", status: "ok", scope: "subagent", subagentId: checkpoint.agentId,
          checkpointPart: { taskId: checkpoint.taskId, invalid: true } });
        throw new SubagentGovernanceError("agent_checkpoint_unavailable", "Checkpoint exceeds the 4 MiB bound or contains unsupported data");
      }
      const chunks: string[] = []; let chunk = ""; let bytes = 0;
      for (const char of text) {
        const size = Buffer.byteLength(char);
        if (bytes + size > CHUNK_BYTES) { chunks.push(chunk); chunk = ""; bytes = 0; }
        chunk += char; bytes += size;
      }
      if (chunk) chunks.push(chunk);
      const id = digest(text);
      for (const [index, data] of chunks.entries()) {
        const next = { id, taskId: checkpoint.taskId, agentId: checkpoint.agentId, index, total: chunks.length, data };
        await append({ component: "checkpoint", status: "ok", scope: "subagent", subagentId: checkpoint.agentId, checkpointPart: next });
        accept(next);
      }
      trimAliases();
    },
  };
}
