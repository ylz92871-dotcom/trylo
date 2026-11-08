import { canonicalJson, contentHashOf, sha256Hex } from "../../control/hash.js";
import { groundLearningQuestion } from "../../domains/shared/topics/ground.js";
import type { GroundedQuestion, TopicEvidenceWindow, TopicFailureReason } from "../../domains/shared/topics/contracts.js";
import type { ContentPacket } from "./material-contract.js";
import type { ContentProcessOutput } from "./process.js";

export interface ContentExcerpt {
  readonly evidenceRef: string;
  readonly sourceRef: string;
  readonly sourceRunId: string;
  readonly sourceSequence: number;
  readonly sourceHash: string;
  readonly start: number;
  readonly end: number;
}

export type ContentTopicHandoff = { readonly kind: "no_new_topic"; readonly reason: string }
  | { readonly kind: "existing_question"; readonly priorRefs: readonly string[]; readonly relationId: string }
  | { readonly kind: "new_topic"; readonly topic: GroundedQuestion; readonly proposalJson: string;
      readonly windowJson: string; readonly excerpts: readonly ContentExcerpt[] };

/** Long sources keep their full original content in the content fact. A WS1 excerpt gets its own
 * identity and explicit offsets, never masquerades as the full original record. */
export function buildContentTopicHandoff(packet: ContentPacket, output: ContentProcessOutput):
  { readonly ok: true; readonly value: ContentTopicHandoff } | { readonly ok: false; readonly reason: TopicFailureReason | "content_selection_invalid" } {
  const selectedId = output.review.selectedRelationId;
  if (selectedId === null) return { ok: true, value: { kind: "no_new_topic", reason: "no_selected_residual_preserves_existing_problem" } };

  const selected = output.remaining.find(row => row.id === selectedId);
  if (selected === undefined) return { ok: false, reason: "content_selection_invalid" };

  const priorRefs = output.review.comparisons.filter(row => row.relationId === selected.id && row.kind === "same_question").map(row => row.priorRef);
  if (priorRefs.length > 0) return { ok: true, value: { kind: "existing_question", priorRefs: [...new Set(priorRefs)], relationId: selected.id } };

  const records: TopicEvidenceWindow["records"][number][] = [], excerpts: ContentExcerpt[] = [];
  const citations = selected.citations.map(citation => {
    const source = packet.records.find(row => row.ref === citation.evidenceRef)!;
    if (source === undefined) return citation; // The existing grounding reader returns the typed missing-evidence failure.

    if (source.text.length <= 2048 && source.ref.length <= 256 && source.runId.length <= 256) {
      if (!records.some(row => row.ref === source.ref)) records.push(source);
      return citation;
    }

    const quoteAt = source.text.indexOf(citation.quote), start = Math.max(0, quoteAt - 512);
    let end = Math.min(source.text.length, start + 2048);

    // Do not split a UTF-16 surrogate pair at the excerpt boundary.
    if (end < source.text.length && /[\ud800-\udbff]/.test(source.text[end - 1]!)) end -= 1;

    const excerptStart = start > 0 && /[\udc00-\udfff]/.test(source.text[start]!) ? start + 1 : start;
    const sourceHash = sha256Hex(source.text), ref = `content-excerpt:${contentHashOf([packet.packetId, source.ref, excerptStart, end])}`;
    if (!records.some(row => row.ref === ref)) {
      records.push({ ...source, ref, runId: ref, text: source.text.slice(excerptStart, end) });
      excerpts.push({ evidenceRef: ref, sourceRef: source.ref, sourceRunId: source.runId, sourceSequence: source.sequence,
        sourceHash, start: excerptStart, end });
    }

    return { ...citation, evidenceRef: ref };
  });
  const watermarks = new Map<string, number>();

  for (const record of records) watermarks.set(record.runId, Math.max(watermarks.get(record.runId) ?? 0, record.sequence));

  const windowJson = canonicalJson({ schemaVersion: 1, scope: packet.scope, domain: packet.domain, boardSequence: packet.boardSequence,
    records, watermarks: [...watermarks].map(([runId, throughSequence]) => ({ runId, throughSequence })) });
  const proposalJson = canonicalJson({ kind: "topic", question: selected.question, whenRelevant: selected.whenRelevant,
    expectedChange: selected.expectedChange, citations });
  const grounded = groundLearningQuestion(canonicalJson({ schemaVersion: 2, question: selected.question,
    whenRelevant: selected.whenRelevant, expectedChange: selected.expectedChange, citations }), windowJson);

  return grounded.ok ? { ok: true, value: { kind: "new_topic", topic: grounded.value, proposalJson, windowJson, excerpts } } : grounded;
}
