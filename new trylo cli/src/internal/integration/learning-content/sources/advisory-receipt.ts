import type { SessionPort, SessionRecord } from "../../../ports/session.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { contentDeliveryReceiptId, isContentDeliveryConfiguration } from "./adoption-receipt.js";
import { advisoryReportBoundary, findAdvisoryReadEvidence } from "./advisory-read-evidence.js";
import { isAdvisoryReportText, isAdvisoryUseReport, isContentAdvisoryIdentity, isContentAdvisoryRef,
  isContentAdvisoryRefs, type AdvisoryUseReport, type ContentAdvisoryRef } from "./advisory-contract.js";

export interface AdvisoryUseReportInput {
  readonly session: Pick<SessionPort, "readRecords" | "append">;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly advisory: ContentAdvisoryRef;
  readonly change: string;
  readonly reason: string;
  readonly now: () => number;
}

export type AdvisoryUseReportResult = {
  readonly status: "recorded"; readonly receiptId: string; readonly sequence: number;
  readonly idempotent: boolean; readonly report: AdvisoryUseReport;
} | { readonly status: "rejected" | "unconfirmed"; readonly reason: string };

export function advisoryUseReportId(sessionId: string, turnId: string, toolCallId: string): string {
  return `advisory-use-report:${contentHashOf([sessionId, turnId, toolCallId])}`;
}

const sameAdvisory = (left: ContentAdvisoryRef, right: ContentAdvisoryRef) => left.ref === right.ref && left.version === right.version;

/** The caller supplies only the original SessionPort's read result. A prepared
 * reference or model-provided delivery identity cannot establish exposure. */
export function findAdvisoryContextDelivery(records: readonly SessionRecord[], input: {
  readonly sessionId: string; readonly turnId: string; readonly advisory: ContentAdvisoryRef;
  readonly beforeSequence: number; readonly deliveryRef?: string;
}): { readonly deliveryRef: string; readonly sequence: number } | undefined {
  for (const record of records) {
    if (record.sequence >= input.beforeSequence || record.sessionId !== input.sessionId || record.turnId !== input.turnId
      || record.type !== "execution_extension") continue;

    const metadata = record.payload, configuration = metadata.configuration;
    if (metadata.schemaVersion !== 1 || metadata.owner !== "learning-content" || typeof metadata.instanceId !== "string"
      || !isContentDeliveryConfiguration(configuration) || configuration.turnId !== input.turnId
      || !("advisoryRefs" in configuration) || !isContentAdvisoryRefs(configuration.advisoryRefs)
      || !configuration.advisoryRefs.some(ref => sameAdvisory(ref, input.advisory))
      || metadata.instanceId !== contentDeliveryReceiptId(input.sessionId, configuration)
      || input.deliveryRef !== undefined && metadata.instanceId !== input.deliveryRef) continue;

    return { deliveryRef: metadata.instanceId, sequence: record.sequence };
  }
  return undefined;
}

function delivered(records: readonly SessionRecord[], input: AdvisoryUseReportInput, deliveryRef?: string): string | undefined {
  const boundary = advisoryReportBoundary(records, input);
  if (boundary === undefined) return undefined;

  const context = findAdvisoryContextDelivery(records, { sessionId: input.sessionId, turnId: input.turnId,
    advisory: input.advisory, beforeSequence: boundary, ...(deliveryRef === undefined ? {} : { deliveryRef }) });
  if (context !== undefined) return context.deliveryRef;

  const read = findAdvisoryReadEvidence(records, { sessionId: input.sessionId, turnId: input.turnId,
    advisory: input.advisory, reportToolCallId: input.toolCallId });

  return read !== undefined && (deliveryRef === undefined || read.deliveryRef === deliveryRef) ? read.deliveryRef : undefined;
}

/** Uses the normal turn's exclusive tool execution and sole session writer.
 * Unknown append outcomes are returned once; this function never retries them. */
