import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { isMethodObservation } from "../../learning/agent/subsystems/method/domain/inference.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import { isJsonData, recordOf } from "../../tooling/contract/json-value.js";
import { contentDomainFeedbackText, isContentDomainFeedback,
  type ContentDomainFeedbackReader } from "../learning-content/sources/domain-feedback-basis.js";
import { centralResearchSourcePage } from "./research-intake-episode-sources.js";
import { CentralResearchIntakeError } from "./research-intake-common.js";
import { isNativeFeedbackUnitPublicView, type NativeFeedbackUnitPublicView } from "./native-feedback-unit-view.js";
import { PUBLIC_SOURCE_BODY_PREFIX, readRuntimePublicSourceFrame } from "./runtime-source-frames.js";
import { isLearningDependency } from "../../learning/control/coordination-parse.js";
import { nativeFeedbackUnitCanonicalRow } from "./native-feedback-unit-canonical-row.js";

type ReadFragment = { readonly text: string; readonly originalRef: string; readonly sourceHash: string;
  readonly start: number; readonly end: number; readonly totalChars: number; readonly locatorIssue?: string };

type Unit = { readonly role: string; readonly identity: JsonValue; readonly revision: JsonValue; readonly body: JsonValue };

const ref = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
const object = (value: unknown): value is JsonObject => recordOf(value) && isJsonData(value, 32);
const ids = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.every(ref);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function sameOwnerFrameRef(observed: string, current: string): boolean {
  const prefix = current.slice(0, current.lastIndexOf(":") + 1);
  return prefix.length > 0 && digest(current.slice(prefix.length))
    && observed.startsWith(prefix) && digest(observed.slice(prefix.length));
}

function issueFromLocator(value: string): string | undefined {
  const match = /^central-runtime-domain(?:-body)?:([^:]+):([a-f0-9]{64})$/.exec(value);
  if (match === null) return undefined;
  let issue: string;
  try { issue = decodeURIComponent(match[1]!); }
  catch { return undefined; }
  return ref(issue) && encodeURIComponent(issue) === match[1] ? issue : undefined;
}

/** Only host-minted transport metadata is inspected. JSON in a user's source
 * body is never recursively interpreted as an owner frame or source page. */
