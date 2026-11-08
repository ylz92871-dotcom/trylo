import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { ContentMaterialBatch, ContentMaterialSource, ContentRetrievalQuery, ContentSubsystem } from "../../learning/central/content/material-contract.js";
import { mergeContentBatches } from "../../learning/central/content/material.js";
import { selectRelatedContent } from "../../learning/central/content/material-source.js";
import { isContentRetrievalQuery } from "../../learning/central/content/material-parse.js";
import type { ContentFeedbackProjection } from "../../learning/central/content/feedback-contracts.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { readContentRecords } from "./records.js";
import { isContentDomainFeedbackReadRecord } from "./sources/domain-feedback-basis.js";

function subsystem(domain: string): ContentSubsystem {
  return domain === "prompt" ? "method" : domain === "tool" || domain === "workflow" || domain === "skill" ? domain : "collaboration";
}

/** Reuse only previously recorded, source-bound public results. Model results remain model claims. */
export function contentRecordMaterialBatch(record: ReturnType<typeof readContentRecords>[number], scope: string): ContentMaterialBatch {
    const { packet, output } = record;
    // A prior read receipt is historical, not the current source read. Keep the actual old
    // frame body for comparison; the original complete packet remains in its immutable fact.
    const previousReadRefs = new Set(packet.records.filter(isContentDomainFeedbackReadRecord).map(row => row.ref));
    const historicalRecords = packet.records.filter(row => !previousReadRefs.has(row.ref));
    const historicalMaterials = packet.materials.map(material => ({ ...material,
      recordRefs: material.recordRefs.filter(ref => !previousReadRefs.has(ref)) }))
      .filter(material => material.recordRefs.length + material.requirementIds.length + material.answerIds.length > 0);
    const aliases = packet.aliases?.map(alias => ({ ...alias, recordRefs: alias.recordRefs.filter(ref => !previousReadRefs.has(ref)) }))
      .filter(alias => alias.recordRefs.length > 0);
    const claims = [...output.applied.knowledge.map(row => ({ id: row.id, text: row.statement, conditions: row.conditions, citations: row.citations })),
      ...output.applied.applications.map(row => ({ id: row.id, text: row.result, conditions: row.conditions, citations: row.citations }))];
    const derived = claims.map((claim, index) => {
      const ref = `content-answer:${contentHashOf([record.factId, claim.id, index])}`;
      return { claim, ref, source: { ref, runId: record.factId, sequence: index, scope, origin: "model_proposal" as const,
        text: canonicalJson({ role: "previous_domain_model_result_not_independent_verification", result: claim.text,
          conditions: claim.conditions, sourceFactId: record.factId, processId: output.processId, citations: claim.citations }) } };
    });
    const issueIds = packet.focus === undefined ? [] : [packet.focus.issueId];
    const topicIds = record.handoff.kind === "new_topic" ? [record.handoff.topic.topicId] : [];
    // Transport earlier questions and their actual review, not just answer strings. Otherwise a
    // subsequent model cannot compare an unresolved/answered question with what it is proposing.
    const priorQuestions = output.applied.relations.map((relation, index) => {
      const ref = `content-question:${contentHashOf([record.factId, relation.id])}`;
      return { ref, runId: record.factId, sequence: derived.length + index, scope, origin: "model_proposal" as const,
        text: canonicalJson({ role: "previous_question_and_model_review", sourceFactId: record.factId,
          processId: output.processId, relation,
          assessment: output.review.assessments.find(item => item.relationId === relation.id),
          sourceQuestionWasSelected: output.review.selectedRelationId === relation.id,
          questionResolutionIsModelAssessment: true }) };
    });
    const processRef = `content-process:${contentHashOf(record.factId)}`;
    const process = { ref: processRef, runId: record.factId, sequence: derived.length + priorQuestions.length,
      scope, origin: "model_proposal" as const, text: canonicalJson({ role: "previous_public_preparation_and_review_not_verified_rule",
        sourceFactId: record.factId, processId: output.processId, originalApplications: output.applied.applications,
        preparations: output.applied.preparations,
        review: output.review, remaining: output.remaining,
        interpretation: "A preparation is a proposed capability or investigation, not proof it was acquired or used. Compare current support before repeating work." }) };

    return { ...(aliases === undefined ? {} : { aliases }),
      records: [...historicalRecords, ...derived.map(row => row.source), ...priorQuestions, process], requirements: packet.requirements,
      answers: [...packet.answers, ...derived.map(row => ({ answerId: row.ref, question: `Original public result ${row.claim.id} from ${packet.packetId}; consult original requirements.`,
        requirement: `Only the original requirements/support in ${packet.packetId}; no wider adequacy is certified.`,
        answer: row.claim.text, conditions: [row.claim.conditions, "Domain model result; support and adequacy require semantic review."],
        supportRefs: [row.ref, ...row.claim.citations.map(item => item.evidenceRef)], artifactRefs: [] }))],
      materials: [...historicalMaterials, ...derived.map(row => ({ id: row.ref, kind: "known_answer" as const, subsystem: subsystem(packet.domain),
        context: `Recorded public result from ${record.factId}; retain original conditions; not a verified asset.`,
        recordRefs: [row.ref, ...row.claim.citations.map(item => item.evidenceRef)], requirementIds: packet.requirements.map(item => item.id), answerIds: [row.ref],
        links: { issueIds, topicIds, artifactRefs: [] } })), ...priorQuestions.map(row => ({ id: row.ref,
          kind: "context" as const, subsystem: subsystem(packet.domain), context: "Original question and finite model review; no global resolution certificate.",
          recordRefs: [row.ref], requirementIds: packet.requirements.map(item => item.id), answerIds: [],
          links: { issueIds, topicIds, artifactRefs: [] } })), { id: processRef, kind: "context", subsystem: subsystem(packet.domain),
          context: "Previously recorded preparation and full review. Status and recommendation remain model assessments.",
          recordRefs: [processRef], requirementIds: packet.requirements.map(item => item.id), answerIds: [],
          links: { issueIds, topicIds, artifactRefs: [] } }] };
}

