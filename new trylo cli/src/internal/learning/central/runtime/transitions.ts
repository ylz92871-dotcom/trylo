import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { centralOperationSignature, type CentralRuntimeHistory } from "./records.js";
import { deliveredArchivedIntents, identifyDeliveredArchivedIntentClaims } from "./archived-intents.js";
import { isCentralUnreadNavigationMaterial } from "./material-role.js";
import { isCentralGenerationLimits, isCentralThinkMaxOutputTokens } from "./generation.js";
import { centralJudgmentControlRefs } from "./judgment.js";
import { CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON, type CentralCitationRejection } from "./citation-rejection.js";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial, CentralRuntimeWork, CentralRuntimeWorkResult } from "./contracts.js";

export function operationCompleted(state: CentralLearningRuntimeState, operation: CentralLearningOperation, history?: CentralRuntimeHistory): boolean {
  const signature = centralOperationSignature(operation);
  return [...state.completed, ...state.running].some(row => row.operation.operationId === operation.operationId
    || centralOperationSignature(row.operation) === signature)
    || history?.operations.some(row => row.operationId === operation.operationId || row.signature === signature) === true;
}

export function mergeRuntimeMaterials(...groups: readonly (readonly CentralRuntimeMaterial[])[]): readonly CentralRuntimeMaterial[] {
  const merged = new Map<string, CentralRuntimeMaterial>();

  for (const material of groups.flat()) {
    const previous = merged.get(material.ref);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(material)) throw new Error("central_material_identity_conflict");
    merged.set(material.ref, material);
  }

  return [...merged.values()];
}

/** Semantic decoding identifies delivered original purposes without inventing
 * writer history. Final authorization remains the history-bearing entrypoint. */
export function validateAgendaTransitionBeforeHistory(request: CentralDeliberationRequest, output: CentralDeliberationOutput): string | null {
  return inspectAgendaTransitionBeforeHistory(request, output)?.reason ?? null;
}

export interface CentralAgendaTransitionRejection {
  readonly reason: string;
  readonly citationRejection?: CentralCitationRejection;
}

function describeAgendaRejection(rejection: string | CentralCitationRejection | null): CentralAgendaTransitionRejection | null {
  return rejection === null ? null : typeof rejection === "string" ? { reason: rejection }
    : { reason: CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON, citationRejection: rejection };
}

/** The original validation branch supplies one bounded diagnostic; no second
 * citation scan or source text is needed to explain a definite rejection. */
export function inspectAgendaTransitionBeforeHistory(request: CentralDeliberationRequest,
  output: CentralDeliberationOutput): CentralAgendaTransitionRejection | null {
  const originals = new Map([...identifyDeliveredArchivedIntentClaims(request)].map(([id, claim]) => [id, claim.intent]));
  return describeAgendaRejection(validateAgendaWithArchives(request, output, originals));
}

/** Identity/source guards do not assign semantic progress scores. The writer
 * supplies its verified current history before any agenda may be committed. */
export function validateAgendaTransition(request: CentralDeliberationRequest, output: CentralDeliberationOutput, history?: CentralRuntimeHistory): string | null {
  return describeAgendaRejection(validateAgendaWithArchives(request, output, deliveredArchivedIntents(request, history), history))?.reason ?? null;
}

