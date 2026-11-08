import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { CONTENT_MATERIAL_LIMITS, type ContentEvidenceRecord, type ContentMaterialBatch,
  type ContentRetrievalQuery } from "../../../learning/central/content/material-contract.js";
import type { readContentRecords } from "../records.js";
import { contentRecordMaterialBatch } from "../source.js";
import { contentSubsystem } from "./artifact.js";

type RecordedContent = ReturnType<typeof readContentRecords>[number];

const maximumChars = 9000;
const empty = (): ContentMaterialBatch => ({ records: [], requirements: [], answers: [], materials: [] });
const fits = (batch: ContentMaterialBatch) => canonicalJson(batch).length <= maximumChars
  && batch.records.length <= CONTENT_MATERIAL_LIMITS.records && batch.materials.length <= CONTENT_MATERIAL_LIMITS.materials
  && batch.answers.length <= CONTENT_MATERIAL_LIMITS.answers && batch.requirements.length <= CONTENT_MATERIAL_LIMITS.requirements;
const append = (left: ContentMaterialBatch, right: ContentMaterialBatch): ContentMaterialBatch => ({
  records: [...left.records, ...right.records], requirements: [...left.requirements, ...right.requirements],
  answers: [...left.answers, ...right.answers], materials: [...left.materials, ...right.materials],
});

/** Bounded transport of recorded public products. The immutable fact and exact source pager
 * remain the owners of the complete original evidence; this never certifies its adequacy. */
export function contentRecallMaterialBatch(record: RecordedContent, scope: string, query?: ContentRetrievalQuery): ContentMaterialBatch {
  const full = contentRecordMaterialBatch(record, scope), products = full.records.filter(row => row.runId === record.factId);
  const manifest = recallManifest(record, scope, full, products);
  const links = { issueIds: record.packet.focus === undefined ? [] : [record.packet.focus.issueId],
    topicIds: record.handoff.kind === "new_topic" ? [record.handoff.topic.topicId] : [], artifactRefs: [] };
  const context = (id: string, refs: readonly string[], kind: "context" | "known_answer" | "requirement" = "context") => ({
    id: `content-recall-material:${contentHashOf([record.factId, id])}`, kind, subsystem: contentSubsystem(record.packet.domain),
    context: "Recorded public model product with original conditions. Original evidence is deferred to exact read_material; no verified rule or adoption is asserted.",
    recordRefs: refs, requirementIds: [] as readonly string[], answerIds: [] as readonly string[], links,
  });
  let result: ContentMaterialBatch = { ...empty(), records: [manifest], materials: [context(manifest.ref, [manifest.ref])] };
  const add = (batch: ContentMaterialBatch) => {
    const trial = append(result, batch);
    if (fits(trial)) result = trial;
  };

  // Keep the complete review/preparation ahead of optional questions; a no-answer result
  // can still be useful. Large individual products remain explicit deferred sources.
  for (const source of products.filter(row => row.ref.startsWith("content-process:"))) {
    const complete = { ...empty(), records: [source], materials: [context(source.ref, [source.ref, manifest.ref])] };
    const delivered = fits(append(result, complete)) ? source : recallProcessIndex(record, scope, source.ref, products.length + 1);
    add({ ...empty(), records: [delivered], materials: [context(delivered.ref, [delivered.ref, manifest.ref])] });
  }

  for (const source of products.filter(row => row.ref.startsWith("content-answer:"))) {
    const answer = full.answers.find(row => row.answerId === source.ref);
    if (answer === undefined) continue;
    const answerId = `content-recall-answer:${contentHashOf([record.factId, answer.answerId])}`;
    add({ ...empty(), records: [source], answers: [{ ...answer, answerId, supportRefs: [source.ref, manifest.ref] }],
      materials: [{ ...context(source.ref, [source.ref, manifest.ref], "known_answer"), answerIds: [answerId] }] });
  }

  for (const source of products.filter(row => row.ref.startsWith("content-question:"))) {
    add({ ...empty(), records: [source], materials: [context(source.ref, [source.ref, manifest.ref])] });
  }

  for (const original of record.packet.requirements) {
    const id = `content-recall-requirement:${contentHashOf([record.factId, original.id])}`;
    // This projection has a distinct identity: changing structural sourceRefs on the
    // original requirement would conflict or implicitly request its entire old evidence.
    add({ ...empty(), requirements: [{ ...original, id, sourceRefs: [manifest.ref] }],
      materials: [{ ...context(id, [manifest.ref], "requirement"), requirementIds: [id] }] });
  }

  if (query === undefined) return result;

  const requested = new Set(query.sourceRefs), aliases = full.aliases?.filter(alias => requested.has(alias.ref)) ?? [];

  for (const alias of aliases) alias.recordRefs.forEach(ref => requested.add(ref));

  for (const source of full.records.filter(row => requested.has(row.ref) && !result.records.some(delivered => delivered.ref === row.ref))) {
    // Explicit source requests may add a complete small record, never a large issue-wide
    // archive. Oversized records remain missing until the caller reads their actual page.
    const material = context(`content-recall-exact:${contentHashOf([record.factId, source.ref])}`, [source.ref, manifest.ref]);
    const withSource = { ...empty(), records: [source], materials: [material] };
    if (fits(append(result, withSource))) add(withSource);
    else add({ ...empty(), materials: [material] });
  }

  const retainedAliases: NonNullable<ContentMaterialBatch["aliases"]>[number][] = [];

  for (const alias of aliases) {
    const trial = { ...result, aliases: [...retainedAliases, alias] };
    if (fits(trial)) retainedAliases.push(alias);
  }

  return retainedAliases.length === 0 ? result : { ...result, aliases: retainedAliases };
}