function fragment(material: CentralRuntimeMaterial, scope: string, board?: BoardState, compatibleScopes?: readonly string[]): ReadFragment | undefined {
  const page = centralResearchSourcePage(material, scope, { acceptedScopes: compatibleScopes ?? [], ...(board === undefined ? {} : { board }) });
  const archivedFrame = (ref: string) => board === undefined ? undefined : readRuntimePublicSourceFrame(board,
    { scope, ref, ...(compatibleScopes === undefined ? {} : { compatibleScopes }) });

  if (page !== undefined) {
    if (page.owner !== "domain_feedback") return undefined;

    const archivedRef = [page.ref, page.originalRef].find(value => value.startsWith(PUBLIC_SOURCE_BODY_PREFIX));
    if (archivedRef !== undefined) {
      const archived = archivedFrame(archivedRef);
      if (archived === undefined || !ref(archived.origin.issueId) || page.totalChars !== archived.text.length
        || page.sourceHash !== archived.publicTextHash || page.text !== archived.text.slice(page.start, page.end)) return undefined;
      return { text: page.text, originalRef: archived.ref, locatorIssue: archived.origin.issueId, sourceHash: archived.publicTextHash,
        start: page.start, end: page.end, totalChars: page.totalChars };
    }

    const locatorIssue = issueFromLocator(page.ref) ?? issueFromLocator(page.originalRef);

    return { text: page.text, originalRef: page.originalSource?.ref ?? page.originalRef, sourceHash: page.sourceHash,
      start: page.start, end: page.end, totalChars: page.totalChars,
      ...(locatorIssue === undefined ? {} : { locatorIssue }) };
  }

  if (material.kind !== "feedback") return undefined;

  if (material.ref.startsWith(PUBLIC_SOURCE_BODY_PREFIX)) {
    const archived = archivedFrame(material.ref);
    return archived !== undefined && ref(archived.origin.issueId) && material.text === archived.text
      ? { text: material.text, originalRef: archived.ref, locatorIssue: archived.origin.issueId, sourceHash: archived.publicTextHash,
        start: 0, end: material.text.length, totalChars: material.text.length } : undefined;
  }

  const direct = issueFromLocator(material.ref);
  if (direct !== undefined) {
    const prefix = material.ref.startsWith("central-runtime-domain-body:") ? "central-runtime-domain-body" : "central-runtime-domain";
    const expected = `${prefix}:${encodeURIComponent(direct)}:${contentHashOf(material.text)}`;
    return material.ref === expected ? { text: material.text, originalRef: material.ref, locatorIssue: direct,
      sourceHash: contentHashOf(material.text), start: 0, end: material.text.length, totalChars: material.text.length } : undefined;
  }

  if (!material.ref.startsWith("central-runtime-fragment:")) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); }
  catch { return undefined; }

  if (!fields(body, ["originalRef", "start", "end", "totalChars", "text", "nextRef"])
    || !ref(body.originalRef) || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars)
    || typeof body.text !== "string" || body.end <= body.start || body.end > body.totalChars
    || body.text.length !== body.end - body.start || canonicalJson(body) !== material.text
    || material.ref !== `central-runtime-fragment:${contentHashOf([body.originalRef, body.start, body.text])}`
    || !material.sourceRefs.includes(body.originalRef)) return undefined;

  const archived = body.originalRef.startsWith(PUBLIC_SOURCE_BODY_PREFIX) ? archivedFrame(body.originalRef) : undefined;
  if (body.originalRef.startsWith(PUBLIC_SOURCE_BODY_PREFIX) && (archived === undefined || body.totalChars !== archived.text.length
    || body.text !== archived.text.slice(body.start, body.end))) return undefined;

  const locatorIssue = archived !== undefined && ref(archived.origin.issueId) ? archived.origin.issueId : issueFromLocator(body.originalRef);
  const nextRef = body.end < body.totalChars
    ? `central-runtime-page:${body.end}:${encodeURIComponent(body.originalRef)}` : null;

  return locatorIssue !== undefined && body.nextRef === nextRef
    ? { text: body.text, originalRef: body.originalRef, locatorIssue, sourceHash: archived?.publicTextHash ?? body.originalRef.slice(-64),
      start: body.start, end: body.end, totalChars: body.totalChars } : undefined;
}

/** Join only contiguous actually read bytes of one immutable source view. Gaps
 * and different revisions cannot manufacture a complete row across pages. */
function contiguousReads(reads: readonly ReadFragment[]): readonly ReadFragment[] {
  const groups = new Map<string, ReadFragment[]>();

  for (const read of reads) {
    const key = canonicalJson([read.originalRef, read.sourceHash, read.totalChars]);
    const group = groups.get(key) ?? [];
    group.push(read);
    groups.set(key, group);
  }

  const result: ReadFragment[] = [];
  const retain = (read: { readonly start: number; readonly text: string }, source: ReadFragment) => {
    if (read.start === 0 && read.text.length === source.totalChars && contentHashOf(read.text) !== source.sourceHash) {
      throw new CentralResearchIntakeError("central_research_native_read_hash", [source.originalRef]);
    }
    result.push({ ...source, ...read, end: read.start + read.text.length });
  };

  for (const group of groups.values()) {
    let current: { readonly start: number; text: string } | undefined;

    for (const read of group.sort((a, b) => a.start - b.start)) {
      if (current === undefined || read.start > current.start + current.text.length) {
        if (current !== undefined) retain(current, group[0]!);
        current = { start: read.start, text: read.text };
        continue;
      }

      const offset = read.start - current.start, overlap = Math.min(current.text.length - offset, read.text.length);
      if (current.text.slice(offset, offset + overlap) !== read.text.slice(0, overlap)) {
        throw new CentralResearchIntakeError("central_research_native_read_conflict", [read.originalRef]);
      }

      current.text += read.text.slice(overlap);
    }

    if (current !== undefined) retain(current, group[0]!);
  }

  return result;
}

