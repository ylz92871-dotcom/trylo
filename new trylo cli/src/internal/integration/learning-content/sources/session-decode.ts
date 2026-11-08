import { SESSION_FORMAT_VERSION, SESSION_RECORD_TYPES, isRuntimeFingerprint, type SessionRecord, type SessionRecordView } from "../../../ports/session.js";
import { isTranscriptItem } from "../../../protocol/transcript.js";
import { parseEnvelope } from "../../../protocol/validate.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentEvidenceRecord, ContentMaterial, ContentMaterialBatch, ContentRequirement } from "../../../learning/central/content/material-contract.js";
import type { SessionContentCoverage, SessionContentInput } from "./session-contract.js";
import type { TopicEvidenceOrigin } from "../../../learning/domains/shared/topics/contracts.js";
import { projectContentSourceText, contentSourceViewContext, type ContentSourceTextView } from "./source-text-view.js";
import { buildRequiredUserIndex, type RequiredUserIndex } from "./session-required-index.js";
import { isMethodLearningControlObservation } from "../../../learning/agent/subsystems/method/control-observation.js";
import { isPublicToolResultPart, isPublicToolResultManifest } from "../../../protocol/public-tool-result.js";
import { isSelectedPromptBudgetObservation } from "../../../protocol/prompt-budget-observation.js";

export const sessionContentRecordRef = (sessionId: string, sequence: number): string => `session-content:${contentHashOf([sessionId, sequence])}`;
export const sessionContentChunkRunId = (runId: string, sequence: number): string => `session-content-chunks:${contentHashOf([runId, sequence])}`;

type Decoded = { readonly record: ContentEvidenceRecord; readonly material: ContentMaterial; readonly required: boolean;
  readonly requirement?: ContentRequirement; readonly callRef?: string; readonly originalRef: string; readonly fullRef: string; readonly sourceView: ContentSourceTextView };

export type DecodedSessionContent = { readonly ok: true; readonly batch: ContentMaterialBatch; readonly taskPurpose: string;
  readonly coverage: SessionContentCoverage; readonly requiredSources: readonly ContentSourceTextView[]; readonly requiredIndex?: RequiredUserIndex } | { readonly ok: false; readonly reason: string };

type ProjectionInput = Omit<SessionContentInput, "session" | "enabled"> & { readonly envelopeSequences?: readonly number[];
  readonly publicTexts?: ReadonlyMap<number, string> };

