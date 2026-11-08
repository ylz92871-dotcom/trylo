import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentArtifactRef, ContentEvidenceRecord, ContentMaterial, ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import { mergeContentBatches } from "../../../learning/central/content/material.js";
import type { TopicEvidenceOrigin } from "../../../learning/domains/shared/topics/contracts.js";
import { projectContentSourceText, contentSourceViewContext, type ContentSourceTextView } from "./source-text-view.js";

export interface FeedbackMaterialCoverage {
  readonly available: number;
  readonly shown: number;
  readonly omitted: number;
  readonly availableRefs: readonly string[];
  readonly shownRefs: readonly string[];
  readonly omittedRefs: readonly string[];
  readonly deferredRecordRefs: readonly string[];
}

export type FeedbackMaterialPage = { readonly ok: true; readonly originalRef: string; readonly start: number;
  readonly totalChars: number; readonly text: string; readonly nextStart: number | null;
  readonly end: number; readonly origin: TopicEvidenceOrigin; readonly originalScope: string; readonly sourceHash: string;
  readonly originalCoordinate: { readonly runId: string; readonly sequence: number };
  readonly originalSource?: ContentSourceTextView["original"] }
  | { readonly ok: false; readonly reason: "content_feedback_material_missing" | "content_feedback_page_invalid" };

