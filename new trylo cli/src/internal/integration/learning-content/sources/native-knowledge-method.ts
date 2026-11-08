import type { BoardState } from "../../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentMaterialBatch, ContentRetrievalQuery } from "../../../learning/central/content/material-contract.js";
import { mergeContentBatches } from "../../../learning/central/content/material.js";
import type { ContentRecallCandidate } from "./board-contract.js";
import { mapBoardContentArtifacts } from "./artifact.js";
import { pageContentMaterial, type ContentMaterialPage } from "./artifact-read.js";
import { projectContentSourceText, contentSourceViewContext } from "./source-text-view.js";

type MethodFact = NonNullable<BoardState["methodExperienceFacts"]>[number];

interface MethodSource {
  readonly id: string; readonly versionId: string; readonly facts: readonly MethodFact[];
  readonly issueIds: readonly string[];
  readonly text: string; readonly description: string; readonly sequence: number;
}

const empty = (): ContentMaterialBatch => ({ records: [], requirements: [], answers: [], materials: [] });

/** BoardState is the normalized owning boundary. Native method facts remain their
 * canonical type through that public contract; no private selection/qualification algorithm is copied. */
function methodSources(board: BoardState, scope: string): readonly MethodSource[] {
  const versions = new Set(mapBoardContentArtifacts(board, scope).filter(row => row.domain === "prompt").map(row => row.ref));

  for (const fielding of board.fieldings) if (fielding.scope === scope) versions.add(fielding.versionId);

  for (const issue of board.learningIssues ?? []) if (issue.scope === scope) {
    for (const report of issue.reports) if ("subsystem" in report.source && report.source.subsystem === "method") versions.add(report.source.versionId);
  }

  const result: MethodSource[] = [];

  for (const versionId of versions) {
    const facts = (board.methodExperienceFacts ?? []).filter(fact => fact.versionId === versionId && fact.sequence <= board.sequence);
    if (facts.length === 0) continue;

    const fieldings = board.fieldings.filter(row => row.versionId === versionId && row.scope === scope);
    const feedback = board.feedbacks.filter(row => row.versionId === versionId && fieldings.some(fielding => row.exposureId === undefined
      ? fielding.turnId === row.turnId : fielding.exposureId === row.exposureId));
    const latest = facts.filter((fact): fact is Extract<MethodFact, { kind: "review" }> => fact.kind === "review").at(-1);
    const issueIds = (board.learningIssues ?? []).filter(issue => issue.scope === scope && issue.reports.some(report =>
      "subsystem" in report.source && report.source.subsystem === "method" && report.source.versionId === versionId)).map(issue => issue.issueId);
    const source = { role: "native_method_source_not_active_rule_or_learning_gain", nativeVersionId: versionId,
      currentQueryScope: scope,
      originalAssetScopes: [...new Set(board.assets.filter(row => row.versionId === versionId).map(row => row.scope))],
      scopeAndRestrictions: facts.filter(fact => ["scope", "scope_retired", "restriction"].includes(fact.kind)),
      reviewProposals: facts.filter(fact => fact.kind === "review"),
      actualDecisionsAndExecution: facts.filter(fact => ["decision", "execution", "adoption_window_closed"].includes(fact.kind)),
      lifecycleAndExits: facts.filter(fact => fact.kind === "exit" || fact.kind === "compilation_exit"),
      actualFieldings: fieldings, feedbackClaimsAndCorrections: feedback,
      interpretation: "Review scores, promote decisions and procedure proposals do not activate anything. Fielding, actual execution, helpfulness claims and learning gain remain distinct." };

    result.push({ id: `native-method:${contentHashOf([scope, versionId])}`, versionId, facts, issueIds, text: canonicalJson(source),
      sequence: Math.max(...facts.map(fact => fact.sequence)), description: latest === undefined
        ? `Method source ${versionId}: original scope, restrictions, execution, feedback and exits.`
        : `Method source ${versionId}: ${canonicalJson(latest.review)}; original scope and actual feedback remain separate.` });
  }

  return result;
}

