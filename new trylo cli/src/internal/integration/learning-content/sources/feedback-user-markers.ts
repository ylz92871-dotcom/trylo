import type { BoardState } from "../../../learning/control/state.js";
import type { SessionRecord } from "../../../ports/session.js";
import type { ContentEvidenceRecord, ContentMaterialBatch, ContentPacket, ContentSubsystem } from "../../../learning/central/content/material-contract.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { decodeFeedbackSource } from "../../reward/explanation-source.js";
import { sessionContentChunkRunId, sessionContentRecordRef, sessionContentRecordView } from "./session.js";
import { sessionRecordOrigin } from "./session-decode.js";
import { mapBoardContentArtifacts } from "./artifact.js";
import { projectContentAdoptions } from "./adoption.js";
import type { ContentAdoption } from "./adoption-contract.js";
import { readContentRecords } from "../records.js";
import { fields, identity, sequence } from "../../../validation/json-shape.js";
import { contentSourceTextViewRef, projectContentSourceText } from "./source-text-view.js";

export interface IssueUserInputCandidate {
  readonly ref: string;
  readonly sourceHash: string;
  readonly coordinate: { readonly runId: string; readonly sequence: number };
  readonly originalSource?: { readonly ref: string; readonly runId: string; readonly sequence: number; readonly sourceHash: string };
  readonly scope: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly text: string;
  readonly adoptionRefs: readonly string[];
  readonly reviewedBy: readonly { readonly factId: string; readonly processId: string }[];
  readonly association: "unassigned_user_input_for_issue_review";
}

export type IssueUserInputCandidates = { readonly status: "ready"; readonly candidates: readonly IssueUserInputCandidate[];
  readonly sourceRef: string; readonly batch: ContentMaterialBatch } | { readonly status: "invalid"; readonly reason: string };

