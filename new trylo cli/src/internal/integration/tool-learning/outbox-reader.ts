import { open } from "node:fs/promises";
import { decodeToolLearningPlan, isToolLearningJobId, toolLearningJobId, MAX_TOOL_PIPELINE_JOBS } from "../../learning/domains/tool/evolution/pipeline.js";
import type { ToolLearningPlan } from "../../learning/domains/tool/evolution/pipeline.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../../learning/domains/tool/evolution/parse.js";
import type { ToolLedgerRecord } from "./ledger-file.js";

export const TOOL_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export class ToolOutboxError extends Error {
  constructor(readonly code: "tool_outbox_unavailable" | "tool_outbox_too_large" | "tool_outbox_corrupt" | "tool_outbox_torn_tail") { super(code); }
}

/** Handoff facts live in the accepted-proposal log; Board alone owns job state. */
export async function readPendingToolPlans(file: string): Promise<readonly ToolLearningPlan[]> {
  const pending = new Map<string, ToolLearningPlan>();
  for (const value of await readToolLedgerRows(file)) {
    if (value.kind === "pipeline_handoff") pending.delete(value.jobId);
    else if (value.kind === "proposal" && value.pipelinePlan !== undefined) {
      pending.set(toolLearningJobId(value.pipelinePlan), value.pipelinePlan);
      if (pending.size > MAX_TOOL_PIPELINE_JOBS) throw new ToolOutboxError("tool_outbox_too_large");
    }
  }
  return [...pending.values()];
}

/** Bounded complete framing is required before an accepted proposal may spend resources. */
export async function readToolLedgerRows(file: string): Promise<Iterable<ToolLedgerRecord>> {
  let raw: string;
  try { raw = await boundedRead(file); }
  catch (error) {
    if (error instanceof ToolOutboxError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new ToolOutboxError("tool_outbox_unavailable");
  }
  if (raw.length > 0 && !raw.endsWith("\n")) throw new ToolOutboxError("tool_outbox_torn_tail");
  return parseRows(raw);
}

function* parseRows(raw: string): Iterable<ToolLedgerRecord> {
  let count = 0;
  for (let start = 0; start < raw.length;) {
    const end = raw.indexOf("\n", start), line = raw.slice(start, end).trim(); start = end + 1;
    if (line.length === 0) continue;
    if (line.length > 65_536) throw new ToolOutboxError("tool_outbox_too_large");
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new ToolOutboxError("tool_outbox_corrupt"); }
    const decoded = decodeLedgerRecord(value);
    if (decoded === undefined) throw new ToolOutboxError("tool_outbox_corrupt");
    if (++count > 100_000) throw new ToolOutboxError("tool_outbox_too_large");
    yield decoded;
  }
}

export function decodeLedgerRecord(value: unknown): ToolLedgerRecord | undefined {
  if (!isJsonValue(value) || !recordOf(value) || !textOf(value.at, 64)) return undefined;
  if (value.kind === "pipeline_handoff") {
    if (!keysAre(value, ["kind", "at", "jobId", "outcome"], ["reason"]) || !isToolLearningJobId(value.jobId)
      || (value.outcome !== "accepted" && value.outcome !== "rejected") || (value.reason !== undefined && !textOf(value.reason, 160))) return undefined;
    return { kind: value.kind, at: value.at, jobId: value.jobId, outcome: value.outcome, ...(value.reason === undefined ? {} : { reason: value.reason }) };
  }
  if (!textOf(value.turnId, 160) || typeof value.reason !== "string" || value.reason.length > 4_096) return undefined;
  if (value.kind === "observation") {
    if (!keysAre(value, ["kind", "at", "turnId", "reason", "detail"]) || typeof value.detail !== "string" || value.detail.length > 4_096
      || (value.reason !== "no_self_report" && value.reason !== "no_objective_signal")) return undefined;
    return { kind: value.kind, at: value.at, turnId: value.turnId, reason: value.reason, detail: value.detail };
  }
  if (!textOf(value.key, 512)) return undefined;
  if (value.kind === "throttled") return keysAre(value, ["kind", "at", "turnId", "key", "reason"])
    ? { kind: value.kind, at: value.at, turnId: value.turnId, key: value.key, reason: value.reason } : undefined;
  if (value.kind !== "proposal" || !keysAre(value, ["kind", "at", "turnId", "key", "reason", "action", "capability"], ["tool", "pipelinePlan"])
    || !textOf(value.action, 120) || !textOf(value.capability, 512) || (value.tool !== undefined && !textOf(value.tool, 512))) return undefined;
  const plan = value.pipelinePlan === undefined ? undefined : decodeToolLearningPlan(value.pipelinePlan);
  if (value.pipelinePlan !== undefined && (plan === undefined || plan.createdAt !== value.at || plan.trigger.runId !== value.turnId || plan.trigger.proposalKey !== value.key
    || plan.trigger.action !== value.action || plan.capability !== value.capability || plan.trigger.tool !== value.tool)) return undefined;
  return { kind: value.kind, at: value.at, turnId: value.turnId, key: value.key, reason: value.reason, action: value.action, capability: value.capability,
    ...(value.tool === undefined ? {} : { tool: value.tool }), ...(plan === undefined ? {} : { pipelinePlan: plan }) };
}

async function boundedRead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(TOOL_LEDGER_MAX_BYTES + 1); let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > TOOL_LEDGER_MAX_BYTES) throw new ToolOutboxError("tool_outbox_too_large");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch { throw new ToolOutboxError("tool_outbox_corrupt"); }
  } finally { await handle.close(); }
}