function batchOf(source: MethodSource, scope: string, extraAliases: readonly string[] = []): ContentMaterialBatch {
  const originalRunId = nativeMethodProjectionRunId(source, scope), view = nativeMethodSourceView(source, scope);
  const runId = view.changed ? view.record.runId : originalRunId, text = view.record.text;
  const records: ContentMaterialBatch["records"][number][] = [];
  const ranges: { readonly ref: string; readonly start: number; readonly end: number }[] = [];

  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 16000);
    const point = text.charCodeAt(end);
    if (end < text.length && point >= 0xdc00 && point <= 0xdfff) end -= 1;

    const sequence = records.length, ref = !view.changed ? `${runId}:${sequence}`
      : text.length <= 16000 ? view.record.ref : `${view.record.ref}:chunk:${start}`;

    records.push({ ref, runId, sequence, scope, origin: "execution_result", text: text.slice(start, end) });
    ranges.push({ ref, start, end });
    start = end;
  }

  const recordRefs = records.map(row => row.ref), review = source.facts.filter(fact => fact.kind === "review").at(-1);
  const latest = review?.kind === "review" ? projectContentSourceText({ ref: review.factId, runId: review.factId, sequence: review.sequence,
    scope, origin: "model_proposal", text: canonicalJson(review.review) }).record.text : undefined;
  const answerId = `${runId}:review`;
  const originalContext = canonicalJson({ source: "Board.methodExperienceFacts + scoped MethodFielding/MethodFeedback", nativeVersionId: source.versionId,
    originalFactRefs: source.facts.slice(0, 16).map(fact => fact.factId), originalFactCount: source.facts.length,
    omittedContextFactRefs: Math.max(0, source.facts.length - 16), fullSourceRef: source.id,
    recordProjection: originalRunId, interpretation: "source inspection only; no activation or effectiveness verdict" });
  const context = !view.changed ? originalContext : text.length <= 16000 ? contentSourceViewContext(view, originalContext)
    : canonicalJson({ source: "native_method_public_source_view_chunks", originalContext: contentSourceViewContext(view, originalContext),
      fullSourceRef: source.id, projectionRef: view.record.ref, sourceHash: contentHashOf(text), totalChars: text.length,
      ranges, transport: "source_view_chunks_not_independent_method_facts" });

  return { records, requirements: [], answers: latest === undefined ? [] : [{ answerId,
    question: `Original method review for ${source.versionId}; consult its original scope and answer requirements.`,
    requirement: "Inspect the original review, procedure, support and lifecycle; do not bypass normal method_context applicability/adoption.",
    answer: latest.length <= 8192 ? latest : `Original review is at ${review!.factId}; read it without treating this address as its answer.`,
    conditions: ["Source-owned model review, not a verified active rule. Original scope/restriction/exit and support facts remain in these records."],
    supportRefs: recordRefs, artifactRefs: [{ id: source.versionId, version: source.versionId }] }],
    materials: [{ id: view.changed ? view.record.ref : source.id, kind: latest === undefined ? "experience" : "known_answer", subsystem: "method",
      context,
      recordRefs, requirementIds: [], answerIds: latest === undefined ? [] : [answerId],
      links: { issueIds: source.issueIds, topicIds: [], artifactRefs: [{ id: source.versionId, version: source.versionId }] } }],
    aliases: [...new Set([source.id, source.versionId, ...(view.changed ? [view.record.ref] : []), ...extraAliases])]
      .filter(ref => !recordRefs.includes(ref)).map(ref => ({ ref, recordRefs })) };
}

const nativeMethodProjectionRunId = (source: MethodSource, scope: string): string =>
  `native-method-projection:${contentHashOf([scope, source.versionId, source.text])}`;

/** Commit the complete source view before chunking so all pages/slices share one parent hash. */
function nativeMethodSourceView(source: MethodSource, scope: string) {
  return projectContentSourceText({ ref: source.id, runId: nativeMethodProjectionRunId(source, scope), sequence: 0,
    scope, origin: "execution_result", text: source.text });
}

export function nativeMethodKnowledgeCandidates(board: BoardState, scope: string): readonly {
  readonly description: ContentRecallCandidate; readonly batch: () => ContentMaterialBatch;
}[] {
  return methodSources(board, scope).map(source => {
    const description = projectContentSourceText({ ref: `${source.id}:description`, runId: source.id,
      sequence: 0, scope, origin: "model_proposal", text: source.description }).record.text;
    return { description: { id: source.id, kind: "native_method", subsystem: "method", sequence: source.sequence, active: false,
      description: description.slice(0, 2000), descriptionOmittedChars: Math.max(0, description.length - 2000), sourceRefs: [source.id, source.versionId] },
    batch: () => batchOf(source, scope) };
  });
}

export function explicitNativeMethodMaterials(board: BoardState, scope: string, query: ContentRetrievalQuery): ContentMaterialBatch {
  const sources = methodSources(board, scope).filter(source => query.artifactRefs.some(ref => ref.id === source.versionId && ref.version === source.versionId)
    || source.issueIds.some(issueId => query.issueIds.includes(issueId))
    || query.sourceRefs.some(ref => ref === source.id || ref === source.versionId || source.facts.some(fact => fact.factId === ref)));
  const result = mergeContentBatches([empty(), ...sources.map(source => batchOf(source, scope,
    query.sourceRefs.filter(ref => source.facts.some(fact => fact.factId === ref))))]);
  if (!result.ok) throw new Error(result.reason);

  return result.value;
}

export function readNativeKnowledgeMaterial(board: BoardState, scope: string, ref: string,
  start = 0, maximumChars = 4096): ContentMaterialPage | undefined {
  for (const source of methodSources(board, scope)) {
    const view = nativeMethodSourceView(source, scope);
    const fact = source.facts.find(item => item.factId === ref);
    if (ref !== source.id && ref !== source.versionId && ref !== view.record.ref && !ref.startsWith(`${view.record.ref}:chunk:`) && fact === undefined) continue;
    return pageContentMaterial({ ref: fact?.factId ?? source.id, requestedRef: ref, text: fact === undefined ? source.text : canonicalJson(fact),
      originalScope: scope, sourceRefs: [source.id, source.versionId, ...(fact === undefined ? [] : [fact.factId])], admissibility: "source_record",
      origin: "execution_result", coordinate: { runId: fact?.factId ?? nativeMethodProjectionRunId(source, scope), sequence: fact?.sequence ?? 0 } }, start, maximumChars);
  }
  return undefined;
}