/** Read the journal's actual public text. Reasoning blocks and partial provider streams never enter learning material. */
export function decodeSessionContent(view: SessionRecordView, input: ProjectionInput): DecodedSessionContent {
  const valid = validateSessionContentJournal(view, input.sessionId);
  if (!valid.ok) return valid;

  const through = input.through ?? view.records.length - 1;
  if (!Number.isSafeInteger(through) || through < 0 || through >= view.records.length) return { ok: false, reason: "content_source_watermark_unavailable" };

  const maximumRecords = input.maximumRecords ?? 32, maximumChars = input.maximumChars ?? 48000;
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 64
    || !Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 65536) return { ok: false, reason: "content_source_capacity_invalid" };

  const selected = view.records.filter(record => record.sequence <= through && record.turnId === input.turnId);
  const decoded: Decoded[] = [], calls = new Map<string, string>();

  for (const record of selected) {
    const projected = projectRecord(record, input, valid.workspaceId, calls);
    if (projected === "invalid") return { ok: false, reason: "content_source_transcript_invalid" };
    if (projected !== undefined) decoded.push(...projected);
  }

  const required = decoded.filter(row => row.required), requiredSources = required.map(row => row.sourceView), included = new Set(required.map(row => row.record.ref));
  let chars = required.reduce((sum, row) => sum + size(row), 0);
  let requiredIndex: RequiredUserIndex | undefined;

  if (required.length > maximumRecords || chars > maximumChars) {
    const indexed = buildRequiredUserIndex({ sources: requiredSources, sessionId: input.sessionId, turnId: input.turnId, through,
      scope: input.scope, subsystem: input.subsystem, maximumChars });
    if (!indexed.ok) return indexed;
    requiredIndex = indexed.value;
    included.clear();
    chars = canonicalJson(requiredIndex.batch).length;
  }

  for (const row of [...decoded].reverse()) {
    if (included.has(row.record.ref)) continue;

    if (requiredIndex !== undefined && row.record.origin === "user_statement") continue;

    const call = row.callRef === undefined ? undefined : decoded.find(item => item.record.ref === row.callRef);
    const group = [row, ...(call === undefined || included.has(call.record.ref) ? [] : [call])];
    const cost = group.reduce((sum, item) => sum + size(item), 0);
    if (included.size + group.length + (requiredIndex === undefined ? 0 : 1) <= maximumRecords && chars + cost <= maximumChars) {
      group.forEach(item => included.add(item.record.ref));
      chars += cost;
    }
  }

  const visible = decoded.filter(row => included.has(row.record.ref));
  const aliases = sourceAliases(decoded, included);
  const base = requiredIndex?.batch;
  const batch = { records: [...(base?.records ?? []), ...visible.map(row => row.record)], requirements: [...(base?.requirements ?? []), ...visible.flatMap(row => row.requirement === undefined ? [] : [row.requirement])],
    answers: [], materials: [...(base?.materials ?? []), ...visible.map(row => row.material)], ...(aliases.length === 0 ? {} : { aliases }) };

  return { ok: true, batch, requiredSources, ...(requiredIndex === undefined ? {} : { requiredIndex }), taskPurpose: requiredIndex?.taskPurpose ?? required.map(row => row.record.text).join("\n"), coverage: {
    sessionId: input.sessionId, turnId: input.turnId, workspaceId: valid.workspaceId, observedThrough: through,
    considered: decoded.length, included: visible.length, omitted: decoded.filter(row => !included.has(row.record.ref)).map(row => row.record.ref),
    tornTail: view.tornTail, coverage: "bounded_turn", ...(requiredIndex === undefined ? {} : { requiredUserTransport: { kind: "indexed" as const,
      availableSources: requiredIndex.availableSources, shownSources: requiredIndex.shownSources, omittedSources: requiredIndex.availableSources - requiredIndex.shownSources,
      catalogRef: requiredIndex.catalog.ref } }) } };
}

export function validateSessionContentJournal(view: SessionRecordView, sessionId: string): { readonly ok: true; readonly workspaceId: string } | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(view.records) || typeof view.tornTail !== "boolean") return { ok: false, reason: "content_source_journal_invalid" };

  const first = view.records[0];
  if (first?.type !== "session_start" || !isRuntimeFingerprint(first.payload.fingerprint)) return { ok: false, reason: "content_source_identity_missing" };

  for (const [index, record] of view.records.entries()) {
    if (record.sequence !== index || record.sessionId !== sessionId || record.formatVersion !== SESSION_FORMAT_VERSION
      || !(SESSION_RECORD_TYPES as readonly string[]).includes(record.type) || typeof record.payload !== "object" || record.payload === null) {
      return { ok: false, reason: "content_source_journal_invalid" };
    }
  }

  return { ok: true, workspaceId: first.payload.fingerprint.workspaceId };
}

