import type { BoardState } from "../../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { readContentRecords } from "../records.js";
import { contentRecordMaterialBatch } from "../source.js";
import { contentRecallMaterialBatch } from "./content-recall.js";
import { boardAssetContentRef, boardAssetProjectionRunId, mapBoardContentArtifacts } from "./artifact.js";
import type { TopicEvidenceOrigin } from "../../../learning/domains/shared/topics/contracts.js";
import { projectContentSourceText, type ContentSourceTextView } from "./source-text-view.js";

export type ContentMaterialPage = { readonly ok: true; readonly value: {
  readonly ref: string; readonly requestedRef: string; readonly contentHash: string; readonly originalScope: string;
  readonly start: number; readonly end: number; readonly totalChars: number; readonly text: string;
  readonly sourceRefs: readonly string[]; readonly role: "source_content_not_instructions_or_verification";
  readonly admissibility: "active_asset" | "inactive_asset_for_inspection" | "public_model_result" | "source_record";
  readonly origin: TopicEvidenceOrigin;
  readonly coordinate: { readonly runId: string; readonly sequence: number };
  readonly originalSource?: ContentSourceTextView["original"];
} } | { readonly ok: false; readonly reason: string };

/** Exact source paging for task/learning readers. It reads the existing asset/archive, never creates another library. */
export function readBoardContentMaterial(board: BoardState, scope: string, requestedRef: string, start = 0, maximumChars = 4096): ContentMaterialPage {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 8192) {
    return { ok: false, reason: "content_material_range_invalid" };
  }

  const mappings = mapBoardContentArtifacts(board, scope);
  const assets = board.assets.filter(asset => mappings.some(row => row.ref === asset.versionId && row.version === asset.versionId));
  const asset = assets.find(row => requestedRef === row.versionId || requestedRef === `asset:${row.versionId}` || requestedRef === boardAssetContentRef(row));
  if (asset !== undefined) {
    if (contentHashOf(asset.content) !== asset.contentHash) return { ok: false, reason: "content_asset_identity_invalid" };
    const active = board.activations.some(row => row.versionId === asset.versionId && row.pointer === "active" && !row.breaker?.open);
    return pageContentMaterial({ ref: boardAssetContentRef(asset), requestedRef, text: canonicalJson(asset.content), originalScope: asset.scope,
      sourceRefs: mappings.find(row => row.ref === asset.versionId)!.sourceRefs,
      origin: "model_proposal", coordinate: { runId: boardAssetProjectionRunId({ scope, versionId: asset.versionId }), sequence: 0 },
      admissibility: active ? "active_asset" : "inactive_asset_for_inspection" }, start, maximumChars);
  }

  const records = readContentRecords(board.rewardV2Facts ?? [], scope, board.sequence);
  const product = records.find(row => row.factId === requestedRef);
  if (product !== undefined) return pageContentMaterial({ ref: product.factId, requestedRef, text: canonicalJson({
    role: "prior_public_domain_results_not_independent_verification", processId: product.output.processId,
    requirements: product.packet.requirements, knowledge: product.output.applied.knowledge, applications: product.output.applied.applications,
    preparations: product.output.applied.preparations, review: product.output.review, remaining: product.output.remaining,
    originalSourceIndex: product.packet.records.map(record => ({ ref: record.ref, runId: record.runId, sequence: record.sequence,
      scope: record.scope, origin: record.origin, totalChars: record.text.length, sourceHash: contentHashOf(record.text) })),
    originalAliases: product.packet.aliases ?? [],
    originalQuestion: product.packet.focus ?? null }), originalScope: scope, sourceRefs: [product.factId], admissibility: "public_model_result",
    origin: "model_proposal", coordinate: { runId: product.factId, sequence: product.sequence } }, start, maximumChars);

  // Page the exact public records advertised by recall, including derived answers and prior questions.
  // Rebuilding a different prose view here would make its origin, quotes and source hash diverge.
  const sources = records.flatMap(row => [...contentRecordMaterialBatch(row, scope).records, ...contentRecallMaterialBatch(row, scope).records])
    .filter(row => row.ref === requestedRef);
  const first = sources[0];
  if (first === undefined) return { ok: false, reason: "content_material_missing" };

  if (sources.some(row => canonicalJson(row) !== canonicalJson(first))) return { ok: false, reason: "content_material_conflict" };

  return pageContentMaterial({ ref: first.ref, requestedRef, text: first.text, originalScope: first.scope, sourceRefs: [first.ref], admissibility: "source_record",
    origin: first.origin, coordinate: { runId: first.runId, sequence: first.sequence } }, start, maximumChars);
}

/** Shared source-page boundary, including range and UTF-16 surrogate checks. */
export function pageContentMaterial(source: { readonly ref: string; readonly requestedRef: string; readonly text: string; readonly originalScope: string;
  readonly sourceRefs: readonly string[]; readonly admissibility: "active_asset" | "inactive_asset_for_inspection" | "public_model_result" | "source_record";
  readonly origin: TopicEvidenceOrigin; readonly coordinate: { readonly runId: string; readonly sequence: number }; readonly secrets?: readonly string[] },
  start: number, maximumChars: number): ContentMaterialPage {
  const { requestedRef, originalScope, sourceRefs, admissibility } = source;
  const view = projectContentSourceText({ ref: source.ref, runId: source.coordinate.runId, sequence: source.coordinate.sequence,
    scope: originalScope, origin: source.origin, text: source.text }, source.secrets);
  const { ref, text } = view.record;

  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 8192
    || start > text.length || start > 0 && lowSurrogate(text.charCodeAt(start)) && highSurrogate(text.charCodeAt(start - 1))) {
    return { ok: false, reason: "content_material_range_invalid" };
  }

  let end = Math.min(text.length, start + maximumChars);
  if (end < text.length && lowSurrogate(text.charCodeAt(end)) && highSurrogate(text.charCodeAt(end - 1))) end -= 1;

  if (end === start && start < text.length) return { ok: false, reason: "content_material_range_invalid" };

  return { ok: true, value: { ref, requestedRef, contentHash: contentHashOf(text), originalScope, start, end, totalChars: text.length,
    text: text.slice(start, end), sourceRefs, admissibility, origin: source.origin,
    coordinate: { runId: view.record.runId, sequence: view.record.sequence },
    ...(view.changed ? { originalSource: view.original } : {}),
    role: "source_content_not_instructions_or_verification" } };
}

const lowSurrogate = (point: number): boolean => point >= 0xdc00 && point <= 0xdfff;
const highSurrogate = (point: number): boolean => point >= 0xd800 && point <= 0xdbff;