function validateAgendaWithArchives(request: CentralDeliberationRequest, output: CentralDeliberationOutput,
  archived: ReadonlyMap<string, CentralLearningIntentDraft>, history?: CentralRuntimeHistory): string | CentralCitationRejection | null {
  const old = request.state.intents;
  // A strict new judgment view activates only its bound control identities.
  // Historical requests without that view retain their original validation.
  const judgmentRefs = centralJudgmentControlRefs([...request.materials, ...request.organization, ...request.state.materials]);

  if (old.some(intent => !output.intents.some(next => next.intentId === intent.intentId))) return "central_intent_removed_without_history";

  // The renderer gives these exact public identities typed reference handles.
  // Binding must recognize them regardless of which delivered collection owns
  // the body. Recognition is not a quotation, business fact or replay permit;
  // the independent grounding, PA and completed-operation gates remain below.
  const operationRefs = (operation: CentralLearningOperation) => [operation.operationId, ...operation.sourceRefs,
    ...(operation.kind === "read" ? operation.refs : [])];
  const subjectRefs = (subject: CentralLearningIntentDraft["subject"]) => subject.plane === "agent" ? [subject.issueId]
    : subject.plane === "user" ? [subject.ledgerRef, subject.questionRef] : [subject.questionRef];
  const intentRefs = (row: CentralLearningIntentDraft) => [row.intentId, ...subjectRefs(row.subject), ...row.sourceRefs,
    ...row.knowledge.flatMap(knowledge => knowledge.sourceRefs), ...(row.derivation?.parentRefs ?? []),
    ...(row.derivation?.citations.map(citation => citation.evidenceRef) ?? []),
    ...(row.continuation.kind === "ready" ? operationRefs(row.continuation.operation)
      : row.continuation.kind === "waiting" ? row.continuation.wait.sourceRefs : [])];
  const visible = new Set([request.scope, request.stateRef, request.budgetId,
    request.configuration.configurationRef, request.configuration.authorizationRef, ...operationRefs(request.operation),
    ...request.opportunities.flatMap(row => [row.sourceRef, ...subjectRefs(row.subject)]),
    ...[...request.materials, ...request.organization, ...request.state.materials].flatMap(row => [row.ref, ...row.sourceRefs]),
    ...old.flatMap(intentRefs), ...(request.state.agendaRead === undefined ? [] : operationRefs(request.state.agendaRead)),
    ...request.state.running.flatMap(row => [row.intentId, row.workRef, ...operationRefs(row.operation)]),
    ...request.state.completed.flatMap(row => [row.intentId, ...operationRefs(row.operation), ...row.resultRefs,
      ...(row.wait?.sourceRefs ?? [])]), ...[...archived.values()].flatMap(intentRefs)]);
  if (output.sourceRefs.some(ref => !visible.has(ref))) return "central_deliberation_source_unknown";

  const pendingRead = request.state.agendaRead, agendaRead = output.agendaRead;
  if (agendaRead !== undefined) {
    const samePending = pendingRead !== undefined && canonicalJson(pendingRead) === canonicalJson(agendaRead);
    if (pendingRead !== undefined && !samePending) return "central_pending_agenda_read_changed";
    if (agendaRead.sourceRefs.some(ref => !visible.has(ref))) return "central_deliberation_source_unknown";
    // History retains this pending identity; preserving it does not issue it again.
    if (agendaRead.operationId === request.operation.operationId || !samePending && operationCompleted(request.state, agendaRead, history)) return "central_operation_already_issued";
  }

  const selectedRead = agendaRead ?? pendingRead;
  if (selectedRead !== undefined && output.intents.some(intent => intent.continuation.kind === "ready"
    && intent.continuation.operation.operationId === selectedRead.operationId)) return "central_pending_operation_identity_changed";

  for (const [intentIndex, next] of output.intents.entries()) {
    const head = history?.purposeHeads?.find(row => row.intentId === next.intentId && row.scope === request.scope);
    if (head?.kind === "ended" && head.goalState === "withdrawn"
      && (next.continuation.kind !== "ended" || next.continuation.goalState !== "withdrawn")) return "central_withdrawn_intent_requires_new_authorized_purpose";

    const prior = old.find(row => row.intentId === next.intentId) ?? archived.get(next.intentId);

    // A stale delivered checkpoint/receipt cannot override the latest original
    // head. Reading an older body remains legal; resuming it needs fresh authority.
    if (prior?.continuation.kind === "ended" && history !== undefined
      && (head === undefined || head.intentHash !== contentHashOf(prior))) return "central_archived_intent_original_read_required";

    if (prior === undefined && history?.endedIntents.some(row => row.intentId === next.intentId)) return "central_archived_intent_original_read_required";

    const subject = canonicalJson(next.subject);
    if (prior !== undefined && canonicalJson(prior.subject) !== subject) return "central_intent_subject_changed";

    if (judgmentRefs.size > 0) {
      const retainedKnowledge = new Set(prior?.knowledge.map(row => canonicalJson(row)) ?? []);
      if (next.knowledge.some(row => !retainedKnowledge.has(canonicalJson(row))
        && row.sourceRefs.some(ref => judgmentRefs.has(ref)))) return "central_judgment_context_not_business_grounding";
    }

    if (prior?.continuation.kind === "ready" && next.continuation.kind === "ready"
      && prior.continuation.operation.operationId === next.continuation.operation.operationId
      && canonicalJson(prior.continuation.operation) !== canonicalJson(next.continuation.operation)) return "central_pending_operation_identity_changed";

    if (next.continuation.kind === "ready" && next.continuation.operation.kind === "think"
      && Object.hasOwn(next.continuation.operation, "maxOutputTokens")
      && !(prior?.continuation.kind === "ready" && canonicalJson(prior.continuation.operation) === canonicalJson(next.continuation.operation))) {
      const selected = next.continuation.operation.maxOutputTokens, limits = request.configuration.generationLimits;
      if (!isCentralThinkMaxOutputTokens(selected) || !isCentralGenerationLimits(limits)
        || selected > limits.maxOutputTokens) return "central_think_generation_unavailable";
    }

    const groundingChanged = next.subject.plane === "central" && (prior === undefined || next.derivation !== undefined
      && (prior.derivation === undefined || canonicalJson(next.derivation) !== canonicalJson(prior.derivation)));
    if (groundingChanged && next.subject.plane === "central") {
      if (next.subject.questionRef !== next.intentId || next.derivation === undefined
        || next.derivation.parentRefs.length === 0 || next.derivation.citations.length === 0) return "central_derived_intent_grounding_required";

      const retainedParents = new Set(prior?.derivation?.parentRefs ?? []);
      if (next.derivation.parentRefs.some(ref => judgmentRefs.has(ref) && !retainedParents.has(ref))) {
        return "central_judgment_context_not_business_grounding";
      }

      if (next.derivation.parentRefs.some(ref => !visible.has(ref))) return "central_derived_intent_parent_unknown";

      for (const [citationIndex, citation] of next.derivation.citations.entries()) {
        // Retaining an already validated original quotation does not force a
        // second delivery. A newly supplied quotation requires an actual body.
        if (prior?.derivation?.citations.some(row => canonicalJson(row) === canonicalJson(citation))) continue;

        if (judgmentRefs.has(citation.evidenceRef)) return "central_judgment_context_not_business_grounding";

        const material = [...request.materials, ...request.state.materials, ...request.organization].find(row => row.ref === citation.evidenceRef);
        let cause: CentralCitationRejection["cause"] | undefined;

        if (material === undefined) cause = "material_not_supplied";
        else if (isCentralUnreadNavigationMaterial(material)) cause = "body_unread";
        else if (citation.quote.trim().length === 0) cause = "quote_empty";
        else if (material.text.indexOf(citation.quote) < 0) cause = "quote_not_found";
        else if (material.text.indexOf(citation.quote) !== material.text.lastIndexOf(citation.quote)) cause = "quote_not_unique";
        else if (!next.derivation.parentRefs.includes(citation.evidenceRef)) cause = "evidence_not_parent";

        if (cause !== undefined) return { schemaVersion: 1, slot: "intent_derivation_citation", intentIndex, citationIndex, cause };
      }

      visible.add(next.intentId);
    } else if (prior === undefined && !request.opportunities.some(row => canonicalJson(row.subject) === subject)) return "central_intent_subject_unavailable";

    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(next) && !next.revisionReason.trim()) return "central_intent_revision_reason_required";

    if (prior?.continuation.kind === "ended" && prior.continuation.goalState === "withdrawn"
      && (next.continuation.kind !== "ended" || next.continuation.goalState !== "withdrawn")) return "central_withdrawn_intent_requires_new_authorized_purpose";

    const refs = [...next.sourceRefs, ...next.knowledge.flatMap(row => row.sourceRefs),
      ...(next.continuation.kind === "ready" ? next.continuation.operation.sourceRefs
        : next.continuation.kind === "waiting" ? next.continuation.wait.sourceRefs : [])];
    if (refs.some(ref => !visible.has(ref))) return "central_intent_source_unknown";

    if (next.subject.plane === "central" && next.continuation.kind === "ready" && next.continuation.operation.kind === "dispatch"
      && next.continuation.operation.destination === undefined) return "central_research_destination_required";

    if (next.continuation.kind === "ready" && operationCompleted(request.state, next.continuation.operation, history)) return "central_operation_already_issued";
  }

  return null;
}

