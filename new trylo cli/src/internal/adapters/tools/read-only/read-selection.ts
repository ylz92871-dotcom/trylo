import type { JsonObject } from "../../../protocol/envelope.js";
import { createHash } from "node:crypto";
import type {
  ReadRoutingConditions, ReadRoutingDecision, ReadRoutingPath, ReadRoutingPort, ReadRoutingRecord, ReadRoutingTrial,
} from "../../../ports/read-routing.js";
import type { FileSystemReader, ReadOnlyToolLimits } from "./limits.js";
import { selectRange, type RangeRequest, type RangeSelection } from "./range.js";
import { selectStreamRange, selectTextRange } from "./range-stream.js";
import { resolveInsideWorkspace } from "./workspace.js";

/** A policy cannot trade bounded streaming for an arbitrarily large allocation. */
export const MAX_ROUTED_WHOLE_FILE_BYTES = 262_144;

type SelectionInput = {
  readonly absolutePath: string;
  readonly executionId: string;
  readonly request: RangeRequest;
  readonly limits: ReadOnlyToolLimits;
  readonly legacy: boolean;
  readonly signal: AbortSignal;
};

type SelectionConfig = {
  readonly workspaceRoot?: string;
  readonly reader: FileSystemReader;
  readonly readRouting?: ReadRoutingPort;
  readonly nowMs?: () => number;
};

/** No learning work happens here: consume a decision, run the existing reader, report execution facts. */
export async function selectReadFile(config: SelectionConfig, input: SelectionInput): Promise<{
  readonly selection: RangeSelection;
  readonly routing?: JsonObject;
}> {
  const baseline = config.reader.readFileChunks === undefined ? "whole" : "stream";

  if (config.readRouting === undefined) return { selection: await runPath(config.reader, baseline, input) };

  const nowMs = config.nowMs ?? Date.now;
  const start = nowMs();
  const diagnostics: string[] = [];
  const conditions = await readConditions(config.reader, input, diagnostics);
  const decision = await choose(config.readRouting, conditions, baseline, input, diagnostics);
  const guarded = guardPath(decision.path, baseline, conditions);
  let actualPath = guarded.path;
  let fallbackReason = guarded.reason;
  let bytesRead = 0;
  const fingerprint = config.readRouting.offer === undefined ? undefined : createHash("sha256");
  const reader = measuredReader(config.reader, bytes => { bytesRead += bytes; }, chunk => fingerprint?.update(chunk));
  let selection: RangeSelection | undefined;
  let failure: unknown;

  try {
    input.signal.throwIfAborted();
    try {
      selection = await runPath(reader, actualPath, input, actualPath !== baseline);
    } catch (error) {
      // Only a changed read-only strategy may retry, once, on the established path.
      if (input.signal.aborted || actualPath === baseline) throw error;
      actualPath = baseline;
      fallbackReason = error instanceof WholeFileLimitError ? "whole_file_grew" : "adapted_path_failed";
      selection = await runPath(reader, baseline, input);
    }
  } catch (error) {
    failure = error;
  }

  const originalDigest = fingerprint?.digest("hex");
  const record: ReadRoutingRecord = {
    executionId: input.executionId, conditions, decision, actualPath,
    outcome: input.signal.aborted ? "cancelled" : selection === undefined ? "failed" : "completed",
    bytesRead, latencyMs: Math.max(0, nowMs() - start),
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  };

  await recordResult(config.readRouting, record, input.signal, diagnostics);

  if (selection !== undefined && !input.signal.aborted && record.fallbackReason === undefined
    && config.workspaceRoot !== undefined && conditions.streaming && conditions.fileBytes >= 0
    && conditions.fileBytes <= MAX_ROUTED_WHOLE_FILE_BYTES && config.reader.readFileUtf8Bounded !== undefined
    && config.readRouting.offer !== undefined && originalDigest !== undefined) {
    try {
      const original = { selection, digest: originalDigest };
      config.readRouting.offer({ executionId: input.executionId, conditions,
        requiredBytes: 3 * (conditions.fileBytes + 65_536),
        trial: (path, signal) => compareReadPaths(config, input, conditions, original, path, signal, nowMs) });
    } catch { diagnostics.push("routing_offer_failed"); }
  }

  const routing = report(record, diagnostics);

  if (selection === undefined || input.signal.aborted) {
    const detail = failure instanceof Error ? failure.message : "read_error";
    throw new Error(`${detail}; routing:${JSON.stringify(routing)}`);
  }

  return { selection, routing };
}