/** A locator only selects a demand-directed owner read. It supplies no evidence
 * signature until that owner's complete original row was actually read. */
export function centralResearchNativeEvidenceIssueRefs(materials: readonly CentralRuntimeMaterial[], scope: string, board?: BoardState,
  compatibleScopes?: readonly string[]): readonly string[] {
  return [...new Set(materials.flatMap(material => {
    const read = fragment(material, scope, board, compatibleScopes);
    return read?.locatorIssue === undefined ? [] : [read.locatorIssue];
  }))].sort();
}

function payload(row: JsonObject): JsonObject | undefined {
  if (typeof row.payloadJson !== "string") return undefined;
  let body: unknown;
  try { body = JSON.parse(row.payloadJson); }
  catch { return undefined; }
  return object(body) && canonicalJson(body) === row.payloadJson ? body : undefined;
}

function completeOwnerFrame(body: string, currentRef?: string) {
  let raw: unknown;

  try { raw = JSON.parse(body); }
  catch { return undefined; }

  if (!fields(raw, ["role", "sourceRef", "sourceRefs", "records", "interpretation"])
    || raw.role !== "source_bound_domain_feedback_records") return undefined;

  const frame = { sourceRef: raw.sourceRef, sourceRefs: raw.sourceRefs, records: raw.records };

  return isContentDomainFeedback(frame) && contentDomainFeedbackText(frame) === body
    && (currentRef === undefined || sameOwnerFrameRef(frame.sourceRef, currentRef))
    ? frame : undefined;
}

function completeObjectEnd(source: string, start: number): number | undefined {
  let depth = 0, quoted = false, escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }

  return undefined;
}

/** Only authenticated owner fragments reach this reader. A complete canonical
 * object is required; JSON encoded inside a string is never decoded again. */
function completeReadRows(source: string): readonly JsonObject[] {
  const rows: JsonObject[] = [];
  let offset = 0;

  while (offset < source.length) {
    const start = source.indexOf('{"', offset);
    if (start < 0) break;

    const end = completeObjectEnd(source, start);

    offset = end ?? start + 1;

    if (end === undefined) continue;

    const serialized = source.slice(start, end);
    let row: unknown;

    try { row = JSON.parse(serialized); }
    catch { continue; } // An incomplete or invalid object establishes no read unit.

    if (object(row) && typeof row.kind === "string" && canonicalJson(row) === serialized) rows.push(row);
  }

  return rows;
}

function methodBusinessUnit(row: JsonObject, body: JsonObject, board: BoardState): Unit | undefined {
  const bodyHash = contentHashOf(body);

  if (row.kind === "method_delivery") {
    const fielding = board.fieldings.find(item => item.exposureId === row.factRef && contentHashOf(item) === bodyHash);
    return fielding === undefined ? undefined : { role: "provider_delivery_not_following_or_quality",
      identity: [fielding.versionId, fielding.exposureId], revision: fielding.exposureId, body };
  }

  const fact = board.methodExperienceFacts?.find(item => item.factId === row.factRef && contentHashOf(item) === bodyHash);
  if (fact === undefined || row.kind !== `method_${fact.kind}`) return undefined;

  if (fact.kind === "execution") return { role: "associated_execution_not_quality", identity: [fact.versionId, fact.trace.exposureId],
    revision: [fact.factId, fact.trace.exposureId], body };

  if (fact.kind === "decision") return { role: "native_method_decision_not_following_or_quality",
    identity: [fact.versionId, fact.decision.scopeId, fact.factId], revision: fact.factId, body };

  if (fact.kind === "restriction" || fact.kind === "scope_retired" || fact.kind === "compilation_exit" || fact.kind === "exit") {
    return { role: fact.kind === "restriction" ? "native_applicability_restriction_not_quality" : "native_withdrawal_not_quality",
      identity: [fact.kind, fact.versionId, fact.scopeId ?? null, fact.factId], revision: fact.factId, body };
  }

  // A research card, scope hypothesis or review is not a business observation.
  return undefined;
}