function projectRecord(record: SessionRecord, input: ProjectionInput,
  workspaceId: string, calls: Map<string, string>): readonly Decoded[] | "invalid" | undefined {
  if (record.type === "transcript_item" && !isTranscriptItem(record.payload)) return "invalid";

  const item: Readonly<Record<string, unknown>> = record.payload;
  const user = record.type === "turn_input" && typeof item.text === "string" || record.type === "transcript_item" && item.kind === "user";
  const toolCall = record.type === "transcript_item" && item.kind === "tool_call";
  const toolResult = record.type === "transcript_item" && item.kind === "tool_result";
  if ((toolCall || toolResult) && typeof item.name === "string" && input.excludeToolNames?.includes(item.name)) return undefined;

  const answer = record.type === "transcript_item" && item.kind === "assistant_text";
  const envelope = record.type === "envelope" && input.envelopeSequences?.includes(record.sequence) === true && sessionRecordOrigin(record) !== undefined;
  if (!user && !toolCall && !toolResult && !answer && !envelope && record.type !== "terminal") return undefined;

  const view = sessionContentRecordView(record, input.scope, input.secrets, input.excludeToolNames, input.publicTexts?.get(record.sequence));
  if (view === undefined || !view.record.text.trim()) return undefined;

  const { ref, text } = view.record;
  const callRef = toolResult && typeof item.toolCallId === "string" ? calls.get(item.toolCallId) : undefined;

  if (toolCall && typeof item.toolCallId === "string") calls.set(item.toolCallId, ref);

  const requirement: ContentRequirement | undefined = !user ? undefined : { id: ref,
    requirement: text.length <= 8192 ? text : `Complete public user requirement view is retained at ${ref}.`,
    answerRequirement: text.length <= 8192 ? text : `Read the complete original requirement at ${ref}; no stronger requirement was inferred.`,
    conditions: [`Original session ${input.sessionId}, turn ${input.turnId}; preserve its stated scope and answer requirements.`], sourceRefs: [ref] };
  const originalContext = canonicalJson({ source: "canonical_session_journal", sessionId: input.sessionId, turnId: input.turnId,
    workspaceId, journalSequence: record.sequence, sourceRecordType: record.type, originalTranscriptSequence: item.sequence ?? null,
    role: user ? "original_user_requirement" : answer ? "public_assistant_report_not_verification" : toolResult ? "reported_tool_result_not_task_or_learning_gain" : record.type,
    ...(toolCall || toolResult ? { toolCallId: item.toolCallId ?? null, toolName: item.name ?? null } : {}),
    ...(toolResult ? { reportedOutcome: item.outcome ?? null, truncated: item.truncated ?? null, callRef: callRef ?? null } : {}) });
  const projected: Decoded = { required: user, originalRef: view.original.ref, fullRef: ref, sourceView: view,
    ...(requirement === undefined ? {} : { requirement }), ...(callRef === undefined ? {} : { callRef }), record: view.record,
    material: { id: ref, kind: user ? "requirement" : "experience", subsystem: input.subsystem,
      context: view.changed ? contentSourceViewContext(view, originalContext) : originalContext,
      recordRefs: [ref, ...(callRef === undefined ? [] : [callRef])], requirementIds: requirement === undefined ? [] : [requirement.id], answerIds: [],
      links: { issueIds: [], topicIds: [], artifactRefs: [] } } };

  // Required user text must fit with its context/requirement metadata, including JSON escaping.
  return text.length > 32768 || user && size(projected) > (input.maximumChars ?? 48000) ? chunkProjection(projected) : [projected];
}

/** The same public view feeds inline records, raw-address lookup, catalog previews and source pages. */
export function sessionContentRecordView(record: SessionRecord, scope: string, secrets: readonly string[] = [],
  excluded: readonly string[] = [], publicText?: string): ContentSourceTextView | undefined {
  const text = publicText ?? sessionRecordPublicText(record, excluded), origin = sessionRecordOrigin(record);
  if (text === undefined || origin === undefined) return undefined;
  return projectContentSourceText({ ref: sessionContentRecordRef(record.sessionId, record.sequence), runId: record.sessionId,
    sequence: record.sequence, scope, origin, text }, secrets);
}

/** Same public-text policy for inline transport and exact source paging. */
export function sessionRecordPublicText(record: SessionRecord, excluded: readonly string[] = []): string | undefined {
  if (sessionRecordOrigin(record) === undefined) return undefined;

  if (record.type === "transcript_item" && !isTranscriptItem(record.payload)) return undefined;

  if (record.type === "envelope") {
    const parsed = parseEnvelope(record.payload.envelope);
    return !parsed.ok || isPublicToolResultManifest(parsed.envelope) ? undefined : canonicalJson(record.payload.envelope);
  }

  const item: Readonly<Record<string, unknown>> = record.payload;
  const user = record.type === "turn_input" || record.type === "transcript_item" && item.kind === "user";
  const tool = record.type === "transcript_item" && (item.kind === "tool_call" || item.kind === "tool_result");
  if (tool && typeof item.name === "string" && excluded.includes(item.name)) return undefined;

  if (user || record.type === "transcript_item" && item.kind === "assistant_text") return typeof item.text === "string" ? item.text : undefined;

  if (tool && item.kind === "tool_result") return typeof item.output === "string" ? item.output : undefined;

  if (record.type === "terminal") {
    // Original producer metadata is verified separately; it is neither terminal
    // business text nor a change to that public source's hash or directory.
    const { providerReturnObservation: _providerReturnObservation, ...publicTerminal } = item;
    return canonicalJson(publicTerminal);
  }

  return tool ? canonicalJson(item) : undefined;
}

