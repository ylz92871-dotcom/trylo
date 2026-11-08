import type { ContentEvidenceRecord, ContentMaterial } from "../../learning/central/content/material-contract.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isRedactedTopicData } from "../learning-topics/confidentiality.js";
import { isContentValueCredentialSafe } from "./content-confidentiality-leaf.js";
import type { TrustedContentIdentity } from "./content-confidentiality.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { contentSourceTextViewRef, readContentSourceViewContext, readContentSourceViewMetadata } from "./sources/source-text-view.js";

/** This recognises host-generated metadata only. User/tool record.text never takes
 * this path, even if its JSON happens to contain the same source/scope keys. */
export function isContentSourceContextSafe(context: string, material: ContentMaterial, records: readonly ContentEvidenceRecord[],
  trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  const proseSafe = isRedactedTopicData(context, secrets);
  let raw: unknown;

  try { raw = JSON.parse(context); }
  catch { return proseSafe; }

  if (!isContentValueCredentialSafe(raw, secrets)) return false;

  if (proseSafe) return true;

  return sourceViewContext(context, raw, material, records, trusted, secrets)
    || journalContext(raw, material, records, trusted, secrets) || pageContext(raw, material, records, trusted, secrets)
    || chunkContext(raw, material, records, trusted, secrets);
}

function sourceViewContext(context: string, raw: unknown, material: ContentMaterial, records: readonly ContentEvidenceRecord[],
  trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  const record = records.find(row => row.ref === material.id && material.recordRefs.includes(row.ref));
  if (record === undefined) return false;

  const view = readContentSourceViewContext(context, record);
  if (view === undefined) return false;

  const restSafe = typeof raw === "object" && raw !== null
    && isRedactedTopicData({ ...raw, originalContext: "[checked_source_owner_context]" }, secrets);
  let inner: unknown;

  try { inner = JSON.parse(view.originalContext); }
  catch { return restSafe && isRedactedTopicData(view.originalContext, secrets); }

  if (!isContentValueCredentialSafe(inner, secrets)) return false;

  const original = { ...record, ref: view.originalRef, runId: view.originalRunId, sequence: view.originalSequence };

  return (isRedactedTopicData(view.originalContext, secrets)
      || journalContext(inner, { ...material, id: original.ref, recordRefs: [original.ref] }, [original], trusted, secrets))
    && restSafe;
}

function journalContext(raw: unknown, material: ContentMaterial, records: readonly ContentEvidenceRecord[],
  trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  const optional = ["toolCallId", "toolName", "reportedOutcome", "truncated", "callRef"];
  const present = typeof raw === "object" && raw !== null ? optional.filter(key => Object.hasOwn(raw, key)) : [];
  if (!fields(raw, ["source", "sessionId", "turnId", "workspaceId", "journalSequence", "sourceRecordType", "originalTranscriptSequence", "role", ...present])
    || raw.source !== "canonical_session_journal" || typeof raw.sessionId !== "string" || typeof raw.turnId !== "string"
    || !sequence(raw.journalSequence) || !["turn_input", "transcript_item", "terminal", "envelope"].includes(String(raw.sourceRecordType))
    || raw.originalTranscriptSequence !== null && !sequence(raw.originalTranscriptSequence)
    || !["original_user_requirement", "public_assistant_report_not_verification", "reported_tool_result_not_task_or_learning_gain",
      "turn_input", "transcript_item", "terminal", "envelope"].includes(String(raw.role))
    || raw.workspaceId !== trusted.scope && raw.workspaceId !== `workspace:${trusted.scope}`) return false;

  const record = records.find(row => row.ref === material.id && material.recordRefs.includes(row.ref));
  if (record === undefined || record.runId !== raw.sessionId || record.sequence !== raw.journalSequence || record.scope !== trusted.scope
    || raw.role === "original_user_requirement" && record.origin !== "user_statement"
    || raw.role === "public_assistant_report_not_verification" && record.origin !== "model_proposal") return false;

  // Recheck decoded strings too: escaped JSON spelling must not hide a known credential.
  return isRedactedTopicData({ ...raw, workspaceId: "[canonical_workspace]" }, secrets);
}