function methodUnit(row: JsonObject, board: BoardState): Unit | undefined {
  const body = payload(row);
  if (body === undefined || !ref(row.factRef) || !ref(row.revisionRef)) return undefined;

  const business = methodBusinessUnit(row, body, board);
  if (business !== undefined) return business;

  if (row.kind !== "method_assessment" || !isMethodObservation(body) || row.factRef !== body.observationId || !sequence(body.revision)
    || row.revision !== body.revision || ![body.versionId, body.taskId, body.opportunityId, body.source].every(ref)) return undefined;

  const originals = board.feedbacks.filter(item => item.observation?.observationId === body.observationId
    && contentHashOf(item.observation) === contentHashOf(body));
  if (originals.length === 0) return undefined;

  const exposures = [...new Set(originals.flatMap(item => item.exposureId === undefined ? [] : [item.exposureId]))];
  if (row.exposureId !== undefined && (exposures.length !== 1 || row.exposureId !== exposures[0])) return undefined;

  // Projection locators may acquire a clearer alias without changing the
  // original observation. Its writer relation, not the wrapper, binds exposure.
  return { role: "task_assessment_revision_not_new_trial",
    identity: [body.versionId!, body.taskId!, body.opportunityId!, body.source!],
    revision: [body.observationId, body.revision, exposures.length === 1 ? exposures[0]! : null], body };
}

function toolUnit(row: JsonObject): Unit | undefined {
  const body = payload(row);
  if (body === undefined || !ref(row.factRef) || !ref(row.revisionRef)) return undefined;

  // A transparent wrapper reference is navigation. Native IDs and the exact
  // original body below determine whether an actually read fact was revised.
  if (row.kind === "tool_invocation" && row.factRef === body.useId && ref(body.versionId)) {
    return { role: "execution_return_not_quality", identity: [body.useId!, body.versionId], revision: body.useId!, body };
  }

  if (row.kind === "tool_task_assessment" && [body.feedbackId, body.versionId, body.taskId, body.source].every(ref) && ids(body.useIds)) {
    return { role: "one_task_assessment_over_all_bound_calls", identity: [body.feedbackId!, body.versionId!, body.taskId!, body.useIds, body.source!],
      revision: body.feedbackId!, body };
  }

  if (row.kind === "tool_contract_review" && body.approved === true && ref(body.revisionId) && object(body.proposal)) {
    return { role: "contract_correction_approval_not_task_use", identity: body.revisionId, revision: body.revisionId, body };
  }

  if (row.kind === "tool_approval" && row.factRef === body.approvalId && ["approved", "rejected"].includes(String(body.status))) {
    return { role: "permission_decision_not_task_use", identity: body.approvalId!, revision: [body.approvalId!, body.status!], body };
  }

  return undefined;
}