/** Oversized public results still expose a bounded, explicitly partial source index to the
 * ordinary model. Whole preparation entries are retained; no excerpt becomes an answer. */
function recallProcessIndex(record: RecordedContent, scope: string, originalProcessRef: string, sequence: number): ContentEvidenceRecord {
  const preparations: typeof record.output.applied.preparations[number][] = [];
  const originalRecommendation = record.output.review.recommendation;
  const recommendation = canonicalJson(originalRecommendation).length <= 1600 ? originalRecommendation : null;
  const body = () => ({ role: "source_owned_partial_public_process_index_not_original_review", sourceFactId: record.factId,
    processId: record.output.processId, originalProcessRef, originalFullRef: record.factId, readWith: "read_material",
    preparations, omittedPreparations: record.output.applied.preparations.length - preparations.length,
    recommendation, recommendationKind: originalRecommendation.kind, recommendationDeferred: recommendation === null,
    reviewDeferred: true, remainingQuestions: record.output.remaining.length,
    interpretation: "Only the listed whole preparations and recommendation have been transported. The complete original public review and other preparations require exact source paging; this index neither clears residuals nor verifies a rule." });

  for (const preparation of record.output.applied.preparations) {
    preparations.push(preparation);
    if (canonicalJson(body()).length > 2600) preparations.pop();
  }

  const text = canonicalJson(body()), ref = `content-process:${contentHashOf([record.factId, text])}`;

  return { ref, runId: record.factId, sequence, scope, origin: "execution_result", text };
}

function recallManifest(record: RecordedContent, scope: string, full: ContentMaterialBatch,
  products: readonly ContentEvidenceRecord[]): ContentEvidenceRecord {
  const cited = new Set([...record.output.applied.knowledge.flatMap(row => row.citations.map(citation => citation.evidenceRef)),
    ...record.output.applied.applications.flatMap(row => row.citations.map(citation => citation.evidenceRef)),
    ...record.output.applied.preparations.flatMap(row => row.sourceRefs)]);
  const sources = full.records.filter(row => row.runId !== record.factId);
  const ordered = [...sources.filter(row => cited.has(row.ref)), ...sources.filter(row => !cited.has(row.ref))];
  const listed: { ref: string; runId: string; sequence: number; scope: string; origin: string; chars: number; sourceHash: string }[] = [];
  const body = () => ({ role: "bounded_public_product_recall_original_evidence_deferred", sourceFactId: record.factId,
    originalPacketId: record.packet.packetId, processId: record.output.processId,
    originalFullRef: record.factId, readWith: "read_material", originalRecords: sources.length,
    listedOriginalRecords: listed, unlistedOriginalRecords: sources.length - listed.length,
    productRefs: products.slice(0, 8).map(row => row.ref), unlistedProductRefs: Math.max(0, products.length - 8),
    originalRequirements: record.packet.requirements.length,
    interpretation: "Only records actually in this packet have entered this comparison. Read originalFullRef for the complete public product and original support addresses, or an exact listed ref for its source text. Claims, conditions, preparation and review remain original model assessments; deferred original evidence is not asserted complete or verified." });

  for (const source of ordered) {
    listed.push({ ref: source.ref, runId: source.runId, sequence: source.sequence, scope: source.scope, origin: source.origin,
      chars: source.text.length, sourceHash: contentHashOf(source.text) });
    if (canonicalJson(body()).length > 2600) {
      listed.pop();
      break;
    }
  }

  const text = canonicalJson(body()), ref = `content-recall-manifest:${contentHashOf(text)}`;

  return { ref, runId: ref, sequence: 0, scope, origin: "execution_result", text };
}