export interface IssueUserInputBasis {
  readonly schemaVersion: 1;
  readonly type: "actual_user_input_source_basis";
  readonly scope: string;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly coordinate: IssueUserInputCandidate["coordinate"];
  readonly totalChars: number;
  readonly reviewedBy: IssueUserInputCandidate["reviewedBy"];
  readonly originalSource?: NonNullable<IssueUserInputCandidate["originalSource"]>;
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Authenticate the owner's closed identity format, not its semantic interpretation or prior entry claim.
 * Clean v1 markers retain their original bytes; projected markers bind the raw locator to the shared source-view owner. */
export function parseIssueUserInputBasis(record: ContentEvidenceRecord): IssueUserInputBasis | undefined {
  if (record.origin !== "execution_result" || record.runId !== record.ref || record.sequence !== 0
    || record.ref !== `content-user-source-basis:${contentHashOf(record.text)}`) return undefined;

  let raw: unknown;

  try { raw = JSON.parse(record.text); }
  catch { return undefined; }

  const keys = ["schemaVersion", "type", "scope", "sourceRef", "sourceHash", "sessionId", "turnId", "coordinate", "totalChars", "reviewedBy"];
  if (!fields(raw, keys) && !fields(raw, [...keys, "originalSource"])) return undefined;

  if (raw.schemaVersion !== 1 || raw.type !== "actual_user_input_source_basis" || raw.scope !== record.scope
    || typeof raw.scope !== "string" || raw.scope.length === 0 || !identity(raw.sessionId) || raw.turnId !== null && !identity(raw.turnId)
    || !identity(raw.sourceRef) || !hash(raw.sourceHash) || !sequence(raw.totalChars)
    || !fields(raw.coordinate, ["runId", "sequence"]) || !identity(raw.coordinate.runId) || !sequence(raw.coordinate.sequence)
    || !Array.isArray(raw.reviewedBy) || raw.reviewedBy.length > 64
    || !raw.reviewedBy.every(item => fields(item, ["factId", "processId"]) && identity(item.factId) && identity(item.processId))
    || canonicalJson(raw) !== record.text) return undefined;

  let originalSource: IssueUserInputBasis["originalSource"];

  if (Object.hasOwn(raw, "originalSource")) {
    const original = raw.originalSource;
    if (!fields(original, ["ref", "runId", "sequence", "sourceHash"]) || original.runId !== raw.sessionId || !sequence(original.sequence)
      || original.ref !== sessionContentRecordRef(raw.sessionId, original.sequence) || !hash(original.sourceHash)
      || raw.sourceRef !== contentSourceTextViewRef(original.ref, original.sourceHash, raw.sourceHash)
      || raw.coordinate.runId !== raw.sourceRef || raw.coordinate.sequence !== 0) return undefined;
    originalSource = { ref: original.ref, runId: original.runId, sequence: original.sequence, sourceHash: original.sourceHash };
  } else if (raw.coordinate.runId !== raw.sessionId || raw.sourceRef !== sessionContentRecordRef(raw.sessionId, raw.coordinate.sequence)) return undefined;

  return { schemaVersion: 1, type: "actual_user_input_source_basis", scope: raw.scope, sourceRef: raw.sourceRef, sourceHash: raw.sourceHash,
    sessionId: raw.sessionId, turnId: raw.turnId, coordinate: { runId: raw.coordinate.runId, sequence: raw.coordinate.sequence },
    totalChars: raw.totalChars, reviewedBy: raw.reviewedBy.map(item => ({ factId: item.factId, processId: item.processId })),
    ...(originalSource === undefined ? {} : { originalSource }) };
}

/** Receipt membership only. Same-turn input preceded delivery but entered the same real request. No negative label is inferred. */
export function issueUserInputCandidatesFromAdoptions(input: { readonly scope: string; readonly issueId: string; readonly sessionId: string;
  readonly records: readonly SessionRecord[]; readonly adoptions: readonly ContentAdoption[]; readonly secrets?: readonly string[] }): readonly IssueUserInputCandidate[] {
  const adopted = input.adoptions.filter(row => row.sessionId === input.sessionId && row.artifact.issueIds.includes(input.issueId));
  return input.records.flatMap(record => {
    if (sessionRecordOrigin(record) !== "user_statement") return [];

    const linked = adopted.filter(row => record.sequence > (row.sourceSequence ?? Number.MAX_SAFE_INTEGER)
      || record.turnId !== undefined && row.turnId === record.turnId);
    if (linked.length === 0) return [];

    const view = sessionContentRecordView(record, input.scope, input.secrets);
    if (view === undefined || !view.record.text.trim()) return [];

    return [{ ref: view.record.ref, sourceHash: contentHashOf(view.record.text),
      coordinate: { runId: view.record.runId, sequence: view.record.sequence }, scope: input.scope, sessionId: input.sessionId,
      ...(view.changed ? { originalSource: view.original } : {}),
      ...(record.turnId === undefined ? {} : { turnId: record.turnId }), text: view.record.text, adoptionRefs: linked.map(row => row.ref),
      reviewedBy: [],
      association: "unassigned_user_input_for_issue_review" as const }];
  });
}

function basis(candidate: IssueUserInputCandidate) {
  const text = canonicalJson({ schemaVersion: 1, type: "actual_user_input_source_basis", scope: candidate.scope,
    sourceRef: candidate.ref, sourceHash: candidate.sourceHash, sessionId: candidate.sessionId, turnId: candidate.turnId ?? null,
    coordinate: candidate.coordinate, totalChars: candidate.text.length, reviewedBy: candidate.reviewedBy,
    ...(candidate.originalSource === undefined ? {} : { originalSource: candidate.originalSource }) });
  const ref = `content-user-source-basis:${contentHashOf(text)}`;
  return { ref, runId: ref, sequence: 0, scope: candidate.scope, origin: "execution_result" as const, text };
}

/** Neutral source markers travel alongside the original requirement/chunks; a marker alone does not prove text entered a packet. */
export function issueUserInputBasisBatch(input: { readonly candidates: readonly IssueUserInputCandidate[];
  readonly issueId: string; readonly subsystem: ContentSubsystem }): ContentMaterialBatch {
  const records = input.candidates.map(basis);
  return { records, requirements: [], answers: [], materials: records.map(record => ({ id: `user-input-review:${contentHashOf([input.issueId, record.ref])}`,
    kind: "feedback" as const, subsystem: input.subsystem, context: "Source-owned user-input identity only. Compare the actual source text; no correction target, sign, result or gain has been inferred.",
    recordRefs: [record.ref], requirementIds: [], answerIds: [], links: { issueIds: [input.issueId], topicIds: [], artifactRefs: [] } })) };
}

/** Pure journal/Board lookup, with no SFN estimation or model call. Exact actual adoptions supply the issue association. */
export function laterIssueUserInputCandidates(input: { readonly board: BoardState; readonly scope: string; readonly issueId: string;
  readonly sessionId: string; readonly records: readonly SessionRecord[]; readonly tornTail?: boolean; readonly secrets?: readonly string[] }): IssueUserInputCandidates {
  const decoded = decodeFeedbackSource({ records: input.records, tornTail: input.tornTail ?? false }, input.sessionId);
  if (!decoded.ok) return { status: "invalid", reason: decoded.reason };

  try {
    const artifacts = mapBoardContentArtifacts(input.board, input.scope).filter(row => row.issueIds.includes(input.issueId));
    const adoption = projectContentAdoptions({ board: input.board, scope: input.scope, sessionId: input.sessionId,
      records: input.records, bindings: decoded.source.bindings, artifacts });
    const candidates = withReviewedUserInputProofs({ ...input,
      candidates: issueUserInputCandidatesFromAdoptions({ ...input, adoptions: adoption.adoptions }) });

    return { status: "ready", candidates,
      sourceRef: `content-issue-user-input:${contentHashOf({ scope: input.scope, issueId: input.issueId, sessionId: input.sessionId,
        sources: candidates.map(({ ref, sourceHash, coordinate }) => ({ ref, sourceHash, coordinate })) })}`,
      batch: issueUserInputBasisBatch({ candidates, issueId: input.issueId, subsystem: artifacts[0]?.subsystem ?? "collaboration" }) };
  } catch { return { status: "invalid", reason: "content_issue_user_source_invalid" }; }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function metadata(context: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(context);
    return object(value) ? value : undefined;
  }
  catch { return undefined; }
}

/** Collect only text segments with verified source-owner identities, never arbitrary context prose or a claimed verdict. */
function enteredRanges(packet: ContentPacket, candidate: Pick<IssueUserInputCandidate,
  "ref" | "scope" | "sourceHash" | "coordinate" | "text" | "originalSource">): readonly { readonly start: number; readonly end: number }[] {
  if (packet.scope !== candidate.scope) return [];

  const ranges: { readonly start: number; readonly end: number }[] = [];

  for (const record of packet.records) {
    if (record.origin !== "user_statement") continue;

    if (record.ref === candidate.ref && record.runId === candidate.coordinate.runId && record.sequence === candidate.coordinate.sequence
      && record.text === candidate.text && contentHashOf(record.text) === candidate.sourceHash) return [{ start: 0, end: candidate.text.length }];

    const contexts = packet.materials.filter(row => row.recordRefs.includes(record.ref)).map(row => metadata(row.context)).filter(row => row !== undefined);

    for (const context of contexts) {
      const start = context.start, end = context.end;
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 || typeof end !== "number" || end !== start + record.text.length
        || end > candidate.text.length || record.text.length === 0 || record.text !== candidate.text.slice(start, end)) continue;

      if (record.ref === `${candidate.ref}:chunk:${start}` && record.runId === sessionContentChunkRunId(candidate.coordinate.runId, candidate.coordinate.sequence)
        && context.coordinateKind === "exact_source_chunk_projection" && context.originalRef === candidate.ref
        && context.originalRunId === candidate.coordinate.runId && context.originalSequence === candidate.coordinate.sequence
        && context.sourceHash === candidate.sourceHash && context.totalChars === candidate.text.length) ranges.push({ start, end });
    }

    for (const context of contexts) {
      if (context.role !== "exact_source_page_not_complete_parent" || context.parentRef !== candidate.ref || context.sourceHash !== candidate.sourceHash
        || typeof context.start !== "number" || !Number.isSafeInteger(context.start) || context.start < 0
        || context.end !== context.start + record.text.length || context.totalChars !== candidate.text.length || !object(context.originalCoordinate)
        || context.originalCoordinate.runId !== candidate.coordinate.runId || context.originalCoordinate.sequence !== candidate.coordinate.sequence
        || record.text.length === 0 || record.text !== candidate.text.slice(context.start, Number(context.end))) continue;

      if (context.originalSource !== undefined && (candidate.originalSource === undefined
        || canonicalJson(context.originalSource) !== canonicalJson(candidate.originalSource))) continue;

      const page = { ref: context.requestedRef, originalRef: context.parentRef, origin: record.origin, originalScope: context.originalScope,
        start: context.start, end: context.end, totalChars: context.totalChars, text: record.text, sourceHash: context.sourceHash,
        coordinate: context.originalCoordinate, owner: context.sourceOwner,
        ...(context.originalSource === undefined ? {} : { originalSource: context.originalSource }) };
      const ref = `content-source-page:${contentHashOf(page)}`;
      if (record.ref === ref && record.runId === ref && record.sequence === 0) ranges.push({ start: context.start, end: Number(context.end) });
    }
  }