export interface FeedbackMaterialTransport {
  readonly batch: ContentMaterialBatch;
  readonly coverage: FeedbackMaterialCoverage;
  readonly readMaterial: (ref: string, start?: number, maximumChars?: number) => FeedbackMaterialPage;
  readonly listMaterials: (start?: number, maximum?: number) => {
    readonly available: number; readonly nextStart: number | null; readonly materials: readonly ContentMaterial[];
  };
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function historyHeads(value: unknown): unknown {
  if (!Array.isArray(value)) return { available: 0, shown: [], omitted: 0 };

  const rows = value.filter(object);
  const selected = rows.filter(row => row.state === "active");
  const first = rows[0];
  if (first && !selected.includes(first)) selected.unshift(first);

  return { available: rows.length, shown: selected.map(row => {
    const feedback = row.feedback;
    if (!object(feedback)) return row;

    const evidenceIds = Array.isArray(feedback.evidenceIds) ? feedback.evidenceIds : [];

    return { state: row.state, feedbackArrayIndex: row.feedbackArrayIndex,
      feedback: { id: feedback.id, exposureId: feedback.exposureId, source: feedback.source, origin: feedback.origin,
        outcome: feedback.outcome, attribution: feedback.attribution, observedAt: feedback.observedAt,
        supersedes: feedback.supersedes ?? null, evidenceIds: evidenceIds.slice(0, 4),
        evidenceReferenceDisplay: { available: evidenceIds.length, shown: Math.min(evidenceIds.length, 4), omitted: Math.max(0, evidenceIds.length - 4) } } };
  }), omitted: rows.length - selected.length };
}

/** A derived view of original/active feedback heads, never a rewrite under the full source's ref. */
function feedbackHeadProjection(record: ContentEvidenceRecord): string | undefined {
  let raw: unknown;

  try { raw = JSON.parse(record.text); }
  catch { return undefined; }

  if (!object(raw)) return undefined;

  if (raw.role === "board_explicit_user_feedback_without_requiring_current_session_binding") {
    return canonicalJson({ role: "public_feedback_head_projection", originalFullRef: record.ref,
      exposure: raw.exposure, history: historyHeads(raw.history), issueIds: raw.issueIds, artifactRefs: raw.artifactRefs,
      sourcePosition: raw.sourcePosition, reportStatus: raw.reportStatus, taskResult: raw.taskResult, learningGain: raw.learningGain,
      read: { ref: record.ref, start: 0, maximumChars: 8192 }, interpretation: raw.interpretation });
  }

  if (raw.role === "feedback_for_learning_problem_review" && object(raw.legacy)) {
    return canonicalJson({ role: "public_feedback_head_projection", originalFullRef: record.ref, link: raw.link,
      sourcePosition: raw.sourcePosition, boardPosition: raw.boardPosition, association: raw.association, report: raw.report,
      legacyStatus: raw.legacy.status, history: historyHeads(raw.legacy.feedbackHistory), revision: raw.revision,
      taskResult: raw.taskResult, cost: raw.cost, learningGain: raw.learningGain,
      read: { ref: record.ref, start: 0, maximumChars: 8192 }, interpretation: "feedback_heads_are_not_independent_trials_or_identified_learning_gain" });
  }

  return undefined;
}

/** Only this owner can build the approved original/active feedback-head view.
 * Deferred evidence locators remain useful transport, but do not prove the complete head entered a model. */
export function contentFeedbackHeadMaterial(record: ContentEvidenceRecord): {
  readonly record: ContentEvidenceRecord;
  readonly entryBasis: "complete_original_and_active_heads" | "head_evidence_references_deferred";
} | undefined {
  const text = feedbackHeadProjection(record);
  if (text === undefined || text.length > 8000) return undefined;

  const head: unknown = JSON.parse(text);
  if (!object(head) || !object(head.history) || !Array.isArray(head.history.shown)) return undefined;

  const completeEvidence = head.history.shown.every(row => object(row) && object(row.feedback)
    && object(row.feedback.evidenceReferenceDisplay) && row.feedback.evidenceReferenceDisplay.omitted === 0);
  const ref = `content-feedback-heads:${contentHashOf(text)}`;

  return { record: { ref, runId: ref, sequence: 0, scope: record.scope, origin: "execution_result", text },
    entryBasis: completeEvidence ? "complete_original_and_active_heads" : "head_evidence_references_deferred" };
}

function matches(material: ContentMaterial, issueId: string | undefined, artifacts: readonly ContentArtifactRef[]): boolean {
  return issueId !== undefined && material.links.issueIds.includes(issueId)
    || artifacts.some(artifact => material.links.artifactRefs.some(ref => ref.id === artifact.id && ref.version === artifact.version));
}

function boundedMaterial(material: ContentMaterial, recordRefs: readonly string[], metadataRef: string,
  query: { readonly issueId?: string; readonly artifactRefs: readonly ContentArtifactRef[] }): ContentMaterial {
  const issueIds = [...material.links.issueIds].sort((left, right) => Number(right === query.issueId) - Number(left === query.issueId));
  const artifactRefs = [...material.links.artifactRefs].sort((left, right) =>
    Number(query.artifactRefs.some(ref => ref.id === right.id && ref.version === right.version))
      - Number(query.artifactRefs.some(ref => ref.id === left.id && ref.version === left.version)));
  const omitted = Math.max(0, issueIds.length - 32) + Math.max(0, material.links.topicIds.length - 32) + Math.max(0, artifactRefs.length - 32);
  const context = material.context.length <= 2048 && omitted === 0 ? material.context : canonicalJson({ role: "bounded_feedback_material",
    fullMetadataRef: metadataRef, originalContext: material.context.length <= 2048 ? material.context : null,
    originalMaterialId: material.id, originalContextChars: material.context.length, omittedLinkReferences: omitted,
    sourceRefsMayRequireReadMaterial: true, linkSelection: "requested_issue_and_artifacts_first" });

  return { ...material, context, recordRefs, links: { issueIds: issueIds.slice(0, 32), topicIds: material.links.topicIds.slice(0, 32),
    artifactRefs: artifactRefs.slice(0, 32) } };
}

/** Statistics and programmatic projections stay full. Only model-facing material is selected/paged.
 * Every omitted or deferred source has an exact immutable text read, with explicit original coordinates.
 */
export function selectContentFeedbackMaterial(input: {
  readonly batches: readonly ContentMaterialBatch[]; readonly scope: string; readonly issueId?: string;
  readonly artifactRefs?: readonly ContentArtifactRef[]; readonly maximumChars?: number; readonly maximumRecords?: number;
  readonly secrets?: readonly string[];
}): FeedbackMaterialTransport {
  const maximumChars = input.maximumChars ?? 20000, maximumRecords = input.maximumRecords ?? 16;
  if (!Number.isSafeInteger(maximumChars) || maximumChars < 2048 || maximumChars > 48000
    || !Number.isSafeInteger(maximumRecords) || maximumRecords < 2 || maximumRecords > 48) throw new RangeError("content_feedback_transport_budget");

  const archive = new Map<string, ContentEvidenceRecord>(), allMaterials = new Map<string, ContentMaterial>();
  const sourceHashes = new Map<string, string>(), aliases = new Map<string, string>();
  const originals = new Map<string, ContentSourceTextView["original"]>();

  function addRecord(record: ContentEvidenceRecord): string {
    const view = projectContentSourceText(record, input.secrets), projected = view.record;
    const prior = archive.get(projected.ref), priorAlias = aliases.get(record.ref);
    if (prior && canonicalJson(prior) !== canonicalJson(projected) || priorAlias !== undefined && priorAlias !== projected.ref) {
      throw new Error("content_feedback_material_conflict");
    }

    archive.set(projected.ref, Object.freeze({ ...projected }));
    aliases.set(record.ref, projected.ref);
    aliases.set(projected.ref, projected.ref);

    if (view.changed) originals.set(projected.ref, view.original);

    return projected.ref;
  }

  for (const batch of input.batches) {
    for (const record of batch.records) addRecord(record);
  }

  for (const batch of input.batches) {
    for (const material of batch.materials) {
      const recordRefs = material.recordRefs.map(ref => aliases.get(ref) ?? ref);
      const contextRef = `content-feedback-context:${contentHashOf([material.id, material.context])}`;
      const safeContext = projectContentSourceText({ ref: contextRef, runId: contextRef, sequence: 0,
        scope: input.scope, origin: "execution_result", text: material.context }, input.secrets).record.text;
      const source = recordRefs.length === 1 ? archive.get(recordRefs[0]!) : undefined;
      const original = source === undefined ? undefined : originals.get(source.ref);
      const projected: ContentMaterial = { ...material, recordRefs,
        context: source !== undefined && original !== undefined
          ? contentSourceViewContext({ record: source, original, changed: true }, safeContext) : safeContext };
      const prior = allMaterials.get(material.id);
      if (prior && canonicalJson(prior) !== canonicalJson(projected)) throw new Error("content_feedback_material_conflict");

      allMaterials.set(material.id, projected);
    }
  }

  const artifacts = input.artifactRefs ?? [];

  for (const material of allMaterials.values()) {
    const text = canonicalJson(material), ref = `content-feedback-metadata:${contentHashOf(text)}`;
    addRecord({ ref, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text });
    if (!aliases.has(material.id)) addRecord({ ref: material.id, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text });
  }

  const ordered = [...allMaterials.values()].reverse().sort((left, right) =>
    Number(matches(right, input.issueId, artifacts)) - Number(matches(left, input.issueId, artifacts)));
  const selectedRecords = new Map<string, ContentEvidenceRecord>(), selectedMaterials: ContentMaterial[] = [], deferred = new Set<string>();
  const shown = new Set<string>();

  for (const material of ordered) {
    if (input.issueId !== undefined || artifacts.length > 0) {
      if (!matches(material, input.issueId, artifacts)) continue;
    }

    const metadataText = canonicalJson(material), metadataIdentity = `content-feedback-metadata:${contentHashOf(metadataText)}`;
    const metadataRef = addRecord({ ref: metadataIdentity, runId: metadataIdentity, sequence: 0,
      scope: input.scope, origin: "execution_result", text: metadataText });
    const newRecords = new Map<string, ContentEvidenceRecord>();
    const refs: string[] = [];

    for (const ref of material.recordRefs) {
      const record = archive.get(ref);
      if (!record) continue;

      if (record.text.length <= 8000) {
        refs.push(ref);
        if (!selectedRecords.has(ref)) newRecords.set(ref, record);
        continue;
      }

      deferred.add(ref);
      const compact = contentFeedbackHeadMaterial(record);
      if (compact !== undefined) {
        const headRef = compact.record.ref;
        refs.push(headRef);
        addRecord(compact.record);
        if (!selectedRecords.has(headRef)) newRecords.set(headRef, compact.record);
        continue;
      }

      const text = canonicalJson({ role: "exact_feedback_source_available_by_readMaterial", originalRef: ref,
        originalRunId: record.runId, originalSequence: record.sequence, totalChars: record.text.length,
        read: { ref, start: 0, maximumChars: 8192 }, interpretation: "source_is_deferred_not_absent_no_report_or_gain_inferred" });
      const summaryRef = `content-feedback-deferred:${contentHashOf(text)}`;

      refs.push(summaryRef);

      if (!selectedRecords.has(summaryRef)) newRecords.set(summaryRef, { ref: summaryRef, runId: summaryRef, sequence: 0,
        scope: input.scope, origin: "execution_result", text });
    }

    if (refs.length === 0) continue;

    const bounded = boundedMaterial(material, refs, metadataRef, { artifactRefs: artifacts,
      ...(input.issueId === undefined ? {} : { issueId: input.issueId }) });
    const candidate = { records: [...selectedRecords.values(), ...newRecords.values()], materials: [...selectedMaterials, bounded], requirements: [], answers: [] };

    // Keep one final source/material slot and room for explicit coverage, rather than failing a normal long task.
    if (candidate.records.length >= maximumRecords || candidate.materials.length >= maximumRecords
      || canonicalJson(candidate).length > maximumChars - 1500) continue;

    newRecords.forEach((record, ref) => selectedRecords.set(ref, record));
    selectedMaterials.push(bounded);
    shown.add(material.id);
  }

  const omitted = ordered.filter(material => !shown.has(material.id));
  const coverage: FeedbackMaterialCoverage = { available: ordered.length, shown: shown.size, omitted: omitted.length,
    availableRefs: ordered.map(row => row.id), shownRefs: [...shown], omittedRefs: omitted.map(row => row.id), deferredRecordRefs: [...deferred] };

  if (ordered.length > 0) {
    const text = canonicalJson({ role: "feedback_material_transport_coverage", available: coverage.available, shown: coverage.shown,
      omitted: coverage.omitted, deferred: deferred.size, firstOmittedRefs: coverage.omittedRefs.slice(0, 2),
      referenceListing: { start: 0, maximum: 16, total: ordered.length, method: "listMaterials" },
      statement: "Only model material is selected. Full source population, feedback history and statistical estimates are unchanged. Omitted sources are available through listMaterials/readMaterial." });
    const ref = `content-feedback-coverage:${contentHashOf(text)}`;

    selectedRecords.set(ref, { ref, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text });
    selectedMaterials.push({ id: ref, kind: "feedback", subsystem: ordered[0]!.subsystem,
      context: "Explicit material selection and exact retrieval coverage; omitted is not absent.", recordRefs: [ref], requirementIds: [], answerIds: [],
      links: { issueIds: input.issueId === undefined ? [] : [input.issueId], topicIds: [], artifactRefs: artifacts.slice(0, 32) } });
  }

  const batch = mergeContentBatches([{ records: [...selectedRecords.values()], materials: selectedMaterials, requirements: [], answers: [] }]);
  if (!batch.ok || canonicalJson(batch.value).length > maximumChars) throw new Error("content_feedback_transport_invalid");

  return { batch: batch.value, coverage,

    readMaterial(ref, start = 0, maximum = 8192) {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32768) {
        return { ok: false, reason: "content_feedback_page_invalid" };
      }

      const record = archive.get(aliases.get(ref) ?? ref);
      if (!record) return { ok: false, reason: "content_feedback_material_missing" };

      if (start > record.text.length || start > 0 && lowSurrogate(record.text.charCodeAt(start)) && highSurrogate(record.text.charCodeAt(start - 1))) {
        return { ok: false, reason: "content_feedback_page_invalid" };
      }

      let end = Math.min(record.text.length, start + maximum);
      if (end < record.text.length && lowSurrogate(record.text.charCodeAt(end)) && highSurrogate(record.text.charCodeAt(end - 1))) end -= 1;

      if (end === start && start < record.text.length) return { ok: false, reason: "content_feedback_page_invalid" };

      const sourceHash = sourceHashes.get(ref) ?? contentHashOf(record.text);
      sourceHashes.set(ref, sourceHash);
      const originalSource = originals.get(record.ref);

      return { ok: true, originalRef: record.ref, start, totalChars: record.text.length, text: record.text.slice(start, end),
        end, origin: record.origin, originalScope: record.scope, sourceHash,
        nextStart: end < record.text.length ? end : null, originalCoordinate: { runId: record.runId, sequence: record.sequence },
        ...(originalSource === undefined ? {} : { originalSource }) };
    },

    listMaterials(start = 0, maximum = 16) {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64) throw new RangeError("content_feedback_page_invalid");
      const end = Math.min(ordered.length, start + maximum);
      return { available: ordered.length, nextStart: end < ordered.length ? end : null, materials: structuredClone(ordered.slice(start, end)) };
    } };
}

const lowSurrogate = (point: number): boolean => point >= 0xdc00 && point <= 0xdfff;
const highSurrogate = (point: number): boolean => point >= 0xd800 && point <= 0xdbff;