async function readConditions(reader: FileSystemReader, input: SelectionInput, diagnostics: string[]): Promise<ReadRoutingConditions> {
  let fileBytes = -1;

  try {
    const bytes = await reader.statBytes(input.absolutePath);
    if (Number.isSafeInteger(bytes) && bytes >= 0) fileBytes = bytes;
    else diagnostics.push("routing_conditions_unavailable");
  } catch {
    // Stat is a routing sensor, not a new prerequisite for the existing read path.
    diagnostics.push("routing_conditions_unavailable");
  }

  return { fileBytes, range: input.legacy ? "all" : "bounded", streaming: reader.readFileChunks !== undefined };
}

async function choose(port: ReadRoutingPort, conditions: ReadRoutingConditions, baseline: ReadRoutingPath,
  input: SelectionInput, diagnostics: string[]): Promise<ReadRoutingDecision> {
  if (conditions.fileBytes < 0) return { path: baseline, reason: "conditions_unavailable" };
  try {
    const decision = await port.choose({ executionId: input.executionId, conditions, signal: input.signal });
    if (!validDecision(decision)) throw new Error("invalid_route_decision");
    return { path: decision.path, reason: decision.reason,
      ...(decision.versionId === undefined ? {} : { versionId: decision.versionId }) };
  } catch {
    // The caller receives a visible diagnostic and its established execution path.
    diagnostics.push("routing_choose_failed");
    return { path: baseline, reason: "routing_unavailable" };
  }
}

function validDecision(value: unknown): value is ReadRoutingDecision {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (item.path === "whole" || item.path === "stream") && typeof item.reason === "string" && item.reason.length > 0 &&
    (item.versionId === undefined || typeof item.versionId === "string" && item.versionId.length > 0);
}

function guardPath(path: ReadRoutingPath, baseline: ReadRoutingPath, conditions: ReadRoutingConditions): {
  readonly path: ReadRoutingPath; readonly reason?: string;
} {
  if (path === "stream" && !conditions.streaming) return { path: baseline, reason: "stream_unavailable" };
  if (path === "whole" && baseline === "stream" && conditions.fileBytes > MAX_ROUTED_WHOLE_FILE_BYTES) {
    return { path: baseline, reason: "whole_file_limit" };
  }
  return { path };
}

class WholeFileLimitError extends Error {}

async function runPath(reader: FileSystemReader, path: ReadRoutingPath, input: SelectionInput, adapted = false): Promise<RangeSelection> {
  if (path === "stream" && reader.readFileChunks !== undefined) {
    return selectStreamRange(reader.readFileChunks(input.absolutePath, input.signal), input.request, input.limits, input.signal, input.legacy);
  }

  // Node's bounded reader closes the stat/read growth race. Text-only injected readers retain compatibility.
  const raw = adapted && reader.readFileUtf8Bounded !== undefined
    ? await reader.readFileUtf8Bounded(input.absolutePath, MAX_ROUTED_WHOLE_FILE_BYTES, input.signal)
    : await reader.readFileUtf8(input.absolutePath, input.signal);
  if (raw === undefined) throw new WholeFileLimitError("whole_file_limit");

  input.signal.throwIfAborted();

  return input.legacy ? selectTextRange(raw, input.request, input.limits, true) : selectRange(raw, input.request, input.limits);
}

function measuredReader(reader: FileSystemReader, consumed: (bytes: number) => void,
  fingerprint?: (chunk: Uint8Array) => void, limit?: number): FileSystemReader {
  let used = 0;
  const observed = (chunk: Uint8Array): void => {
    consumed(chunk.byteLength);
    fingerprint?.(chunk);
    used += chunk.byteLength;
    if (limit !== undefined && used > limit) throw new WholeFileLimitError("trial_input_changed");
  };

  return {
    ...reader,
    readFileUtf8: async (path, signal) => {
      const text = await reader.readFileUtf8(path, signal);
      observed(Buffer.from(text));
      return text;
    },
    ...(reader.readFileUtf8Bounded === undefined ? {} : {
      readFileUtf8Bounded: async (path: string, maxBytes: number, signal: AbortSignal) => {
        const cap = Math.min(maxBytes, limit ?? maxBytes);
        const text = await reader.readFileUtf8Bounded!(path, cap, signal);
        if (text === undefined) consumed(cap + 1); else observed(Buffer.from(text));
        return text;
      },
    }),
    ...(reader.readFileChunks === undefined ? {} : {
      readFileChunks: async function* (path: string, signal: AbortSignal) {
        for await (const chunk of reader.readFileChunks!(path, signal)) {
          observed(chunk);
          yield chunk;
        }
      },
    }),
  };
}