export function createBoardContentSource(facts: readonly RewardV2Fact[], scope: string, boardSequence: number,
  admit: (record: ReturnType<typeof readContentRecords>[number]) => boolean = () => true,
  projectRecord: (record: ReturnType<typeof readContentRecords>[number], scope: string, query: ContentRetrievalQuery) => ContentMaterialBatch
    = contentRecordMaterialBatch): ContentMaterialSource {
  const recorded = readContentRecords(facts, scope, boardSequence).filter(admit);
  return { async retrieve(query, signal) {
    if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

    if (!isContentRetrievalQuery(query)) return { ok: false, reason: "content_material_invalid" };

    if (query.scope !== scope) return { ok: false, reason: "content_material_scope" };

    if (query.boardSequence < boardSequence) return { ok: false, reason: "content_material_unavailable" };

    const batches: ContentMaterialBatch[] = [];

    for (const record of recorded) {
      // Filter at each source before merging. Unrelated archive size cannot starve a focused retrieval.
      batches.push(selectRelatedContent(projectRecord(record, scope, query), query));
    }

    return mergeContentBatches(batches);
  } };
}

/** The source reader's interpretation is labelled as a projection, with J/K/B and raw addresses inside. */
export function contentFeedbackMaterialBatch(projection: ContentFeedbackProjection, scope: string): ContentMaterialBatch {
  const selected = projection.materialRecords.filter((_row, index) => projection.rows[index]?.link.scope === scope);
  return { requirements: [], answers: [],
    records: selected.map(row => ({ ref: row.ref, runId: row.ref, sequence: 0, scope, origin: "execution_result" as const, text: row.text })),
    materials: selected.map(row => ({ id: row.ref, kind: "feedback" as const, subsystem: subsystem(row.domain),
      context: "Host feedback interpretation; report status, task result, costs and unverified gain claims have distinct roles.",
      recordRefs: [row.ref], requirementIds: [], answerIds: [], links: { issueIds: [row.issueId], topicIds: [], artifactRefs: [] } })) };
}