export function waitingIntent(intent: CentralLearningIntentDraft, reason: string, refs: readonly string[]): CentralLearningIntentDraft {
  return { ...intent, continuation: { kind: "waiting", wait: { kind: "facts", reason, sourceRefs: refs } } };
}

export function replaceIntent(state: CentralLearningRuntimeState, intent: CentralLearningIntentDraft): CentralLearningRuntimeState {
  return { ...state, intents: state.intents.map(row => row.intentId === intent.intentId ? intent : row) };
}

/** A concrete returned computation creates an interpretation opportunity. Writing a note does not. */
export function interpretOperation(intent: CentralLearningIntentDraft, operation: CentralLearningOperation,
  resultRefs: readonly string[]): CentralLearningIntentDraft {
  return { ...intent, continuation: { kind: "ready", operation: {
    kind: "think", operationId: `central-interpret:${contentHashOf([operation.operationId, resultRefs])}`,
    purpose: `解释已返回操作对原目的“${intent.goal}”及原残余的影响`,
    expectedChange: `比较实际公开结果与原预期“${operation.expectedChange}”，决定继续原承诺、修订手段或等待；不将阶段完成当目标完成。`,
    sourceRefs: resultRefs } } };
}

export interface CentralOperationResultInput {
  readonly intentId: string; readonly operation: CentralLearningOperation; readonly result: CentralRuntimeWorkResult;
  readonly workRef?: string;
}

