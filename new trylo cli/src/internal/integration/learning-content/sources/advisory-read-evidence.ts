import type { SessionRecord } from "../../../ports/session.js";
import type { Envelope, JsonObject } from "../../../protocol/envelope.js";
import { parseEnvelope } from "../../../protocol/validate.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { isContentAdvisoryIdentity as identity, isContentAdvisoryRef, type ContentAdvisoryRef } from "./advisory-contract.js";
import { validateSessionContentJournal } from "./session-decode.js";

type Advisory = ContentAdvisoryRef;

type Address = { readonly sessionId: string; readonly turnId: string };

type Event = { readonly record: SessionRecord; readonly envelope: Envelope };

type ToolRead = { readonly use: Event; readonly result: Event; readonly arguments: JsonObject; readonly value: unknown };

type Range = { readonly start: number; readonly end: number; readonly text: string };

type AdvisoryPage = Range & Advisory & { readonly totalChars: number; readonly sourceHash: string };

type TransportPage = Range & { readonly status: "response_page"; readonly responseRef: string;
  readonly sourceHash: string; readonly unit: "utf8_bytes"; readonly totalBytes: number; readonly nextStart: number | null };

type DeliveredPage = { readonly page: AdvisoryPage; readonly attemptId: string; readonly reads: readonly ToolRead[];
  readonly completedAt: number };

export interface AdvisoryReadEvidence { readonly deliveryRef: string; readonly sourceRefs: readonly string[] }

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

/** The normal SessionPort already checked its byte codec. Keep its source and
 * envelope identities intact; a transcript item alone carries no attempt ID. */
function events(records: readonly SessionRecord[], address: Address): readonly Event[] | undefined {
  if (!identity(address.sessionId) || !identity(address.turnId)
    || !validateSessionContentJournal({ records, tornTail: false }, address.sessionId).ok) return undefined;

  const result: Event[] = [], seen = new Set<string>();

  for (const record of records) {
    if (record.type !== "envelope" || record.turnId !== address.turnId) continue;

    const parsed = parseEnvelope(record.payload.envelope);
    if (!parsed.ok) return undefined;

    const envelope = parsed.envelope;
    if (envelope.sessionId !== undefined && envelope.sessionId !== address.sessionId
      || envelope.turnId !== undefined && envelope.turnId !== address.turnId) return undefined;

    if (envelope.producerId !== "loop") continue;

    if (envelope.sessionId === undefined || envelope.turnId === undefined || !identity(envelope.attemptId)) continue;

    const key = canonicalJson([envelope.attemptId, envelope.eventId]);
    if (seen.has(key)) return undefined;

    seen.add(key);
    result.push({ record, envelope });
  }

  return result;
}

function boundary(values: readonly Event[], toolCallId: string): number | undefined {
  if (!identity(toolCallId)) return undefined;
  const matching = values.filter(({ envelope }) => envelope.kind === "tool_use"
    && envelope.payload.name === "central_learning" && envelope.payload.toolCallId === toolCallId
    && object(envelope.payload.arguments) && envelope.payload.arguments.operation === "report_advisory_use");
  return matching.length === 1 ? matching[0]!.record.sequence : undefined;
}

/** The host supplies the executing report call ID, never a model-supplied receipt.
 * Its durable tool_use fences later reads out of that report's evidence. */
export function advisoryReportBoundary(records: readonly SessionRecord[], input: Address & { readonly toolCallId: string }): number | undefined {
  const values = events(records, input);
  return values === undefined ? undefined : boundary(values, input.toolCallId);
}

