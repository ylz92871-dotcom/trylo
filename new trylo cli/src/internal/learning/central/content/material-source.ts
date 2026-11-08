import type { ContentArtifactRef, ContentMaterialBatch, ContentMaterialResult, ContentMaterialSource,
  ContentPacket, ContentPacketInput, ContentRetrievalQuery } from "./material-contract.js";
import { buildContentPacket, contentRequestedRefs, expandContentSourceAliases, mergeContentBatches } from "./material.js";
import { isContentBatch, isContentPacketInput, isContentRetrievalQuery, isContentSourceResult } from "./material-parse.js";
import { sequence, text } from "../../../validation/json-shape.js";

/** Read exactly related source material. No similarity-based merging or global novelty claim. */
export function createSnapshotContentSource(snapshot: ContentMaterialBatch & { readonly scope: string; readonly boardSequence: number }): ContentMaterialSource {
  const valid = isContentBatch(snapshot) && text(snapshot.scope, 512) && sequence(snapshot.boardSequence)
    && snapshot.records.every(record => record.scope === snapshot.scope);
  const saved = valid ? structuredClone(snapshot) : undefined;

  return Object.freeze({
    async retrieve(query: ContentRetrievalQuery, signal: AbortSignal): Promise<ContentMaterialResult<ContentMaterialBatch>> {
      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (saved === undefined || !isContentRetrievalQuery(query)) return { ok: false, reason: "content_material_invalid" };

      if (query.scope !== saved.scope) return { ok: false, reason: "content_material_scope" };

      // The snapshot's known-at prefix cannot be laundered into an earlier model input.
      if (saved.boardSequence > query.boardSequence) return { ok: false, reason: "content_material_unavailable" };

      const selected = selectRelatedContent(saved, query);

      return mergeContentBatches([selected]);
    },
  });
}

/** Caller supplies collection-gated source adapters; this one-shot function never owns a runtime loop. */
export async function retrieveContentPacket(input: ContentPacketInput, source: ContentMaterialSource,
  signal: AbortSignal, maximumChars?: number): Promise<ContentMaterialResult<ContentPacket>> {
  if (!isContentPacketInput(input)) return { ok: false, reason: "content_material_invalid" };

  if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

  const links = input.materials.map(item => item.links);
  const query: ContentRetrievalQuery = { scope: input.scope, domain: input.domain, boardSequence: input.boardSequence,
    issueIds: [...new Set([...(input.focus === undefined ? [] : [input.focus.issueId]), ...links.flatMap(item => item.issueIds)])],
    topicIds: [...new Set(links.flatMap(item => item.topicIds))],
    artifactRefs: distinctArtifacts([...input.answers.flatMap(item => item.artifactRefs), ...links.flatMap(item => item.artifactRefs)]),
    sourceRefs: contentRequestedRefs(input) };
  let result: unknown;

  try { result = await source.retrieve(query, signal); }
  catch { return { ok: false, reason: signal.aborted ? "content_material_cancelled" : "content_material_unavailable" }; }

  if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

  if (!isContentSourceResult(result)) return { ok: false, reason: "content_material_invalid" };

  if (!result.ok) return result;

  const batch = mergeContentBatches([input, result.value]);

  return batch.ok ? buildContentPacket({ ...input, ...batch.value, requestedRefs: query.sourceRefs }, maximumChars) : batch;
}

/**
 * Select from an already validated archive before applying packet capacity limits.
 * The caller validates the query and runs mergeContentBatches on the selected result.
 */
export function selectRelatedContent(snapshot: ContentMaterialBatch, query: ContentRetrievalQuery): ContentMaterialBatch {
  const requested = new Set(expandContentSourceAliases(query.sourceRefs, snapshot.aliases));
  const materials = snapshot.materials.filter(item => item.recordRefs.some(ref => requested.has(ref))
    || item.links.issueIds.some(id => query.issueIds.includes(id)) || item.links.topicIds.some(id => query.topicIds.includes(id))
    || item.links.artifactRefs.some(ref => hasArtifact(query.artifactRefs, ref)));
  const requirementIds = new Set(materials.flatMap(item => item.requirementIds));
  const answerIds = new Set(materials.flatMap(item => item.answerIds));
  const requirements = snapshot.requirements.filter(item => requirementIds.has(item.id) || item.sourceRefs.some(ref => requested.has(ref)));
  const answers = snapshot.answers.filter(item => answerIds.has(item.answerId) || item.supportRefs.some(ref => requested.has(ref))
    || item.artifactRefs.some(ref => hasArtifact(query.artifactRefs, ref)));
  const references = [...query.sourceRefs, ...materials.flatMap(item => item.recordRefs),
    ...requirements.flatMap(item => item.sourceRefs), ...answers.flatMap(item => item.supportRefs)];
  const recordRefs = new Set(expandContentSourceAliases(references, snapshot.aliases)), selectedRefs = new Set(references);
  const aliases = snapshot.aliases?.filter(alias => selectedRefs.has(alias.ref)) ?? [];

  return { materials, requirements, answers, records: snapshot.records.filter(record => recordRefs.has(record.ref)),
    ...(aliases.length === 0 ? {} : { aliases }) };
}

function hasArtifact(refs: readonly ContentArtifactRef[], expected: ContentArtifactRef): boolean {
  return refs.some(ref => ref.id === expected.id && ref.version === expected.version);
}

function distinctArtifacts(refs: readonly ContentArtifactRef[]): readonly ContentArtifactRef[] {
  return refs.filter((ref, index) => !hasArtifact(refs.slice(0, index), ref));
}
