import type { SessionRecordView } from "../../../ports/session.js";
import { canonicalJson } from "../../../learning/control/hash.js";
import { parseEnvelope } from "../../../protocol/validate.js";
import type { ValidateFailureCode } from "../../../protocol/result.js";
import { createPublicToolResultReader, isPublicToolResultPart, isPublicToolResultManifest, PublicToolResultError,
  type PublicToolResultFailureCode } from "../../../protocol/public-tool-result.js";
import { sessionContentRecordRef, sessionContentRecordView, sessionRecordOrigin } from "./session-decode.js";

export interface SessionContentAddress {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly journalSequence?: number;
  readonly eventId?: string;
  readonly attemptId?: string;
  readonly toolCallId?: string;
}

/** Explicit registry address, not a filesystem path or a semantic-question identity. */
export function sessionContentAddress(address: SessionContentAddress): string {
  return `session-address:${canonicalJson(address)}`;
}

export function readSessionContentAddress(ref: string): SessionContentAddress | undefined {
  const original = /^session:([^/]+)\/turn:([^/]+)(?:\/(input|tool):(.+))?$/.exec(ref);
  if (original !== null) {
    const sessionId = original[1]!, turnId = original[2]!;
    if (original[3] === "input") {
      const journalSequence = Number(original[4]);
      return /^\d+$/.test(original[4]!) && Number.isSafeInteger(journalSequence) ? { sessionId, turnId, journalSequence } : undefined;
    }
    return { sessionId, turnId, ...(original[3] === "tool" ? { toolCallId: original[4]! } : {}) };
  }

  if (!ref.startsWith("session-address:")) return undefined;

  let raw: unknown;

  try { raw = JSON.parse(ref.slice("session-address:".length)); }
  catch { return undefined; }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const row = raw as Record<string, unknown>, keys = ["sessionId", "turnId", "journalSequence", "eventId", "attemptId", "toolCallId"];
  if (Object.keys(row).some(key => !keys.includes(key)) || typeof row.sessionId !== "string" || !row.sessionId
    || ["turnId", "eventId", "attemptId", "toolCallId"].some(key => row[key] !== undefined && (typeof row[key] !== "string" || !row[key]))
    || row.journalSequence !== undefined && (typeof row.journalSequence !== "number" || !Number.isSafeInteger(row.journalSequence) || row.journalSequence < 0)) return undefined;

  return { sessionId: row.sessionId, ...(row.turnId === undefined ? {} : { turnId: String(row.turnId) }),
    ...(row.journalSequence === undefined ? {} : { journalSequence: Number(row.journalSequence) }),
    ...(row.eventId === undefined ? {} : { eventId: String(row.eventId) }),
    ...(row.attemptId === undefined ? {} : { attemptId: String(row.attemptId) }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: String(row.toolCallId) }) };
}

export function sessionTaskAddress(taskId: string): string { return `session-task-address:${canonicalJson({ taskId })}`; }

export function readSessionTaskAddress(ref: string): string | undefined {
  if (!ref.startsWith("session-task-address:")) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(ref.slice("session-task-address:".length)); }
  catch { return undefined; }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 1
    && "taskId" in raw && typeof raw.taskId === "string" && raw.taskId.trim().length > 0 && raw.taskId.length <= 512 ? raw.taskId : undefined;
}

export interface SessionContentLocator {
  readonly ref: string; readonly journalSequence: number; readonly turnId?: string;
  readonly eventId?: string; readonly attemptId?: string; readonly toolCallId?: string;
  readonly eventSequence?: number;
  readonly viewRef?: string;
  /** Complete transport, verified against this original immutable prefix. */
  readonly publicText?: string;
}

/** A rejected original remains addressable as a failure, never an empty source. */
export class SessionContentEnvelopeError extends Error {
  constructor(readonly sessionId: string, readonly journalSequence: number, readonly validationCode: ValidateFailureCode | PublicToolResultFailureCode) {
    super("content_source_envelope_invalid");
    this.name = "SessionContentEnvelopeError";
  }
}