function successfulReads(values: readonly Event[], before: number): readonly ToolRead[] | undefined {
  const requested = new Map<string, Event>(), closed = new Set<string>(), result: ToolRead[] = [];

  for (const current of values) {
    if (current.record.sequence >= before) break;

    const event = current.envelope, callId = event.payload.toolCallId;
    if (!identity(callId)) continue;

    const key = canonicalJson([event.attemptId!, callId]);

    if (event.kind === "tool_use" && event.payload.name === "central_learning") {
      if (requested.has(key)) return undefined;
      requested.set(key, current);
      continue;
    }

    if (event.kind !== "tool_result") continue;

    const use = requested.get(key);
    if (use === undefined) continue;

    if (closed.has(key)) return undefined;

    closed.add(key);
    const args = use.envelope.payload.arguments, payload = event.payload;
    if (!object(args) || !["read_advisory", "read_material", "read_response"].includes(String(args.operation))
      || payload.status !== "succeeded" || payload.truncated !== false || typeof payload.output !== "string"
      || !object(payload.value) || !Object.prototype.hasOwnProperty.call(payload.value, "result")) continue;

    let output: unknown;

    try { output = JSON.parse(payload.output); }
    catch { continue; }

    if (canonicalJson(output) !== canonicalJson(payload.value.result)) continue;

    result.push({ use, result: current, arguments: args as JsonObject, value: output });
  }

  return result;
}

function advisoryPage(value: unknown, advisory: Advisory): AdvisoryPage | undefined {
  if (!object(value) || value.ok !== true || !object(value.advisoryRead)) return undefined;

  const page = value.advisoryRead;
  if (!exact(page, ["ref", "version", "start", "end", "totalChars", "sourceHash", "text"])
    || page.ref !== advisory.ref || page.version !== advisory.version || !natural(page.start) || !natural(page.end)
    || !natural(page.totalChars) || page.totalChars < 1 || page.end <= page.start || page.end > page.totalChars
    || !hash(page.sourceHash) || typeof page.text !== "string" || page.text.length !== page.end - page.start) return undefined;

  return { ref: advisory.ref, version: advisory.version, start: page.start, end: page.end,
    totalChars: page.totalChars, sourceHash: page.sourceHash, text: page.text };
}

function pageMatchesCall(read: ToolRead, page: AdvisoryPage): boolean {
  const args = read.arguments;
  const addressMatches = args.operation === "read_advisory" ? args.ref === page.ref && args.version === page.version
    : args.operation === "read_material" && (args.evidenceRef === page.ref || args.evidenceRef === page.version)
      && (args.version === undefined || args.version === page.version);
  return addressMatches && page.start === (args.start ?? 0) && (args.maximumChars === undefined
    || natural(args.maximumChars) && args.maximumChars > 0 && page.end - page.start <= args.maximumChars);
}

function transportPage(value: unknown): TransportPage | undefined {
  if (!object(value) || !exact(value, ["status", "responseRef", "sourceHash", "unit", "start", "end", "totalBytes", "nextStart", "text"])
    || value.status !== "response_page" || !identity(value.responseRef) || !hash(value.sourceHash)
    || value.responseRef !== `central-response:${value.sourceHash}` || value.unit !== "utf8_bytes"
    || !natural(value.start) || !natural(value.end) || !natural(value.totalBytes) || value.end <= value.start
    || value.end > value.totalBytes || typeof value.text !== "string"
    || Buffer.byteLength(value.text, "utf8") !== value.end - value.start
    || value.nextStart !== (value.end < value.totalBytes ? value.end : null)) return undefined;
  return { status: "response_page", responseRef: value.responseRef, sourceHash: value.sourceHash, unit: "utf8_bytes",
    start: value.start, end: value.end, totalBytes: value.totalBytes,
    nextStart: value.end < value.totalBytes ? value.end : null, text: value.text };
}

/** Both source and transport ranges may be reread or overlap. They establish
 * coverage only when the overlapping original content agrees byte-for-byte. */
function assemble(ranges: readonly Range[], total: number, encoding: "utf8" | "utf16le"): string | undefined {
  const width = encoding === "utf8" ? 1 : 2;
  let joined = Buffer.alloc(0);

  for (const range of [...ranges].sort((left, right) => left.start - right.start || right.end - left.end)) {
    const text = Buffer.from(range.text, encoding), start = range.start * width;
    if (start > joined.length) return undefined;
    const overlap = Math.min(joined.length - start, text.length);
    if (!joined.subarray(start, start + overlap).equals(text.subarray(0, overlap))) return undefined;
    if (overlap < text.length) joined = Buffer.concat([joined, text.subarray(overlap)]);
  }

  return joined.length === total * width ? joined.toString(encoding) : undefined;
}