export async function recordAdvisoryUseReport(supplied: AdvisoryUseReportInput, signal: AbortSignal): Promise<AdvisoryUseReportResult> {
  if (![supplied.sessionId, supplied.turnId, supplied.toolCallId].every(isContentAdvisoryIdentity) || !isContentAdvisoryRef(supplied.advisory)
    || !isAdvisoryReportText(supplied.change) || !isAdvisoryReportText(supplied.reason)) return { status: "rejected", reason: "advisory_report_invalid" };

  const input: AdvisoryUseReportInput = { ...supplied, advisory: { ...supplied.advisory } };

  if (signal.aborted) return { status: "rejected", reason: "advisory_report_cancelled" };

  let saved: Awaited<ReturnType<SessionPort["readRecords"]>>;

  try { saved = await input.session.readRecords(); }
  catch { return { status: "unconfirmed", reason: "advisory_report_journal_unavailable" }; }

  if (!saved.ok) return { status: "unconfirmed", reason: "advisory_report_journal_unavailable" };

  const records = saved.view.records, receiptId = advisoryUseReportId(input.sessionId, input.turnId, input.toolCallId);
  let existing: { readonly sequence: number; readonly report: AdvisoryUseReport } | undefined;

  for (const record of records) {
    if (record.type !== "execution_extension" || record.sessionId !== input.sessionId || record.turnId !== input.turnId
      || record.payload.owner !== "learning-content") continue;

    const configuration = record.payload.configuration;
    const sameCall = typeof configuration === "object" && configuration !== null && !Array.isArray(configuration)
      && "kind" in configuration && configuration.kind === "advisory_use_report"
      && "turnId" in configuration && configuration.turnId === input.turnId
      && "toolCallId" in configuration && configuration.toolCallId === input.toolCallId;
    if (record.payload.instanceId !== receiptId && !sameCall) continue;

    if (record.payload.schemaVersion !== 1 || record.payload.instanceId !== receiptId || !isAdvisoryUseReport(configuration)
      || configuration.turnId !== input.turnId || configuration.toolCallId !== input.toolCallId
      || !sameAdvisory(configuration.advisory, input.advisory) || configuration.change !== input.change || configuration.reason !== input.reason) {
      return { status: "rejected", reason: "advisory_report_conflict" };
    }

    if (existing !== undefined && canonicalJson(existing.report) !== canonicalJson(configuration)) return { status: "rejected", reason: "advisory_report_conflict" };

    existing ??= { sequence: record.sequence, report: configuration };
  }

  if (existing !== undefined) {
    // Later tool attempts or deliveries cannot rewrite this call's first receipt.
    const prefix = records.filter(record => record.sequence < existing.sequence);
    if (delivered(prefix, input, existing.report.deliveryRef) === undefined) return { status: "rejected", reason: "advisory_report_delivery_unbound" };
    return { status: "recorded", receiptId, sequence: existing.sequence, idempotent: true,
      report: { ...existing.report, advisory: { ...existing.report.advisory } } };
  }

  if (saved.view.tornTail) return { status: "unconfirmed", reason: "advisory_report_journal_incomplete" };

  const deliveryRef = delivered(records, input);
  if (deliveryRef === undefined) return { status: "rejected", reason: "advisory_report_delivery_unbound" };

  if (signal.aborted) return { status: "rejected", reason: "advisory_report_cancelled" };

  let now: number;

  try { now = input.now(); }
  catch { return { status: "rejected", reason: "advisory_report_time_unavailable" }; }

  if (!Number.isFinite(now) || Math.abs(now) > 8_640_000_000_000_000) return { status: "rejected", reason: "advisory_report_time_invalid" };

  const report: AdvisoryUseReport = { schemaVersion: 1, kind: "advisory_use_report", turnId: input.turnId, toolCallId: input.toolCallId,
    advisory: { ...input.advisory }, deliveryRef, change: input.change, reason: input.reason };

  try {
    const written = await input.session.append({ type: "execution_extension", sessionId: input.sessionId, turnId: input.turnId,
      at: new Date(now).toISOString(), payload: { schemaVersion: 1, owner: "learning-content", instanceId: receiptId,
        configuration: { ...report, advisory: { ...report.advisory } } } });
    return written.ok ? { status: "recorded", receiptId, sequence: written.sequence, idempotent: false, report }
      : { status: "unconfirmed", reason: "advisory_report_append_unconfirmed" };
  } catch { return { status: "unconfirmed", reason: "advisory_report_append_unconfirmed" }; }
}
