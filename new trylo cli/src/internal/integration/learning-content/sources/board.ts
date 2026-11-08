import type { BoardState } from "../../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentMaterialBatch, ContentMaterialSource, ContentRetrievalQuery } from "../../../learning/central/content/material-contract.js";
import { mergeContentBatches } from "../../../learning/central/content/material.js";
import { isContentRetrievalQuery } from "../../../learning/central/content/material-parse.js";
import { readContentRecords } from "../records.js";
import { createBoardContentSource } from "../source.js";
import { contentRecallMaterialBatch } from "./content-recall.js";
import { boardArtifactMaterialBatch, contentSubsystem, mapBoardContentArtifacts } from "./artifact.js";
import { rankContentRecall } from "./board-recall.js";
import { readBoardContentMaterial, type ContentMaterialPage } from "./artifact-read.js";
import { contentTaskReferenceMaterialJson, projectContentRecallCatalog } from "./board-catalog.js";
import { readIssueSessionSourceCatalog, sessionIssueSourceCatalogMaterial, sessionSourceAddressCatalogForIssue } from "./session-issue-address.js";
import { canReadNativeAsset, canReadNativeContentRecord, explicitNativeMethodMaterials, nativeMethodKnowledgeCandidates,
  readNativeKnowledgeMaterial } from "./native-knowledge.js";
import type { BoardTaskReferenceInput, BoardTaskReferenceRead, ContentRecallCandidate, ContentTaskReferenceCoverage } from "./board-contract.js";
import { nativeCentralAdvisoryCandidates, type TaskCentralAdvisory } from "./native-central-advisory.js";
import { pageContentMaterial } from "./artifact-read.js";

export type * from "./board-contract.js";

type Candidate = { readonly description: ContentRecallCandidate; readonly batch: () => ContentMaterialBatch; readonly advisory?: TaskCentralAdvisory };

const empty = (): ContentMaterialBatch => ({ records: [], requirements: [], answers: [], materials: [] });

export interface AutomaticBoardContentSource extends ContentMaterialSource {
  readonly readTaskReferences: (signal: AbortSignal) => Promise<BoardTaskReferenceRead>;
  readonly readMaterial: (ref: string, signal: AbortSignal, start?: number, maximumChars?: number) => Promise<ContentMaterialPage>;
}

/** One immutable Board read shared by task references and learning preparation. This owns no persistence or loop. */
export function createAutomaticBoardContentSource(input: BoardTaskReferenceInput): AutomaticBoardContentSource {
  let snapshot: Promise<BoardState | undefined> | undefined;
  let recalled: Promise<BoardTaskReferenceRead> | undefined;
  const load = async (): Promise<BoardState | undefined> => {
    if (snapshot === undefined) snapshot = input.board.load().then(result => result.ok ? result.state : undefined);
    return snapshot;
  };

  async function read(signal: AbortSignal, query?: ContentRetrievalQuery): Promise<BoardTaskReferenceRead> {
    if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

    if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

    if (query !== undefined && !isContentRetrievalQuery(query)) return { ok: false, reason: "content_material_invalid" };

    if (query !== undefined && query.scope !== input.scope) return { ok: false, reason: "content_material_scope" };

    let board;

    try { board = await load(); }
    catch { return { ok: false, reason: "content_material_unavailable" }; }

    if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

    if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

    if (board === undefined || query !== undefined && query.boardSequence < board.sequence) return { ok: false, reason: "content_material_unavailable" };

    try {
      if (recalled === undefined) recalled = prepareReferences(board, input, signal, source);

      const prepared = await recalled;

      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (!prepared.ok || query === undefined) return prepared;

      const explicit = await explicitBoardMaterials(board, input, query, signal);
      if (!explicit.ok) return explicit;

      const merged = mergeContentBatches([prepared.value.batch, explicit.value]);
      if (!merged.ok) return merged;

      const materialJson = contentTaskReferenceMaterialJson(merged.value, prepared.value.coverage, input.taskPurpose);

      return { ok: true, value: { ...prepared.value, batch: merged.value, materialJson } };
    }
    catch { return { ok: false, reason: signal.aborted ? "content_material_cancelled" : "content_material_invalid" }; }
  }

  const source: AutomaticBoardContentSource = {
    readTaskReferences: signal => read(signal),

    async readMaterial(ref: string, signal: AbortSignal, start?: number, maximumChars?: number): Promise<ContentMaterialPage> {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      let board;

      try { board = await load(); }
      catch { return { ok: false, reason: "content_material_unavailable" }; }

      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (board === undefined) return { ok: false, reason: "content_material_unavailable" };

      try {
        const visible = nativeVisibleBoard(board, input);
        const advisories = await nativeCentralAdvisoryCandidates(visible, { scope: input.scope, enabled: input.enabled,
          ...(input.advisoryAccess === undefined ? {} : { access: input.advisoryAccess }) }, signal);
        const advisory = advisories.find(row => row.advisory.ref === ref || row.advisory.version === ref)?.advisory;
        if (advisory !== undefined) return pageContentMaterial({ ref: advisory.version, requestedRef: ref,
          text: advisory.text, originalScope: input.scope, sourceRefs: [advisory.ref, advisory.version, advisory.purposeHeadRef, ...advisory.sourceRefs],
          admissibility: "source_record", origin: "model_proposal", coordinate: { runId: advisory.version, sequence: 0 } }, start ?? 0, maximumChars ?? 4096);

        return readIssueSessionSourceCatalog(visible, input.scope, ref, start, maximumChars)
          ?? readNativeKnowledgeMaterial(visible, input.scope, ref, start, maximumChars)
          ?? readBoardContentMaterial(visible, input.scope, ref, start, maximumChars);
      }
      catch { return { ok: false, reason: "content_material_invalid" }; }
    },

    async retrieve(query, signal) {
      const result = await read(signal, query);
      return result.ok ? { ok: true, value: result.value.batch } : { ok: false,
        reason: result.reason === "content_material_cancelled" ? "content_material_cancelled"
          : result.reason === "content_material_scope" ? "content_material_scope"
          : result.reason === "content_material_capacity" ? "content_material_capacity"
          : result.reason === "content_material_invalid" ? "content_material_invalid" : "content_material_unavailable" };
    },
  };

  return source;
}

