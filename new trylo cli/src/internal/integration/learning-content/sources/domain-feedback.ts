import { isCentralLearningSourceContext } from "../../../learning/control/source-context.js";
import { LEARNING_DOMAINS } from "../../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { identity, text } from "../../../validation/json-shape.js";
import type { ContentEvidenceRecord, ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import { mergeContentBatches } from "../../../learning/central/content/material.js";
import { contentSubsystem } from "./artifact.js";
import { pageContentMaterial } from "./artifact-read.js";
import { projectContentSourceText, CONTENT_SOURCE_VIEW_POLICY } from "./source-text-view.js";
import { MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS, type DomainFeedbackMaterialCoverage, type DomainFeedbackMaterialInput, type DomainFeedbackMaterialRead } from "./domain-feedback-contract.js";
import { buildContentDomainFeedbackAbsenceRecord, buildContentDomainFeedbackBasisRecord, contentDomainFeedbackText, isContentDomainFeedback } from "./domain-feedback-basis.js";

export type * from "./domain-feedback-contract.js";
export { MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS } from "./domain-feedback-contract.js";
export * from "./domain-feedback-basis.js";

interface SourceFrame { readonly ref: string; readonly text: string; readonly sourceHash: string; readonly issueIds: string[];
  readonly basisRecords: ContentEvidenceRecord[] }

const empty = (): ContentMaterialBatch => ({ records: [], requirements: [], answers: [], materials: [] });
const runIdFor = (scope: string, ref: string): string => `domain-feedback-frame-projection:${contentHashOf([scope, ref])}`;

/** Read selected original issues once. An unavailable reader is a transport gap, never an empty successful feedback set. */
export async function readDomainFeedbackMaterial(input: DomainFeedbackMaterialInput): Promise<DomainFeedbackMaterialRead> {
  const requested = Array.isArray(input.issueIds) ? [...new Set(input.issueIds)] : [], absent: string[] = [], frames = new Map<string, SourceFrame>();
  const gaps: { readonly issueId: string; readonly reason: "reader_failed" | "frame_invalid" | "source_ref_conflict" }[] = [];
  const maximumChars = input.maximumChars ?? 12000;
  const coverage = (): DomainFeedbackMaterialCoverage => ({ requestedIssueIds: requested, absentIssueIds: absent,
    frames: [...frames.values()].map(frame => ({ issueIds: frame.issueIds, ref: frame.ref, sourceHash: frame.sourceHash,
      totalChars: frame.text.length, transport: "deferred" })), gaps });

  if (typeof input.reader !== "function" && typeof input.domainFeedback !== "function" || !Array.isArray(input.issueIds) || requested.length > 32
    || input.domainFeedback !== undefined && (typeof input.domainFeedback !== "function" || input.board === undefined)
    || requested.some(issue => !text(issue, 512)) || !identity(input.scope) || !LEARNING_DOMAINS.includes(input.domain)
    || !Number.isSafeInteger(maximumChars) || maximumChars < 1024 || maximumChars > MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS) {
    return { ok: false, reason: "content_domain_feedback_input_invalid", coverage: coverage() };
  }

  for (const issueId of requested) {
    if (input.signal.aborted) return { ok: false, reason: "content_material_cancelled", coverage: coverage() };

    let frame: unknown, basis: ContentEvidenceRecord | undefined;

    try {
      const projected: unknown = input.domainFeedback === undefined ? undefined : await input.domainFeedback(input.board!, issueId);
      if (projected !== undefined) {
        if (!isContentDomainFeedback(projected)) {
          gaps.push({ issueId, reason: "frame_invalid" });
          continue;
        }
        frame = { ref: projected.sourceRef, text: contentDomainFeedbackText(projected) };
        basis = buildContentDomainFeedbackBasisRecord(projected, issueId, input.scope);
      } else frame = input.reader === undefined ? undefined : await input.reader(issueId);
    }
    catch {
      gaps.push({ issueId, reason: "reader_failed" });
      continue;
    }

    if (frame === undefined) {
      absent.push(issueId);
      continue;
    }

    // Pure domain facts retain their complete JSON body even beyond the legacy context's 65536-char envelope.
    if (basis === undefined && !isCentralLearningSourceContext(frame)) {
      gaps.push({ issueId, reason: "frame_invalid" });
      continue;
    }

    if (typeof frame !== "object" || frame === null || !("ref" in frame) || !("text" in frame)
      || typeof frame.ref !== "string" || typeof frame.text !== "string") {
        gaps.push({ issueId, reason: "frame_invalid" });
        continue;
      }

    const prior = frames.get(frame.ref);
    if (prior !== undefined && prior.text !== frame.text) {
      gaps.push({ issueId, reason: "source_ref_conflict" });
      continue;
    }

    if (prior !== undefined) {
      prior.issueIds.push(issueId);
      if (basis !== undefined) prior.basisRecords.push(basis);
    }
    else frames.set(frame.ref, { ref: frame.ref, text: frame.text, sourceHash: contentHashOf(frame.text), issueIds: [issueId], basisRecords: basis === undefined ? [] : [basis] });
  }

  if (input.signal.aborted) return { ok: false, reason: "content_material_cancelled", coverage: coverage() };

  if (gaps.length > 0) return { ok: false, reason: "content_domain_feedback_transport_gap", coverage: coverage() };

  const absenceRecords = absent.map(issueId => buildContentDomainFeedbackAbsenceRecord(issueId, input.scope));
  const absence: ContentMaterialBatch = { records: absenceRecords, requirements: [], answers: [], materials: absenceRecords.map((record, index) => ({
    id: record.ref, kind: "feedback", subsystem: contentSubsystem(input.domain),
    context: "The configured original owner currently supplied no frame. This is an observed source absence, not a retraction of historical facts or a learning-gain verdict.",
    recordRefs: [record.ref], requirementIds: [], answerIds: [], links: { issueIds: [absent[index]!], topicIds: [], artifactRefs: [] } })) };
  if (canonicalJson(absence).length > maximumChars) return { ok: false, reason: "content_domain_feedback_capacity", coverage: coverage() };

  const batches = [empty(), absence], frameCoverage: DomainFeedbackMaterialCoverage["frames"][number][] = [];

  for (const frame of frames.values()) {
    const full = frameBatch(input, frame, "inline"), inline = mergeContentBatches([...batches, full]);
    let transport: "inline" | "manifest" | "deferred" = "deferred";

    if (inline.ok && canonicalJson(inline.value).length <= maximumChars) {
      batches.push(full);
      transport = "inline";
    }
    else {
      const manifest = frameBatch(input, frame, "manifest"), projected = mergeContentBatches([...batches, manifest]);
      if (projected.ok && canonicalJson(projected.value).length <= maximumChars) {
        batches.push(manifest);
        transport = "manifest";
      }
    }

    frameCoverage.push({ issueIds: [...frame.issueIds], ref: frame.ref, sourceHash: frame.sourceHash, totalChars: frame.text.length, transport });

    if (transport === "deferred") return { ok: false, reason: "content_domain_feedback_capacity", coverage: { ...coverage(),
      frames: coverage().frames.map(row => frameCoverage.find(item => item.ref === row.ref) ?? row) } };
  }

  const batch = mergeContentBatches(batches);
  if (!batch.ok) return { ok: false, reason: batch.reason, coverage: coverage() };

  return { ok: true, value: { batch: batch.value, coverage: { requestedIssueIds: requested, absentIssueIds: absent, frames: frameCoverage, gaps },

    readMaterial(ref, start = 0, maximum = 4096) {
      const frame = frames.get(ref) ?? [...frames.values()].find(row => frameView(input, row).record.ref === ref);
      if (frame === undefined) {
        const absent = absenceRecords.find(record => record.ref === ref);
        return absent === undefined ? { ok: false, reason: "content_material_missing" } : pageContentMaterial({ ref, requestedRef: ref,
          text: absent.text, originalScope: input.scope, sourceRefs: [ref], ...(input.secrets === undefined ? {} : { secrets: input.secrets }), admissibility: "source_record", origin: absent.origin,
          coordinate: { runId: absent.runId, sequence: absent.sequence } }, start, maximum);
      }

      return pageContentMaterial({ ref: frame.ref, requestedRef: ref, text: frame.text, originalScope: input.scope, sourceRefs: [frame.ref], ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
        admissibility: "source_record", origin: "model_proposal", coordinate: { runId: runIdFor(input.scope, frame.ref), sequence: 0 } }, start, maximum);
    } } };
}

function frameBatch(input: DomainFeedbackMaterialInput, frame: SourceFrame, transport: "inline" | "manifest"): ContentMaterialBatch {
  const view = frameView(input, frame);
  const publicView = view.changed ? { ref: view.record.ref, sourceHash: contentHashOf(view.record.text), totalChars: view.record.text.length,
    originalSource: view.original, policy: CONTENT_SOURCE_VIEW_POLICY } : undefined;
  const body = transport === "inline" ? view.record.text : canonicalJson({ role: "owner_feedback_frame_manifest_not_full_feedback_or_verification",
    originalRef: frame.ref, sourceHash: frame.sourceHash, issueIds: frame.issueIds, totalChars: frame.text.length,
    ...(publicView === undefined ? {} : { publicView }),
    preview: view.record.text.slice(0, 512), previewOmittedChars: Math.max(0, view.record.text.length - 512),
    read: { ref: frame.ref, start: 0, maximumChars: 8192 },
    interpretation: "Read the complete source frame before resolving its conditions; this manifest certifies no task result, causal contribution or learning gain." });
  const ref = transport === "inline" ? view.record.ref : `domain-feedback-manifest:${contentHashOf(body)}`;

  return { records: [{ ref, runId: transport === "inline" ? view.record.runId : ref, sequence: 0,
    scope: input.scope, origin: "model_proposal", text: body }, ...frame.basisRecords], requirements: [], answers: [],
    materials: [{ id: ref, kind: "feedback", subsystem: contentSubsystem(input.domain), context: canonicalJson({
      source: "CentralLearningContextReader", coordinateKind: "owner_source_frame_projection_not_execution_event", transport,
      originalRef: frame.ref, sourceHash: frame.sourceHash, originalTextChars: frame.text.length,
      ...(publicView === undefined ? {} : { publicView }),
      originalDomain: input.domain, interpretation: "Source-bound domain analysis; no authority or learning-gain upgrade is inferred from its body." }),
      recordRefs: [...new Set([ref, frame.ref, ...frame.basisRecords.map(record => record.ref)])], requirementIds: [], answerIds: [], links: { issueIds: frame.issueIds, topicIds: [], artifactRefs: [] } }],
    ...(transport === "inline" && view.changed ? { aliases: [{ ref: frame.ref, recordRefs: [view.record.ref] }] } : {}) };
}

function frameView(input: DomainFeedbackMaterialInput, frame: SourceFrame) {
  return projectContentSourceText({ ref: frame.ref, runId: runIdFor(input.scope, frame.ref), sequence: 0,
    scope: input.scope, origin: "model_proposal", text: frame.text }, input.secrets);
}