/** No extra hash reads: each existing reader supplies its fingerprint while consuming bytes. */
async function compareReadPaths(config: SelectionConfig, originalInput: SelectionInput, conditions: ReadRoutingConditions,
  original: { readonly selection: RangeSelection; readonly digest: string }, path: ReadRoutingPath,
  signal: AbortSignal, now: () => number): Promise<ReadRoutingTrial> {
  const started = now();
  let totalBytesRead = 0, candidateBytes = 0, candidateMs = 0, executed = false;
  let quality: ReadRoutingTrial["quality"] = "unknown", reason = "check_unavailable";
  const input = { ...originalInput, signal };
  const read = async (candidate: ReadRoutingPath, measured: boolean) => {
    signal.throwIfAborted();
    const scope = config.workspaceRoot === undefined ? undefined : resolveInsideWorkspace(config.workspaceRoot, input.absolutePath);
    if (scope?.ok !== true || await config.reader.statBytes(input.absolutePath) !== conditions.fileBytes) throw new Error("file_changed");

    const digest = createHash("sha256");
    const reader = measuredReader(config.reader, bytes => {
      totalBytesRead += bytes;
      if (measured) candidateBytes += bytes;
    },
      bytes => { digest.update(bytes); }, conditions.fileBytes);
    const start = now();

    if (measured) executed = true;

    try { return { selection: await runPath(reader, candidate, input, true), digest: digest.digest("hex") }; }
    finally { if (measured) candidateMs += Math.max(0, now() - start); }
  };
  const same = (left: RangeSelection, right: RangeSelection) => JSON.stringify(left) === JSON.stringify(right);

  try {
    const before = await read("stream", false);
    if (before.digest !== original.digest || !same(before.selection, original.selection)) throw new Error("file_changed");

    let candidate: Awaited<ReturnType<typeof read>> | undefined;

    try { candidate = await read(path, true); }
    catch (error) {
      if (signal.aborted || error instanceof WholeFileLimitError) throw error;
      reason = "candidate_failed";
    }

    const after = await read("stream", false);
    if (after.digest !== before.digest || !same(after.selection, before.selection)) throw new Error("file_changed");

    quality = candidate !== undefined && candidate.digest === before.digest && same(candidate.selection, before.selection) ? "pass" : "fail";
    reason = quality === "pass" ? "full_range_equivalent" : "reader_disagreement";
  } catch {
    quality = "unknown";
    reason = signal.aborted ? "cancelled" : "file_changed";
  }

  const proofRef = `routing-read-check:${createHash("sha256").update(JSON.stringify([original.digest, original.selection,
    path, quality, totalBytesRead])).digest("hex")}`;
  const totalLatencyMs = Math.max(0, now() - started);

  return { quality, path, executed, bytesRead: candidateBytes, latencyMs: candidateMs, totalBytesRead, totalLatencyMs, proofRef, reason };
}

async function recordResult(port: ReadRoutingPort, record: ReadRoutingRecord, signal: AbortSignal, diagnostics: string[]): Promise<void> {
  try { await port.record(record, signal); }
  catch {
    // Reporting can fail after the read succeeds; preserve both facts, never repeat the read.
    diagnostics.push("routing_record_failed");
  }
}

function report(record: ReadRoutingRecord, diagnostics: readonly string[]): JsonObject {
  const candidateIds = ["stream", "whole"].filter(path => path === "stream" ? record.conditions.streaming
    : !record.conditions.streaming || record.conditions.fileBytes >= 0 && record.conditions.fileBytes <= MAX_ROUTED_WHOLE_FILE_BYTES);
  // A rejected request is not a selectable candidate. Preserve it separately,
  // while the wire decision describes the final choice the execution guard allowed.
  const rejected = !candidateIds.includes(record.decision.path);
  const selectedPath = rejected ? record.actualPath : record.decision.path;
  const reportedDiagnostics = [...diagnostics, ...(record.fallbackReason === undefined ? [] : [record.fallbackReason]),
    ...(rejected ? [`requested_path:${record.decision.path}`] : [])];

  return { schemaVersion: 1, decisionPoint: "read_file.strategy.v1", candidateIds, executionId: record.executionId,
    conditions: { fileBytes: record.conditions.fileBytes, range: record.conditions.range, streaming: record.conditions.streaming },
    decision: { path: selectedPath, reason: rejected ? record.fallbackReason ?? "requested_path_unavailable" : record.decision.reason,
      ...(record.decision.versionId === undefined ? {} : { versionId: record.decision.versionId }) },
    ...(rejected ? { requestedDecision: { ...record.decision } } : {}),
    actualPath: record.actualPath, outcome: record.outcome, bytesRead: record.bytesRead, latencyMs: record.latencyMs,
    ...(record.fallbackReason === undefined ? {} : { fallbackReason: record.fallbackReason }), diagnostics: reportedDiagnostics };
}