/** Record the original result without choosing a purpose's next commitment. */
export function recordOperationResult(state: CentralLearningRuntimeState, input: CentralOperationResultInput): {
  readonly state: CentralLearningRuntimeState; readonly resultRef: string;
} {
  const completed: CentralCompletedOperation = { intentId: input.intentId, operation: input.operation,
    ...input.result };
  const ref = `central-operation-result:${contentHashOf(completed)}`;
  const material: CentralRuntimeMaterial = { ref, kind: "work_result", text: input.result.publicResult,
    sourceRefs: input.result.resultRefs };

  return { resultRef: ref, state: { ...state,
    completed: [...state.completed.filter(row => row.operation.operationId !== input.operation.operationId), completed],
    running: state.running.filter(row => row.operation.operationId !== input.operation.operationId),
    materials: [...state.materials.filter(row => row.ref !== ref), material] } };
}

export function completeOperation(state: CentralLearningRuntimeState, input: CentralOperationResultInput): CentralLearningRuntimeState {
  const recorded = recordOperationResult(state, input);
  const intent = state.intents.find(row => row.intentId === input.intentId);
  const current = intent?.continuation;
  const stillAwaited = current?.kind === "ready" ? current.operation.operationId === input.operation.operationId
    : current?.kind === "waiting" && current.wait.sourceRefs.some(ref => ref === input.operation.operationId || ref === input.workRef);

  return { ...recorded.state,
    intents: intent === undefined || !stillAwaited ? state.intents : state.intents.map(row => row.intentId === intent.intentId
      ? input.result.wait === undefined ? interpretOperation(row, input.operation, [recorded.resultRef, ...input.result.resultRefs])
        : { ...row, continuation: { kind: "waiting" as const, wait: input.result.wait } } : row) };
}

export function startWork(state: CentralLearningRuntimeState, work: CentralRuntimeWork): CentralLearningRuntimeState {
  const intent = state.intents.find(row => row.intentId === work.intentId);
  if (intent === undefined) throw new Error("central_work_intent_missing");
  return { ...replaceIntent(state, waitingIntent(intent, "central_domain_work_running", [work.workRef])),
    running: [...state.running, work] };
}
