import type { JsonObject } from "../../protocol/envelope.js";
import type { OrganizationFeedback, OrganizationFeedbackResult } from "../../learning/central/organization/index.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { CONTENT_SOURCE_VIEW_POLICY, projectContentSourceText } from "../learning-content/sources/source-text-view.js";

type DomainFrame = { readonly sourceRef: string; readonly sourceRefs: readonly string[]; readonly records: readonly JsonObject[] };

type Row = { readonly raw: JsonObject; readonly body: Record<string, unknown>; readonly kind: string; readonly unitRef: string };

type Exposure = { readonly domain: string; readonly ref: string; readonly versions: readonly string[]; readonly row: Row };

type PublicView = { readonly scope: string; readonly secrets?: readonly string[] };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const reference = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const refs = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter(reference) : [];
const unique = (values: readonly string[]) => [...new Set(values)];

function decodeRow(raw: JsonObject): Row {
  let body: Record<string, unknown> = raw;

  if (typeof raw.payloadJson === "string") {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.payloadJson); }
    catch { throw new Error("organization_domain_payload_invalid"); }
    if (!object(parsed)) throw new Error("organization_domain_payload_invalid");
    body = parsed;
  }

  const kind = typeof raw.kind === "string" ? raw.kind : typeof raw.schema === "string" ? raw.schema : "domain_metadata";
  // Method corrections may change observationId. Preserve the original domain's
  // opportunity/source unit rather than turning a corrected verdict into a trial.
  const identity = kind === "method_assessment"
    ? [body.versionId, body.taskId, body.opportunityId, body.source]
    : kind === "workflow_feedback" ? [raw.versionId, raw.useId, raw.feedbackId]
    : raw.factRef ?? raw.recordRef ?? raw.sourceRef ?? raw.receiptId ?? raw.versionId ?? [kind, raw.issueId ?? null];

  return { raw, body, kind, unitRef: `domain-feedback:${contentHashOf([kind, identity])}` };
}

function rowReferences(row: Row): readonly string[] {
  return unique([row.raw.factRef, row.raw.revisionRef, row.raw.recordRef, row.raw.sourceRef, row.raw.receiptId, row.raw.versionId]
    .filter(reference));
}

/** Full source rows stay intact. Oversized bodies are represented by a read
 * requirement, never a clipped passage that might omit an exception or failure. */
function summary(frame: DomainFrame, row: Row, interpretation: string, view?: PublicView): string {
  const metadata = { sourceKind: row.kind, sourceUnit: row.raw.unit ?? null,
    sourceFactRef: row.raw.factRef ?? row.raw.recordRef ?? row.raw.sourceRef ?? row.raw.receiptId ?? null,
    sourceRevisionRef: row.raw.revisionRef ?? row.raw.recordRef ?? row.raw.sourceRef ?? row.raw.receiptId ?? null, interpretation };
  const full = canonicalJson({ ...metadata, original: row.raw });
  const ref = rowReferences(row)[0] ?? frame.sourceRef;
  const projected = view === undefined ? undefined : projectContentSourceText({ ref, runId: ref, sequence: 0,
    scope: view.scope, origin: "model_proposal", text: full }, view.secrets ?? []);
  const publicProjection = projected?.changed ? { policy: CONTENT_SOURCE_VIEW_POLICY,
    originalSourceHash: projected.original.sourceHash, originalBodyHash: contentHashOf(row.raw),
    projectionRef: projected.record.ref, projectionHash: contentHashOf(projected.record.text) } : undefined;
  // Serialized native metadata is public prose here, not a privileged scope
  // slot. Reuse the original export policy and label any changed presentation.
  const text = publicProjection === undefined ? full : canonicalJson({ ...metadata, publicProjection, publicText: projected!.record.text });

  return text.length <= 4096 ? text : canonicalJson({ ...metadata, ...(publicProjection === undefined ? {} : { publicProjection }),
    original: { state: "original_body_must_be_read_by_ref", frameRef: frame.sourceRef, rowRefs: rowReferences(row),
      bodyHash: contentHashOf(row.raw), originalCharacters: canonicalJson(row.raw).length,
      omitted: "Complete original body, conditions and counterevidence are not reproduced; read the original reference before interpreting." } });
}

function directlyRelated(row: Row, related: ReadonlySet<string>, extra: readonly string[] = []): boolean {
  return [...rowReferences(row), ...extra, row.body.versionId, row.body.useId, row.body.exposureId,
    row.raw.versionId, row.raw.useId].some(value => reference(value) && related.has(value));
}