function workflowUnit(row: JsonObject): Unit | undefined {
  if (!ref(row.recordRef) || !ref(row.useId) || !ref(row.versionId)) return undefined;

  if (row.kind === "workflow_frozen_use" && ref(row.sessionId) && sequence(row.afterSequence) && ref(row.taskRef)) {
    return { role: "frozen_selection_not_following", identity: [row.useId, row.versionId], revision: row.recordRef,
      body: { useId: row.useId, versionId: row.versionId, boundary: row.boundary ?? null,
        sessionId: row.sessionId, afterSequence: row.afterSequence, taskRef: row.taskRef, conditionKey: row.conditionKey ?? null } };
  }

  if (row.kind !== "workflow_feedback" || !ref(row.feedbackId) || !ref(row.executionId) || !ids(row.evidenceRefs)) return undefined;

  const { interpretation: _interpretation, ...body } = row;

  return { role: object(row.userAssessment) && ref(row.userAssessment.evidenceRef)
    ? "task_feedback_with_explicit_user_assessment_not_causal_gain" : "task_feedback_with_original_claim_and_checker_roles",
  identity: [row.versionId, row.useId, row.feedbackId], revision: [row.recordRef,
    object(row.userAssessment) ? row.userAssessment.evidenceRef ?? null : null], body };
}

function receiptUnit(row: JsonObject, owner: string): Unit | undefined {
  if (owner === "collaboration" && ref(row.receiptId) && ids(row.versionIds)
    && (row.kind === "collaboration_dispatched" || row.kind === "collaboration_use_feedback" && ref(row.usageReceiptId))) {
    const { relevantVersionIds: _selectedProjection, interpretation: _interpretation, ...body } = row;
    return { role: row.kind === "collaboration_dispatched" ? "request_exposure_not_behavioral_success" : "pa_attributed_use_claim_not_independent_verdict",
      identity: [row.receiptId, row.kind === "collaboration_use_feedback" ? row.usageReceiptId! : null], revision: row.receiptId, body };
  }

  if (owner === "skill" && ref(row.sourceRef) && [row.issueId, row.grantId, row.jobId, row.pendingRef, row.name].every(ref)
    && (row.kind === "native_approved" || row.kind === "instruction_loaded" && ref(row.approvalRef)
      && ref(row.sessionId) && ref(row.turnId) && ref(row.toolCallId) && sequence(row.journalSequence))) {
    const { interpretation: _interpretation, sourceRef: _sourceRef, ...body } = row;
    return { role: row.kind === "native_approved" ? "native_permission_fact_not_task_use" : "instruction_load_not_application_quality",
      identity: [row.pendingRef!, row.kind === "native_approved" ? row.payloadHash ?? null
        : [row.approvalRef!, row.sessionId!, row.turnId!, row.toolCallId!, row.journalSequence!]], revision: row.sourceRef, body };
  }

  return undefined;
}

function originalUnit(row: JsonObject, owner: string, board: BoardState): Unit | undefined {
  return owner === "method" ? methodUnit(row, board) : owner === "tool" ? toolUnit(row)
    : owner === "workflow" ? workflowUnit(row) : receiptUnit(row, owner);
}

function signature(scope: string, owner: string, unit: Unit): string {
  return contentHashOf({ schemaVersion: 1, scope, owner, role: unit.role,
    originalUnit: unit.identity, originalRevision: unit.revision, originalBodyHash: contentHashOf(unit.body) });
}

function publicUnitView(body: string): NativeFeedbackUnitPublicView | undefined {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return undefined; }
  return isNativeFeedbackUnitPublicView(value) && canonicalJson(value) === body ? value : undefined;
}

/** These are the old public row presentations of the same fixed native payload,
 * used only after the original public archive authenticates the complete view. */
function archivedTypedUnit(view: NativeFeedbackUnitPublicView, owner: string, board: BoardState): Unit | undefined {
  const row = nativeFeedbackUnitCanonicalRow(view, owner);
  return row === undefined ? undefined : originalUnit(row, owner, board);
}

