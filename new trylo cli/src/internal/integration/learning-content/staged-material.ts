import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { ContentMaterialBatch, ContentPacket } from "../../learning/central/content/material-contract.js";
import { buildContentPacket, mergeContentBatches } from "../../learning/central/content/material.js";
import { contentSubsystem } from "./sources/artifact.js";
import type { TaskSourcePage } from "./task-source-pages.js";
import type { ContentStageRecord } from "./staged-records.js";

/** A requested source page becomes a new immutable input. The old request is never silently rewritten. */
export function extendContentStagePacket(packet: ContentPacket, page: TaskSourcePage, boardSequence: number,
  previousApplication?: ContentStageRecord) {
  const ref = `content-source-page:${contentHashOf(page)}`;
  if (packet.records.some(record => record.ref === ref)) return { ok: true as const, value: packet };

  const materials = [{ id: ref, kind: "context" as const, subsystem: contentSubsystem(packet.domain),
    context: canonicalJson({ role: "exact_source_page_not_complete_parent", parentRef: page.originalRef, requestedRef: page.ref,
      sourceHash: page.sourceHash, originalScope: page.originalScope, originalCoordinate: page.coordinate,
      start: page.start, end: page.end, totalChars: page.totalChars, sourceOwner: page.owner,
      ...(page.originalSource === undefined ? {} : { originalSource: page.originalSource }) }),
    recordRefs: [ref], requirementIds: [], answerIds: [], links: { issueIds: packet.focus === undefined ? [] : [packet.focus.issueId], topicIds: [], artifactRefs: [] } }];
  const records = [{ ref, runId: ref, sequence: 0, scope: packet.scope, origin: page.origin, text: page.text }];
  const previous = previousContentApplicationBatch(packet, previousApplication);
  const merged = mergeContentBatches([packet, { records, materials, requirements: [], answers: [] }, previous]);
  if (!merged.ok) return merged;

  return buildContentPacket({ ...merged.value, scope: packet.scope, domain: packet.domain, boardSequence,
    ...(packet.focus === undefined ? {} : { focus: packet.focus }), requestedRefs: packet.retrieval.requestedRefs });
}

/** The prior public application is retained as a claim when fresh source data replaces an unread snapshot. */
export function previousContentApplicationBatch(packet: ContentPacket, previousApplication?: ContentStageRecord): ContentMaterialBatch {
  const records: ContentMaterialBatch["records"][number][] = [], materials: ContentMaterialBatch["materials"][number][] = [];

  if (previousApplication?.body.kind === "applied") {
    // Preserve the previous public result as available knowledge; a later source page may challenge it.
    const prior = previousApplication;
    const applicationJson = previousApplication.body.applicationJson;
    const applicationRef = prior.ref;

    records.push({ ref: applicationRef, runId: `board-content-stage:${contentHashOf(packet.scope)}`, sequence: prior.sequence,
      scope: packet.scope, origin: "model_proposal", text: canonicalJson({ role: "previous_public_application_before_source_expansion",
        sourceFactId: prior.ref, applied: JSON.parse(applicationJson) }) });
    materials.push({ id: applicationRef, kind: "context", subsystem: contentSubsystem(packet.domain),
      context: "Previously completed public application. New source evidence may revise its support; do not re-certify it as an independent fact.",
      recordRefs: [applicationRef], requirementIds: [], answerIds: [], links: { issueIds: packet.focus === undefined ? [] : [packet.focus.issueId], topicIds: [], artifactRefs: [] } });
  }

  return { records, materials, requirements: [], answers: [] };
}

export function replaceContentStagePacket(packet: ContentPacket, boardSequence: number, previousApplication?: ContentStageRecord) {
  const merged = mergeContentBatches([packet, previousContentApplicationBatch(packet, previousApplication)]);
  return merged.ok ? buildContentPacket({ ...merged.value, scope: packet.scope, domain: packet.domain,
    boardSequence, requestedRefs: packet.retrieval.requestedRefs,
    ...(packet.focus === undefined ? {} : { focus: packet.focus }) }) : merged;
}