async function prepareReferences(board: BoardState, input: BoardTaskReferenceInput, signal: AbortSignal,
  source: ContentMaterialSource): Promise<BoardTaskReferenceRead> {
  const maximumCandidates = input.maximumCandidates ?? 24, maximumSelected = input.maximumSelected ?? 4, maximumChars = input.maximumChars ?? 24000;
  if (![maximumCandidates, maximumSelected, maximumChars].every(Number.isSafeInteger)
    || maximumCandidates < 1 || maximumCandidates > 64 || maximumSelected < 1 || maximumSelected > 16 || maximumChars < 1 || maximumChars > 60000) {
    return { ok: false, reason: "content_material_invalid" };
  }

  const visible = nativeVisibleBoard(board, input);
  const central = await nativeCentralAdvisoryCandidates(visible, { scope: input.scope, enabled: input.enabled,
    ...(input.advisoryAccess === undefined ? {} : { access: input.advisoryAccess }) }, signal);
  const candidates: readonly Candidate[] = [...boardCandidates(visible, input.scope), ...central.map(row => ({
    description: row.description, batch: empty, advisory: row.advisory }))];
  const ranked = rankContentRecall(candidates.map(row => row.description), input.taskPurpose);
  const considered = ranked.slice(0, maximumCandidates);
  const advisoryCatalog = central.filter(row => considered.some(candidate => candidate.id === row.description.id)).map(row => row.advisory);
  const ids = input.recall === undefined ? considered.slice(0, maximumSelected).map(row => row.id)
    : await input.recall.recall({ scope: input.scope, taskPurpose: input.taskPurpose, candidates: considered,
      omittedCandidates: candidates.length - considered.length, maximumSelected }, signal);

  if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

  if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

  if (!Array.isArray(ids) || ids.length > maximumSelected || new Set(ids).size !== ids.length || ids.some(id => !considered.some(row => row.id === id))) {
    return { ok: false, reason: "content_material_invalid" };
  }

  const mappings = mapBoardContentArtifacts(visible, input.scope);
  const batches = [empty()], selected: string[] = [], advisories: TaskCentralAdvisory[] = [];

  for (const id of ids) {
    const candidate = candidates.find(row => row.description.id === id)!;
    const batch = candidate.batch(), trial = mergeContentBatches([...batches, batch]);
    // Whole source products are admitted; the catalog below exposes any candidate omitted for capacity.
    const nextAdvisories = [...advisories, ...(candidate.advisory === undefined ? [] : [candidate.advisory])];
    if (trial.ok && canonicalJson(trial.value).length + (nextAdvisories.length === 0 ? 0 : canonicalJson(nextAdvisories).length) <= maximumChars) {
      batches.push(batch);
      selected.push(id);
      if (candidate.advisory !== undefined) advisories.push(candidate.advisory);
    }
  }

  const coverage: ContentTaskReferenceCoverage = { scope: input.scope, boardSequence: board.sequence, availableCandidates: candidates.length,
    consideredCandidates: considered.length, selectedCandidates: selected, omittedCandidates: candidates.length - selected.length,
    selection: input.recall === undefined ? "lexical_then_scope_recency" : "semantic_recall", relevanceIsNotIdentityOrAdequacy: true, candidates: considered };
  const combined = mergeContentBatches([...batches, coverageBatch(input, coverage)]);
  if (!combined.ok) return combined;

  const materialJson = contentTaskReferenceMaterialJson(combined.value, coverage, input.taskPurpose);
  if (materialJson.length > maximumChars + 16000) return { ok: false, reason: "content_material_capacity" };

  return { ok: true, value: { batch: combined.value, source, mappings, coverage, materialJson,
    ...(advisories.length === 0 ? {} : { advisories }),
    ...(advisoryCatalog.length === 0 ? {} : { advisoryCatalog }) } };
}