function decodedPages(reads: readonly ToolRead[], advisory: Advisory): readonly DeliveredPage[] {
  const result: DeliveredPage[] = [];

  for (const initial of reads) {
    if (initial.arguments.operation === "read_response") continue;

    const direct = advisoryPage(initial.value, advisory);
    if (direct !== undefined && pageMatchesCall(initial, direct)) {
      result.push({ page: direct, attemptId: initial.use.envelope.attemptId!, reads: [initial], completedAt: initial.result.record.sequence });
      continue;
    }

    const value = initial.value;
    if (!object(value) || !exact(value, ["status", "responseRef", "totalBytes", "instruction", "firstPage"])
      || value.status !== "paged_response" || typeof value.instruction !== "string") continue;

    const first = transportPage(value.firstPage);
    if (first === undefined || first.start !== 0 || value.responseRef !== first.responseRef || value.totalBytes !== first.totalBytes) continue;

    const pages: TransportPage[] = [first], used: ToolRead[] = [initial];

    for (const next of [undefined, ...reads]) {
      if (next !== undefined) {
        if (next.arguments.operation !== "read_response" || next.arguments.responseRef !== first.responseRef
          || next.use.envelope.attemptId !== initial.use.envelope.attemptId
          || next.use.record.sequence <= initial.result.record.sequence) continue;

        const page = transportPage(next.value);
        if (page === undefined || page.responseRef !== first.responseRef || page.sourceHash !== first.sourceHash
          || page.totalBytes !== first.totalBytes || page.start !== (next.arguments.start ?? 0)) continue;

        pages.push(page);
        used.push(next);
      }

      const whole = assemble(pages, first.totalBytes, "utf8");
      if (whole === undefined || contentHashOf(whole) !== first.sourceHash) continue;

      let body: unknown;

      try { body = JSON.parse(whole); }
      catch { break; }

      const page = advisoryPage(body, advisory);
      if (page !== undefined && pageMatchesCall(initial, page)) result.push({ page, attemptId: initial.use.envelope.attemptId!, reads: [...used],
        completedAt: used.at(-1)!.result.record.sequence });

      break;
    }
  }

  return result.sort((left, right) => left.completedAt - right.completedAt);
}

/** Read-only proof from the original successful tool returns. An exact-version
 * body must be covered in one attempt before this report's actual tool_use.
 * Transport fragments are reassembled before interpreting the strict wrapper. */
export function findAdvisoryReadEvidence(records: readonly SessionRecord[], input: Address & {
  readonly advisory: Advisory; readonly reportToolCallId?: string;
}): AdvisoryReadEvidence | undefined {
  if (!isContentAdvisoryRef(input.advisory)) return undefined;

  const values = events(records, input);
  if (values === undefined) return undefined;

  const before = input.reportToolCallId === undefined ? records.length : boundary(values, input.reportToolCallId);
  if (before === undefined) return undefined;

  const reads = successfulReads(values, before);
  if (reads === undefined) return undefined;

  const groups = new Map<string, DeliveredPage[]>();

  for (const delivered of decodedPages(reads, input.advisory)) {
    const page = delivered.page, key = canonicalJson([delivered.attemptId, page.sourceHash, page.totalChars]);
    const group = groups.get(key) ?? [];
    group.push(delivered);
    groups.set(key, group);
    const text = assemble(group.map(row => row.page), page.totalChars, "utf16le");
    if (text === undefined || contentHashOf(text) !== page.sourceHash) continue;

    const used = [...new Map(group.flatMap(row => row.reads).map(read => [read.result.record.sequence, read])).values()]
      .sort((left, right) => left.result.record.sequence - right.result.record.sequence);
    const addresses = used.map(read => ({ sessionId: input.sessionId, turnId: input.turnId,
      attemptId: read.use.envelope.attemptId!, toolCallId: read.use.envelope.payload.toolCallId,
      useEventId: read.use.envelope.eventId, resultEventId: read.result.envelope.eventId,
      useSequence: read.use.record.sequence, resultSequence: read.result.record.sequence }));

    return { deliveryRef: `advisory-read:${contentHashOf({ advisory: input.advisory, sourceHash: page.sourceHash, addresses })}`,
      sourceRefs: used.flatMap(read => [read.use, read.result]).map(row => `session:${input.sessionId}:${row.record.sequence}`) };
  }

  return undefined;
}