  return ranges;
}

function mergedRanges(ranges: readonly { readonly start: number; readonly end: number }[]) {
  const merged: { start: number; end: number }[] = [];

  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  return merged;
}

function complete(ranges: readonly { readonly start: number; readonly end: number }[], length: number): boolean {
  const merged = mergedRanges(ranges);
  return merged.length === 1 && merged[0]!.start === 0 && merged[0]!.end === length;
}

/** A durable proof is obtained only by replaying completed source-owning CONTENT facts that actually transported every source segment.
 * Stop at the earliest complete prefix so later bookkeeping or compact saves cannot churn an established proof.
 */
export function withReviewedUserInputProofs(input: { readonly board: BoardState; readonly scope: string; readonly issueId: string;
  readonly candidates: readonly IssueUserInputCandidate[] }): readonly IssueUserInputCandidate[] {
  const records = readContentRecords(input.board.rewardV2Facts ?? [], input.scope, input.board.sequence).filter(record =>
    record.packet.focus?.issueId === input.issueId || record.packet.materials.some(material => material.links.issueIds.includes(input.issueId)));
  return input.candidates.map(candidate => {
    let ranges: { readonly start: number; readonly end: number }[] = [];
    const reviewedBy: { readonly factId: string; readonly processId: string }[] = [];

    for (const record of records) {
      const next = mergedRanges([...ranges, ...enteredRanges(record.packet, candidate)]);
      if (canonicalJson(next) !== canonicalJson(ranges)) reviewedBy.push({ factId: record.factId, processId: record.output.processId });
      ranges = next;
      if (complete(ranges, candidate.text.length)) return { ...candidate, reviewedBy };
    }

    return { ...candidate, reviewedBy: [] };
  });
}

/** A newly emitted basis marker alone never qualifies as source entry. Only full exact material or an owner-replayed durable entry proof does. */
export function hasCandidateEnteredPacket(packet: ContentPacket, candidate: IssueUserInputCandidate): boolean {
  return packet.scope === candidate.scope && (candidate.reviewedBy.length > 0 || complete(enteredRanges(packet, candidate), candidate.text.length));
}

/** Shared exact entry proof for canonical user-origin feedback sources. A locator,
 * summary or known hash contributes no range; completed inputs may retain genuine pages across compaction. */
export function hasUserStatementSourceEnteredPackets(packets: readonly ContentPacket[], source: ContentEvidenceRecord,
  secrets: readonly string[] = []): boolean {
  if (source.origin !== "user_statement") return false;
  const view = projectContentSourceText(source, secrets), record = view.record;
  const candidate = { ref: record.ref, scope: record.scope, sourceHash: contentHashOf(record.text), text: record.text,
    coordinate: { runId: record.runId, sequence: record.sequence }, ...(view.changed ? { originalSource: view.original } : {}) };
  return complete(packets.flatMap(packet => enteredRanges(packet, candidate)), record.text.length);
}