async function explicitBoardMaterials(board: BoardState, input: BoardTaskReferenceInput, query: ContentRetrievalQuery, signal: AbortSignal) {
  const visible = nativeVisibleBoard(board, input), scope = input.scope;
  const content = await createBoardContentSource(visible.rewardV2Facts ?? [], scope, visible.sequence,
    () => true, contentRecallMaterialBatch).retrieve(query, signal);
  if (!content.ok) return content;

  const assets = mapBoardContentArtifacts(visible, scope).filter(mapping => !mapping.contentFactIds.includes(mapping.ref)
    && (query.artifactRefs.some(ref => ref.id === mapping.ref && ref.version === mapping.version)
      || mapping.issueIds.some(id => query.issueIds.includes(id)) || mapping.sourceRefs.some(ref => query.sourceRefs.includes(ref))));
  const catalogs = (visible.learningIssues ?? []).filter(issue => issue.scope === scope
    && query.sourceRefs.includes(sessionSourceAddressCatalogForIssue(issue, visible).ref));

  return mergeContentBatches([content.value, ...assets.map(mapping => boardArtifactMaterialBatch(visible, scope, mapping)),
    ...catalogs.map(issue => sessionIssueSourceCatalogMaterial(issue, visible)), explicitNativeMethodMaterials(visible, scope, query)]);
}

/** Filter the original owner view once so catalog, exact recall, mappings and read fallback share the same boundary. */
function nativeVisibleBoard(board: BoardState, input: BoardTaskReferenceInput): BoardState {
  const records = readContentRecords(board.rewardV2Facts ?? [], input.scope, board.sequence);
  const deniedFacts = new Set(records.filter(record => !canReadNativeContentRecord(board, input.scope, record, input.nativeAccess)).map(record => record.factId));
  return { ...board, assets: board.assets.filter(asset => canReadNativeAsset(board, input.scope, asset.versionId, input.nativeAccess)),
    rewardV2Facts: (board.rewardV2Facts ?? []).filter(fact => !deniedFacts.has(fact.id)) };
}

function boardCandidates(board: BoardState, scope: string): readonly Candidate[] {
  const records = readContentRecords(board.rewardV2Facts ?? [], scope, board.sequence), mappings = mapBoardContentArtifacts(board, scope);
  const candidates: Candidate[] = records.map(record => {
    const text = [record.packet.requirements.map(row => row.requirement).join("\n"), ...record.output.applied.knowledge.map(row => row.statement),
      ...record.output.applied.applications.map(row => row.result), ...record.output.applied.preparations.map(row => row.description),
      record.output.review.recommendation.reason].join("\n");
    return { description: { id: record.factId, kind: "public_content", subsystem: contentSubsystem(record.packet.domain), sequence: record.sequence,
      active: false, description: text.slice(0, 2000), descriptionOmittedChars: Math.max(0, text.length - 2000), sourceRefs: [record.factId] },
      batch: () => contentRecallMaterialBatch(record, scope) };
  });

  candidates.push(...nativeMethodKnowledgeCandidates(board, scope));

  for (const mapping of mappings.filter(row => !row.contentFactIds.includes(row.ref))) {
    const asset = board.assets.find(row => row.versionId === mapping.ref)!;
    if (board.tombstones.some(row => row.entityType === "asset" && row.entityId === asset.versionId && row.boardSequence <= board.sequence)) continue;

    const text = canonicalJson(asset.content), activations = board.activations.filter(row => row.versionId === asset.versionId);
    if (!activations.some(row => row.pointer === "active" && !row.breaker?.open)) continue;

    candidates.push({ description: { id: `asset:${asset.versionId}`, kind: "asset", subsystem: mapping.subsystem,
      sequence: Math.max(0, ...activations.map(row => row.boardSequence)), active: activations.some(row => row.pointer === "active" && !row.breaker?.open),
      description: text.slice(0, 2000), descriptionOmittedChars: Math.max(0, text.length - 2000), sourceRefs: [asset.versionId] },
      batch: () => boardArtifactMaterialBatch(board, scope, mapping) });
  }

  return candidates;
}

function coverageBatch(input: BoardTaskReferenceInput, coverage: ContentTaskReferenceCoverage): ContentMaterialBatch {
  const text = canonicalJson({ role: "host_retrieval_projection_not_task_result_or_learning_gain", ...projectContentRecallCatalog(coverage, input.taskPurpose) });
  const ref = `content-recall:${contentHashOf(text)}`;
  return { records: [{ ref, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text }], requirements: [], answers: [],
    materials: [{ id: ref, kind: "context", subsystem: contentSubsystem(input.domain),
      context: "Bounded purpose-based recall; candidates can be relevant without being the same question or an adequate answer.",
      recordRefs: [ref], requirementIds: [], answerIds: [], links: { issueIds: [], topicIds: [], artifactRefs: [] } }] };
}