/** Event ordinal and journal coordinate remain separate; an event address only selects its actual source turn. */
export function sessionContentLocators(view: SessionRecordView, sessionId: string, excluded: readonly string[] = [],
  projection?: { readonly scope: string; readonly secrets?: readonly string[] }): readonly SessionContentLocator[] {
  const locators: SessionContentLocator[] = [], deniedCalls = new Set<string>(), deniedTurnCalls = new Set<string>();
  const publicResults = createPublicToolResultReader();

  for (const record of view.records) {
    let publicText: string | undefined;
    let eventId: string | undefined, attemptId: string | undefined, toolCallId: string | undefined, eventSequence: number | undefined;

    if (record.type === "envelope") {
      const parsed = parseEnvelope(record.payload.envelope);
      if (!parsed.ok) throw new SessionContentEnvelopeError(sessionId, record.sequence, parsed.code);

      const event = parsed.envelope;
      const origin = sessionRecordOrigin(record);
      const transport = isPublicToolResultPart(event) || isPublicToolResultManifest(event);
      if ((origin !== undefined || transport) && (event.sessionId !== undefined && event.sessionId !== sessionId
        || event.turnId !== undefined && event.turnId !== record.turnId)) {
        if (transport) throw new SessionContentEnvelopeError(sessionId, record.sequence, "public_tool_result_binding");
        throw new Error("content_source_event_identity_invalid");
      }

      let resolved;

      try { resolved = publicResults.push(event); }
      catch (error) {
        if (!(error instanceof PublicToolResultError)) throw error;
        throw new SessionContentEnvelopeError(sessionId, record.sequence, error.code);
      }

      if (resolved.kind === "part") continue;

      if (resolved.kind === "result") publicText = canonicalJson({ representation: "reassembled_public_tool_result", payload: resolved.value.payload,
        wireEnvelope: event, payloadHash: resolved.hash,
        fragments: resolved.fragments.map(part => ({ eventId: part.eventId, sequence: part.sequence, producerSequence: part.producerSequence })) });

      if (origin === undefined) continue;

      eventId = event.eventId;
      attemptId = event.attemptId;
      eventSequence = event.sequence;
      toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
      const callKey = canonicalJson([record.turnId, attemptId, toolCallId]);
      const turnCallKey = canonicalJson([record.turnId, toolCallId]);

      if (typeof event.payload.name === "string" && excluded.includes(event.payload.name)) {
        deniedCalls.add(callKey);
        deniedTurnCalls.add(turnCallKey);
      }

      if (deniedCalls.has(callKey) || deniedTurnCalls.has(turnCallKey)) continue;
    } else if (record.type === "transcript_item") {
      if (sessionRecordOrigin(record) === undefined) continue;
      if (typeof record.payload.name === "string" && excluded.includes(record.payload.name)) continue;
      toolCallId = typeof record.payload.toolCallId === "string" ? record.payload.toolCallId : undefined;
    }

    const projected = projection === undefined ? undefined : sessionContentRecordView(record, projection.scope, projection.secrets, excluded, publicText);

    locators.push({ ref: sessionContentRecordRef(sessionId, record.sequence), journalSequence: record.sequence,
      ...(projected?.changed === true ? { viewRef: projected.record.ref } : {}),
      ...(publicText === undefined ? {} : { publicText }),
      ...(record.turnId === undefined ? {} : { turnId: record.turnId }), ...(eventId === undefined ? {} : { eventId }),
      ...(eventSequence === undefined ? {} : { eventSequence }),
      ...(attemptId === undefined ? {} : { attemptId }), ...(toolCallId === undefined ? {} : { toolCallId }) });
  }

  publicResults.close();

  return locators;
}

export function locateSessionContent(ref: string, sessionId: string, locators: readonly SessionContentLocator[]): readonly SessionContentLocator[] {
  const address = readSessionContentAddress(ref);
  if (address !== undefined) return address.sessionId !== sessionId ? [] : locators.filter(row =>
    (address.turnId === undefined || row.turnId === address.turnId) && (address.journalSequence === undefined || row.journalSequence === address.journalSequence)
    && (address.eventId === undefined || row.eventId === address.eventId) && (address.attemptId === undefined || row.attemptId === address.attemptId)
    && (address.toolCallId === undefined || row.toolCallId === address.toolCallId));

  return locators.filter(row => ref === sessionId || ref === row.ref || ref.startsWith(`${row.ref}:chunk:`)
    || ref === row.viewRef || row.viewRef !== undefined && ref.startsWith(`${row.viewRef}:chunk:`)
    || ref === row.turnId || ref === row.eventId || ref === row.toolCallId);
}