function publicViewUnit(view: NativeFeedbackUnitPublicView, owner: string, board: BoardState,
  currentRows: readonly JsonObject[]): Unit | undefined {
  if (/(?:^|_)(?:research|proposal)(?:_|$)/.test(view.recordKind)) return undefined;

  const exactRows = currentRows.filter(row => row.factRef === view.factRef && row.unitRef === view.unitRef && row.revisionRef === view.revisionRef
    && contentHashOf(payload(row) ?? row.original ?? null) === contentHashOf(view.payload));

  for (const row of exactRows) {
    const unit = originalUnit(row, owner, board);
    if (unit !== undefined) return unit;
  }

  const typed = archivedTypedUnit(view, owner, board);
  if (typed !== undefined) return typed;

  return { role: `native_${view.changeKind}_source_not_quality_trial_or_gain`,
    identity: [view.domain, view.changeKind, view.factRef, view.unitRef], revision: view.revisionRef, body: view.payload };
}

function dependencyUnit(value: unknown, board: BoardState, scope: string, issueId: string): Unit | undefined {
  if (!isLearningDependency(value) || !object(value) || value.issueId !== issueId || value.state.kind === "waiting" || value.state.kind === "unavailable") return undefined;

  const current = board.learningDependencies?.find(row => row.dependencyId === value.dependencyId);
  if (current === undefined || current.issueId !== value.issueId || current.grantId !== value.grantId || current.jobId !== value.jobId
    || current.owner !== value.owner || current.correlationRef !== value.correlationRef || current.revision < value.revision
    || current.revision === value.revision && contentHashOf(current) !== contentHashOf(value)) return undefined;

  const grant = board.centralLearningGrants?.find(row => row.grantId === value.grantId && row.issueId === value.issueId && row.scope === scope && row.jobId === value.jobId);
  const job = board.jobs.find(row => row.jobId === value.jobId && row.scope === scope && row.coordination?.issueId === value.issueId && row.coordination.grantId === value.grantId);
  if (grant === undefined || job === undefined) return undefined;

  return { role: "native_dependency_state_not_execution_quality_or_gain",
    identity: [value.dependencyId, value.issueId, value.grantId, value.jobId, value.owner, value.correlationRef], revision: value.revision,
    body: value };
}

function methodAssessmentScope(row: JsonObject): string | undefined {
  const body = row.kind === "method_assessment" ? payload(row) : undefined;
  return body === undefined ? undefined : contentHashOf([body.versionId, body.taskId, body.opportunityId,
    body.source, body.scopeId, body.compilationId ?? null]);
}

/** Original unit/revision deduplication only. Whole-frame freshness, research
 * progress, model proposals, basis hashes and sample/quality counts are absent. */