function pageContext(raw: unknown, material: ContentMaterial, records: readonly ContentEvidenceRecord[],
  trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  const changed = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "originalSource");
  if (!fields(raw, ["role", "parentRef", "requestedRef", "sourceHash", "originalScope", "originalCoordinate", "start", "end", "totalChars", "sourceOwner", ...(changed ? ["originalSource"] : [])])
    || raw.role !== "exact_source_page_not_complete_parent" || raw.originalScope !== trusted.scope
    || typeof raw.parentRef !== "string" || typeof raw.requestedRef !== "string" || typeof raw.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceHash)
    || !fields(raw.originalCoordinate, ["runId", "sequence"]) || typeof raw.originalCoordinate.runId !== "string" || !sequence(raw.originalCoordinate.sequence)
    || ![raw.start, raw.end, raw.totalChars].every(sequence) || !["session", "board", "feedback", "domain_feedback"].includes(String(raw.sourceOwner))) return false;

  const record = records.find(row => row.ref === material.id && material.recordRefs.includes(row.ref));
  if (record === undefined || record.runId !== record.ref || record.sequence !== 0 || typeof raw.start !== "number"
    || typeof raw.end !== "number" || typeof raw.totalChars !== "number" || raw.end !== raw.start + record.text.length || raw.end > raw.totalChars) return false;

  if (changed && (!fields(raw.originalSource, ["ref", "runId", "sequence", "sourceHash"]) || !identity(raw.originalSource.ref)
    || !identity(raw.originalSource.runId) || !sequence(raw.originalSource.sequence) || typeof raw.originalSource.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.originalSource.sourceHash)
    || raw.parentRef !== contentSourceTextViewRef(raw.originalSource.ref, raw.originalSource.sourceHash, raw.sourceHash)
    || raw.originalCoordinate.runId !== raw.parentRef || raw.originalCoordinate.sequence !== 0)) return false;

  const page = { ref: raw.requestedRef, originalRef: raw.parentRef, origin: record.origin, originalScope: raw.originalScope,
    start: raw.start, end: raw.end, totalChars: raw.totalChars, text: record.text, sourceHash: raw.sourceHash,
    coordinate: raw.originalCoordinate, owner: raw.sourceOwner, ...(changed ? { originalSource: raw.originalSource } : {}) };

  return record.ref === `content-source-page:${contentHashOf(page)}`
    && isRedactedTopicData({ ...raw, originalScope: "[canonical_scope]" }, secrets);
}

function chunkContext(raw: unknown, material: ContentMaterial, records: readonly ContentEvidenceRecord[],
  trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  if (!fields(raw, ["originalContext", "coordinateKind", "originalRef", "originalRunId", "originalSequence", "sourceHash", "start", "end", "totalChars", "transport", "pagingAvailable"])
    || raw.coordinateKind !== "exact_source_chunk_projection" || raw.transport !== "partial_source_chunk" || raw.pagingAvailable !== true
    || typeof raw.originalContext !== "string" || typeof raw.originalRef !== "string" || typeof raw.originalRunId !== "string"
    || !sequence(raw.originalSequence) || typeof raw.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceHash)
    || typeof raw.start !== "number" || typeof raw.end !== "number" || typeof raw.totalChars !== "number"
    || ![raw.start, raw.end, raw.totalChars].every(sequence)) return false;

  const record = records.find(row => row.ref === material.id && material.recordRefs.includes(row.ref));
  if (record === undefined || record.ref !== `${raw.originalRef}:chunk:${raw.start}`
    || record.runId !== `session-content-chunks:${contentHashOf([raw.originalRunId, raw.originalSequence])}`
    || raw.end !== raw.start + record.text.length || raw.end > raw.totalChars) return false;

  let inner: unknown;

  try { inner = JSON.parse(raw.originalContext); }
  catch { return false; }

  const original = { ...record, ref: raw.originalRef, runId: raw.originalRunId, sequence: raw.originalSequence };
  const originalMaterial = { ...material, id: original.ref, recordRefs: [original.ref] };

  return isContentValueCredentialSafe(inner, secrets)
    && (journalContext(inner, originalMaterial, [original], trusted, secrets)
      || chunkSourceViewContext(raw.originalContext, inner, original, originalMaterial, raw.sourceHash, trusted, secrets))
    && isRedactedTopicData({ ...raw, originalContext: "[checked_canonical_journal_context]" }, secrets);
}

function chunkSourceViewContext(context: string, raw: unknown, original: ContentEvidenceRecord, material: ContentMaterial,
  projectionHash: string, trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  const view = readContentSourceViewMetadata(context, { projectionRef: original.ref, projectionHash });
  if (view === undefined) return false;

  let inner: unknown;

  try { inner = JSON.parse(view.originalContext); }
  catch { return false; }

  const source = { ...original, ref: view.originalRef, runId: view.originalRunId, sequence: view.originalSequence };

  return isContentValueCredentialSafe(inner, secrets)
    && journalContext(inner, { ...material, id: source.ref, recordRefs: [source.ref] }, [source], trusted, secrets)
    && typeof raw === "object" && raw !== null
    && isRedactedTopicData({ ...raw, originalContext: "[checked_source_owner_context]" }, secrets);
}