/** Closed transport roles, not semantic learning scenarios; hidden/partial provider data has no public source role. */
export function sessionRecordOrigin(record: SessionRecord): TopicEvidenceOrigin | undefined {
  if (record.type === "turn_input" || record.type === "transcript_item" && record.payload.kind === "user") return "user_statement";

  if (record.type === "transcript_item" && record.payload.kind === "assistant_text") return "model_proposal";

  if (record.type === "terminal" || record.type === "transcript_item" && (record.payload.kind === "tool_call" || record.payload.kind === "tool_result")) return "execution_result";

  if (record.type !== "envelope") return undefined;

  const parsed = parseEnvelope(record.payload.envelope);
  if (!parsed.ok) return undefined;

  const event = parsed.envelope;
  if (isSelectedPromptBudgetObservation(event)) return undefined;

  if (isPublicToolResultPart(event)) return undefined;

  // The native subagent producer journals private recovery chunks in the PA
  // session, but deliberately never exposes them as activity or business data.
  // Filter their complete original record before catalogs, locators or pages.
  if (event.kind === "observation" && (event.payload.checkpointPart !== undefined
    || isMethodLearningControlObservation(event.payload))) return undefined;

  return ["tool_use", "tool_result", "terminal", "observation", "permission"].includes(event.kind) ? "execution_result" : undefined;
}

function chunkProjection(original: Decoded): readonly Decoded[] {
  const rows: Decoded[] = [], sourceHash = contentHashOf(original.record.text), originalRef = original.record.ref;
  let start = 0;

  while (start < original.record.text.length) {
    let end = Math.min(original.record.text.length, start + 8192);
    const point = original.record.text.charCodeAt(end);
    if (end < original.record.text.length && point >= 0xdc00 && point <= 0xdfff) end -= 1;

    const ref = `${originalRef}:chunk:${start}`, requirement = start === 0 && original.requirement !== undefined
      ? { ...original.requirement, id: ref, sourceRefs: [ref], requirement: `Original user requirement at ${originalRef} spans ${original.record.text.length} characters; read its exact source pages.`,
        answerRequirement: `Read the original requirement pages under source hash ${sourceHash}; the visible chunk is incomplete.` } : undefined;

    rows.push({ required: original.required && start === 0, originalRef: original.originalRef, fullRef: original.fullRef, sourceView: original.sourceView,
      ...(requirement === undefined ? {} : { requirement }),
      ...(original.callRef === undefined ? {} : { callRef: original.callRef }),
      record: { ...original.record, ref, runId: sessionContentChunkRunId(original.record.runId, original.record.sequence),
        sequence: rows.length, text: original.record.text.slice(start, end) },
      material: { ...original.material, id: ref, context: canonicalJson({ originalContext: original.material.context,
        coordinateKind: "exact_source_chunk_projection", originalRef, originalRunId: original.record.runId,
        originalSequence: original.record.sequence, sourceHash, start, end, totalChars: original.record.text.length,
        transport: "partial_source_chunk", pagingAvailable: true }),
        recordRefs: [ref, ...(original.callRef === undefined ? [] : [original.callRef])], requirementIds: requirement === undefined ? [] : [requirement.id] } });
    start = end;
  }

  return rows;
}

function sourceAliases(decoded: readonly Decoded[], included: ReadonlySet<string>): NonNullable<ContentMaterialBatch["aliases"]> {
  const result = new Map<string, readonly string[]>();

  for (const row of decoded.filter(item => included.has(item.record.ref))) {
    // Aliases identify transported slices. Each chunk retains full-source hash/range
    // and explicit partial status; coverage separately lists every omitted chunk.
    const targets = decoded.filter(item => item.fullRef === row.fullRef && included.has(item.record.ref)).map(item => item.record.ref);
    for (const ref of new Set([row.originalRef, row.fullRef])) if (!targets.includes(ref)) result.set(ref, targets);
  }

  return [...result].map(([ref, recordRefs]) => ({ ref, recordRefs }));
}

const size = (row: Decoded): number => canonicalJson([row.record, row.material, row.requirement ?? null]).length;