export async function centralResearchReadNativeEvidenceSignatures(input: {
  readonly board: BoardState; readonly scope: string; readonly issueId: string;
  readonly compatibleScopes?: readonly string[];
  readonly readCompatibleScopes?: () => readonly string[];
  readonly materials: readonly CentralRuntimeMaterial[]; readonly readOwnerFeedback: ContentDomainFeedbackReader;
}, signal: AbortSignal): Promise<readonly string[]> {
  if (signal.aborted) return [];

  const compatibleScopes = [...(input.readCompatibleScopes === undefined ? input.compatibleScopes ?? [] : input.readCompatibleScopes())];
  const readableScopes = new Set([input.scope, ...compatibleScopes]);
  const sourceReads = input.materials.flatMap(material => {
    const read = fragment(material, input.scope, input.board, compatibleScopes);
    return read === undefined ? [] : [{ material, read }];
  });
  const authenticatedHistory = sourceReads.some(({ read }) => read.locatorIssue === input.issueId && read.originalRef.startsWith(PUBLIC_SOURCE_BODY_PREFIX));
  const issue = input.board.learningIssues?.find(row => row.issueId === input.issueId && (readableScopes.has(row.scope) || authenticatedHistory));
  if (issue === undefined) return [];

  const owner = learningIssueOwner(issue);
  if (owner === "ambiguous") return [];

  // Primary archives are already observed history. A current alias proof alone
  // permits a fresh owner read; historical bytes do not regrant that authority.
  const current = readableScopes.has(issue.scope) ? await input.readOwnerFeedback(input.board, issue.issueId) : undefined;

  if (signal.aborted) return [];

  const frame = isContentDomainFeedback(current) ? current : undefined;
  const reads = sourceReads.flatMap(({ material, read }) => {
    if (read.locatorIssue !== undefined && read.locatorIssue !== issue.issueId) return [];

    // Plain legacy data needs a complete authentic frame. A partial read must
    // carry either the canonical source-page or legacy-fragment host wrapper.
    if (issueFromLocator(material.ref) !== undefined) {
      const candidate = frame === undefined ? undefined : completeOwnerFrame(read.text, frame.sourceRef);
      if (candidate === undefined ? publicUnitView(read.text) === undefined : !material.sourceRefs.includes(candidate.sourceRef)) return [];
    } else if (!material.ref.startsWith("central-runtime-fragment:")
      && read.locatorIssue === undefined && (frame === undefined || !sameOwnerFrameRef(read.originalRef, frame.sourceRef))) return [];

    return [read];
  });
  const assembled = contiguousReads(reads), readBodies = assembled.map(read => read.text), observedUnits = new Set<string>(), signatures = new Set<string>();

  for (const read of assembled) {
    const archived = readRuntimePublicSourceFrame(input.board, { scope: input.scope, ref: read.originalRef, compatibleScopes });
    if (archived === undefined) continue;

    if (archived.origin.kind === "owner_frame") {
      for (const row of completeOwnerFrame(read.text)?.records ?? completeReadRows(read.text)) {
        const unit = originalUnit(row, owner, input.board);
        if (unit !== undefined) signatures.add(signature(input.scope, owner, unit));
      }
      continue;
    }

    if (read.start !== 0 || read.end !== read.totalChars || archived.text !== read.text || archived.publicTextHash !== contentHashOf(read.text)) continue;

    if (archived.origin.kind === "native_dependency") {
      let body: unknown;
      try { body = JSON.parse(read.text); } catch { continue; }
      if (!fields(body, ["role", "value"]) || body.role !== "original_native_dependency_fact_not_verification" || canonicalJson(body) !== read.text) continue;
      const unit = dependencyUnit(body.value, input.board, issue.scope, issue.issueId);
      if (unit !== undefined) signatures.add(signature(input.scope, owner, unit));
      continue;
    }

    const view = publicUnitView(read.text);
    if (archived.origin.kind !== "native_unit" || view === undefined || view.issueId !== issue.issueId
      || view.domain !== (owner === "method" ? "prompt" : owner)) continue;

    const unit = publicViewUnit(view, owner, input.board, frame?.records ?? []);
    if (unit !== undefined) signatures.add(signature(input.scope, owner, unit));
  }

  const methodHeads = new Set(frame?.records.map(methodAssessmentScope).filter(value => value !== undefined) ?? []);

  for (const body of readBodies) for (const row of (frame === undefined ? undefined : completeOwnerFrame(body, frame.sourceRef))?.records ?? completeReadRows(body)) {
    const unit = originalUnit(row, owner, input.board);
    if (unit === undefined) continue;

    const observed = signature(input.scope, owner, unit);
    observedUnits.add(observed);
    // Canonical method heads replace old assessments. The old actual read must
    // remain stable while a newer correction is still unread. methodUnit has
    // joined this exact old payload/revision to the original Board feedback.
    const originalScope = methodAssessmentScope(row);
    if (owner === "method" && originalScope !== undefined && methodHeads.has(originalScope)) signatures.add(observed);
  }

  for (const row of frame?.records ?? []) {
    const unit = originalUnit(row, owner, input.board);
    if (unit === undefined) continue;
    const unitSignature = signature(input.scope, owner, unit);
    if (observedUnits.has(unitSignature) || readBodies.some(body => body.includes(canonicalJson(row)))) signatures.add(unitSignature);
  }

  return [...signatures].sort();
}
