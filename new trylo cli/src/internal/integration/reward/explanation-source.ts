import { SESSION_RECORD_TYPES, isRuntimeFingerprint, type SessionRecordView } from "../../ports/session.js";
import { parseEnvelope } from "../../protocol/validate.js";
import type { Envelope } from "../../protocol/envelope.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { identity, object } from "../../learning/reward/validate.js";
import type { RewardSource } from "../../learning/reward/contracts.js";
import type { RewardExposureBinding } from "../../learning/reward/explanation/explanation-policy.js";
import { decodeToolMeasurement, isToolReportClose, isToolReportRefusal } from "./tool-report-classification.js";

export const TOOL_REPORT_DECODER = "tool_report_first_close_v1";

export interface FeedbackSourceBinding extends RewardExposureBinding {
  readonly toolName: string;
  readonly toolCallId: string;
}

export interface FeedbackSourceSnapshot {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cohortThrough: number;
  readonly observedThrough: number;
  readonly tornTail: boolean;
  readonly decoder: typeof TOOL_REPORT_DECODER;
  readonly basisHash: string;
  readonly observedRequests: number;
  readonly bindings: readonly FeedbackSourceBinding[];
}

export type FeedbackSourceRead = { readonly ok: true; readonly source: FeedbackSourceSnapshot }
  | { readonly ok: false; readonly reason: string; readonly atSequence?: number };

interface PendingRequest {
  binding: FeedbackSourceBinding;
  refused: boolean;
}

function rejected(reason: string, atSequence?: number): FeedbackSourceRead {
  return { ok: false, reason, ...(atSequence === undefined ? {} : { atSequence }) };
}

function sourceOf(event: Envelope): RewardSource | undefined {
  return identity(event.sessionId) && identity(event.turnId) && identity(event.attemptId) && identity(event.eventId)
    ? { sessionId: event.sessionId, turnId: event.turnId, attemptId: event.attemptId, eventId: event.eventId } : undefined;
}

function pendingKey(source: RewardSource, callId: string): string {
  return JSON.stringify([source.sessionId, source.turnId, source.attemptId, callId]);
}

function close(request: PendingRequest, event: Envelope, sequence: number, status: string): void {
  const outcome = decodeToolMeasurement(request.refused ? "denied" : status, event.payload.code);
  const report = outcome.kind === "measured" ? outcome.value === 1 ? "success" : "failure" : "other";
  request.binding = { ...request.binding,
    unit: { unitId: request.binding.unit.unitId, registeredAt: request.binding.unit.registeredAt, status: report, revealedAt: sequence },
    closeEventId: event.eventId, ...(outcome.kind === "unknown" ? { otherReason: outcome.reason } : {}) };
}

/** Decode a fixed source snapshot; collection caps and Board delivery are not this analysis's lifecycle. */
export function decodeFeedbackSource(view: SessionRecordView, sessionId: string, through?: number): FeedbackSourceRead {
  if (!identity(sessionId) || !Array.isArray(view.records) || typeof view.tornTail !== "boolean") return rejected("invalid_source_view");

  const last = view.records.length - 1;
  const cohortThrough = through ?? last;
  if (!Number.isSafeInteger(cohortThrough) || cohortThrough < 0 || cohortThrough > last) return rejected("source_watermark_unavailable");

  const first = view.records[0];
  if (!first || first.type !== "session_start" || !object(first.payload) || !isRuntimeFingerprint(first.payload.fingerprint)
    || !identity(first.payload.fingerprint.workspaceId)) return rejected("source_identity_missing");

  const events = new Set<string>(), requests = new Map<string, PendingRequest>(), pending = new Map<string, PendingRequest>();
  const ordered: PendingRequest[] = [];

  for (let i = 0; i < view.records.length; i++) {
    const record = view.records[i];
    if (!record || record.sequence !== i || !Number.isSafeInteger(record.sequence) || record.formatVersion !== "1"
      || record.sessionId !== sessionId || !(SESSION_RECORD_TYPES as readonly string[]).includes(record.type)
      || !identity(record.at) || !object(record.payload)) return rejected("source_record_invalid", i);

    if (record.type !== "envelope") continue;

    const parsed = parseEnvelope(record.payload.envelope);
    if (!parsed.ok) return rejected(`source_envelope_${parsed.code}`, i);

    const event = parsed.envelope;
    if (!Number.isSafeInteger(event.sequence) || !Number.isSafeInteger(event.producerSequence)
      || (event.sessionId !== undefined && event.sessionId !== sessionId)
      || (event.turnId !== undefined && event.turnId !== record.turnId)) return rejected("source_envelope_identity_mismatch", i);

    // Event IDs restart in each turn. The complete address, never a bare ID, is unique.
    const address = JSON.stringify([sessionId, record.turnId ?? null, event.attemptId ?? null, event.eventId]);
    if (events.has(address)) return rejected("source_duplicate_event", i);

    events.add(address);
    const source = sourceOf(event), callId = event.payload.toolCallId;

    if (event.kind === "tool_use") {
      if (!source || !identity(callId) || !identity(event.payload.name) || i === 0) return rejected("source_request_identity_missing", i);

      const key = pendingKey(source, callId);
      if (requests.has(key)) return rejected("source_duplicate_request", i);

      const exposureId = `reward-use:${contentHashOf([key, event.eventId])}`;
      const request: PendingRequest = { refused: false, binding: { source, exposureId, toolCallId: callId,
        toolName: event.payload.name, unit: { unitId: exposureId, registeredAt: i, status: "pending" } } };

      requests.set(key, request);
      pending.set(key, request);
      ordered.push(request);
      continue;
    }

    // The original sensor ignores boot/non-target envelopes without full source IDs.
    if (!source) continue;

    if (event.kind === "terminal") {
      for (const [key, request] of pending) {
        if (request.binding.source.sessionId !== source.sessionId || request.binding.source.turnId !== source.turnId) continue;
        close(request, event, i, event.payload.reason === "cancelled" ? "cancelled" : "unknown");
        pending.delete(key);
      }
      continue;
    }

    if (typeof callId !== "string") continue;

    const key = pendingKey(source, callId), request = pending.get(key);
    if (request && isToolReportRefusal(event.kind, event.payload)) request.refused = true;

    if (!isToolReportClose(event.kind, event.payload)) continue;

    if (!requests.has(key)) return rejected("source_response_without_request", i);

    if (request) {
      close(request, event, i, String(event.payload.status));
      pending.delete(key);
    }
  }

  return { ok: true, source: { sessionId, workspaceId: first.payload.fingerprint.workspaceId, cohortThrough,
    observedThrough: last, tornTail: view.tornTail, decoder: TOOL_REPORT_DECODER,
    basisHash: contentHashOf({ decoder: TOOL_REPORT_DECODER, records: view.records, cohortThrough }),
    observedRequests: ordered.length, bindings: ordered.map(row => row.binding).filter(row => row.unit.registeredAt <= cohortThrough) } };
}