function sourceExposure(row: Row, related: ReadonlySet<string>, rows: readonly Row[]): Exposure | undefined {
  const body = row.body;
  if (row.kind === "tool_invocation" && reference(body.useId) && reference(body.versionId)
    && directlyRelated(row, related, [body.useId, body.versionId])) {
    return { domain: "tool", ref: body.useId, versions: [body.versionId], row };
  }

  if (row.kind === "collaboration_dispatched" && reference(row.raw.receiptId)) {
    const versions = refs(row.raw.relevantVersionIds);
    const matched = versions.filter(version => related.has(version));
    if (matched.length > 0 || directlyRelated(row, related)) {
      return versions.length === 0 ? undefined : { domain: "collaboration", ref: row.raw.receiptId,
        versions: matched.length > 0 ? matched : versions, row };
    }
  }

  if (row.kind === "method_execution" && object(body.trace) && reference(body.trace.exposureId)
    && reference(body.versionId) && directlyRelated(row, related, [body.trace.exposureId, body.versionId])) {
    return { domain: "method", ref: body.trace.exposureId, versions: [body.versionId], row };
  }

  if (row.kind === "workflow_feedback" && row.raw.exposure === "reported_used" && reference(row.raw.executionId)
    && reference(row.raw.useId) && reference(row.raw.versionId) && refs(row.raw.evidenceRefs).length > 0
    && rows.some(use => use.kind === "workflow_frozen_use" && use.raw.useId === row.raw.useId && use.raw.versionId === row.raw.versionId)
    && directlyRelated(row, related, [row.raw.useId, row.raw.versionId])) {
    return { domain: "workflow", ref: row.raw.useId, versions: [row.raw.versionId], row };
  }

  return undefined;
}

function methodExposure(row: Row, exposures: readonly Exposure[]): Exposure | undefined {
  const exact = reference(row.raw.exposureId) ? row.raw.exposureId : undefined;
  const matching = exposures.filter(exposure => {
    const body = exposure.row.body, trace = body.trace;
    return exposure.domain === "method" && object(trace) && body.versionId === row.body.versionId
      && (exact === undefined || exposure.ref === exact)
      && trace.taskId === row.body.taskId && trace.opportunityId === row.body.opportunityId
      && trace.scopeId === row.body.scopeId && trace.compilationId === row.body.compilationId;
  });
  const distinct = [...new Map(matching.map(exposure => [exposure.ref, exposure])).values()];

  return distinct.length === 1 ? distinct[0] : undefined;
}

function linkedOutcome(row: Row, exposures: readonly Exposure[]): { readonly exposure: Exposure; readonly known: boolean } | undefined {
  if (row.kind === "tool_task_assessment") {
    const useIds = refs(row.body.useIds);

    // One assessment can cover several calls. A single-exposure contract cannot
    // invent a representative call or multiply that assessment into outcomes.
    if (useIds.length !== 1) return undefined;

    const exposure = exposures.find(item => item.domain === "tool" && item.ref === useIds[0]
      && item.versions.includes(String(row.body.versionId)));

    return exposure === undefined ? undefined : { exposure, known: ["solved", "partial", "unsolved"].includes(String(row.body.outcome)) };
  }

  if (row.kind === "workflow_feedback") {
    const exposure = exposures.find(item => item.domain === "workflow" && item.ref === row.raw.useId
      && item.versions.includes(String(row.raw.versionId)));
    return exposure === undefined ? undefined : { exposure, known: row.raw.quality === "passed" || row.raw.quality === "failed" };
  }

  if (row.kind === "collaboration_use_feedback") {
    const exposure = exposures.find(item => item.domain === "collaboration" && item.ref === row.raw.usageReceiptId
      && refs(row.raw.relevantVersionIds).some(version => item.versions.includes(version)));
    return exposure === undefined ? undefined : { exposure, known: row.raw.outcome === "helped" || row.raw.outcome === "not_helped" };
  }

  if (row.kind === "method_assessment") {
    const exposure = methodExposure(row, exposures);
    return exposure === undefined ? undefined : { exposure, known: row.body.adoption === "adopted"
      && ["helped", "unhelpful", "external_failure"].includes(String(row.body.outcome)) };
  }

  return undefined;
}

/** Convert original public projections only. No source confidence, tool return,
 * PA report or independent task verdict is promoted into central causal gain. */
export function projectOrganizationDomainRows(decisionRef: string, frame: DomainFrame,
  relatedRefs: readonly string[], view?: PublicView): readonly OrganizationFeedback[] {
  const rows = frame.records.filter(row => typeof row.kind === "string").map(decodeRow);
  return projectRows(decisionRef, frame, rows, relatedRefs, view);
}

/** Decode an original issue once, then associate its original units through the
 * separate verified decision index. No per-decision copy of the issue history. */
export function indexOrganizationDomainRows(frame: DomainFrame, view?: PublicView): readonly {
  readonly feedback: OrganizationFeedback; readonly references: readonly string[];
}[] {
  const latest = new Map<string, Row>();

  for (const row of frame.records.filter(row => typeof row.kind === "string").map(decodeRow)) {
    // Source arrival, not locator hashes, orders revisions of one original unit.
    // Independent frozen-use/execution units remain available as exact closure.
    latest.delete(row.unitRef);
    latest.set(row.unitRef, row);
  }

  const rows = [...latest.values()];
  const context = new Map<string, readonly string[]>();

  for (const row of rows) context.set(row.unitRef, unique([...(context.get(row.unitRef) ?? []), ...rowReferences(row),
    ...[row.body.versionId, row.body.useId, row.body.exposureId, row.raw.useId].filter(reference),
    ...refs(row.raw.relevantVersionIds), ...refs(row.body.useIds),
    ...(object(row.body.trace) ? [row.body.trace.exposureId].filter(reference) : [])]));

  const allRefs = unique([...context.values()].flat());
  const heads = new Map<string, OrganizationFeedback>();

  for (const feedback of projectRows("organization-source-unit", frame, rows, allRefs, view)) {
    heads.set(canonicalJson([feedback.result.kind, feedback.unitRef]), feedback);
  }

  return [...heads.values()].map(feedback => ({ feedback,
    references: unique([...feedback.sourceRefs, ...(context.get(feedback.unitRef) ?? []),
      ...(feedback.result.kind === "adoption" ? feedback.result.artifactRefs : []),
      ...((feedback.result.kind === "adoption" || feedback.result.kind === "outcome") && feedback.result.exposureRef !== null
        ? [feedback.result.exposureRef] : [])]) }));
}

function projectRows(decisionRef: string, frame: DomainFrame, rows: readonly Row[],
  relatedRefs: readonly string[], view?: PublicView): readonly OrganizationFeedback[] {
  const related = new Set(relatedRefs), result: OrganizationFeedback[] = [];
  const emit = (row: Row, value: OrganizationFeedbackResult, extra: readonly string[] = []) => {
    // A new sibling row changes the frame hash, not this original unit. Stable
    // row refs prevent that unrelated arrival from revising every old feedback.
    const sources = unique([...rowReferences(row), ...extra]);
    result.push({ kind: "feedback", decisionRef, unitRef: row.unitRef, supersedes: null,
      sourceRefs: sources.length > 0 ? sources : [frame.sourceRef], result: value });
  };

  for (const row of rows) emit(row, { kind: "progress",
    summary: summary(frame, row, "Original domain report, not a central quality verdict. Adoption here describes source-level exposure, never following or behavioral success. Missing or insufficiently related adoption/outcome remains unknown.", view),
    remaining: ["Economic causation remains unknown; original PA/self-report and checker semantics are retained."], resultRefs: rowReferences(row) });

  const exposures = rows.flatMap(row => {
    const exposure = sourceExposure(row, related, rows);
    return exposure === undefined ? [] : [exposure];
  });
  const seenExposures = new Set<string>();

  for (const exposure of exposures) {
    const identity = canonicalJson([exposure.domain, exposure.ref]);
    if (seenExposures.has(identity)) continue;
    seenExposures.add(identity);
    emit(exposure.row, { kind: "adoption", state: "used", artifactRefs: exposure.versions, exposureRef: exposure.ref }, [exposure.ref, ...exposure.versions]);
  }

  for (const row of rows) {
    if (row.kind === "workflow_feedback" && row.raw.exposure === "skipped" && reference(row.raw.useId)
      && reference(row.raw.versionId) && directlyRelated(row, related)) {
      emit(row, { kind: "adoption", state: "not_observed", artifactRefs: [row.raw.versionId], exposureRef: row.raw.useId });
      emit(row, { kind: "outcome", state: "unknown", exposureRef: row.raw.useId, attribution: "unknown",
        summary: summary(frame, row, "Original source explicitly reports skipped use; no outcome is attributed to this learning asset.", view) });
    }

    const outcome = linkedOutcome(row, exposures);
    if (outcome !== undefined) emit(row, { kind: "outcome", state: outcome.known ? "observed" : "unknown",
      summary: summary(frame, row, "Original source-level observation/claim only. Exposure is not proof of following or behavioral success; attribution and economic gain remain unknown.", view),
      exposureRef: outcome.exposure.ref, attribution: "unknown" }, [outcome.exposure.ref, ...outcome.exposure.versions]);

    const userAssessment = row.raw.userAssessment;
    if (row.kind === "workflow_feedback" && object(userAssessment) && ["helped", "harmed", "neutral"].includes(String(userAssessment.judgment))
      && reference(userAssessment.evidenceRef) && directlyRelated(row, related)) {
      emit(row, { kind: "correction", statement: summary(frame, row, "Explicit original user assessment; not a central causal verdict.", view),
        conditions: "Only the original workflow version, use and execution in this source row; do not generalize across conditions." }, [userAssessment.evidenceRef]);
    }

    if (row.kind === "tool_contract_review" && row.body.approved === true && reference(row.body.revisionId)
      && directlyRelated(row, related, object(row.body.proposal) ? [row.body.proposal.parentVersionId].filter(reference) : [])) {
      emit(row, { kind: "correction", statement: summary(frame, row, "Original approved contract correction; not proof of use, task quality or gain.", view),
        conditions: "Only the original proposal, parent version and contract conditions; read the full source before applying." }, [row.body.revisionId]);
    }
  }

  return result;
}
