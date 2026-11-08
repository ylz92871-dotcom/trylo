import { createCentralRuntimeStore } from "./runtime-store.js";
import { centralOperationSignature, type CentralOpportunityConsideration, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CentralRuntimeCheckpointBusyError, CentralRuntimeHeadChangedError, isCentralRuntimeCheckpointContention, saveCentralRuntimeCheckpoint } from "./runtime-checkpoint.js";
import { archiveCentralRuntimeMaterials } from "./runtime-archive.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isCentralCompletedOperation, isCentralDeliberationOutput, isCentralRuntimeMaterial, isCentralLearningRuntimeState } from "../../learning/central/runtime/validation.js";
import { completeOperation, mergeRuntimeMaterials, operationCompleted, replaceIntent, startWork, validateAgendaTransition, validateAgendaTransitionBeforeHistory,
  recordOperationResult } from "../../learning/central/runtime/transitions.js";
import type { CentralDeliberationDeliveryConstraints, CentralDeliberationPort, CentralDeliberationRequest, CentralLearningDriveInput, CentralLearningDriver,
  CentralLearningDriverProgress, CentralLearningIntentDraft, CentralLearningOperation, CentralLearningRuntimeState,
  CentralRuntimeExecutionPort, CentralRuntimeOrganizationPort, CentralRuntimeSnapshot, CentralRuntimeSourcePort,
  CentralRuntimeMaterial, CentralRuntimeWork, CentralRuntimeWorkResult } from "../../learning/central/runtime/contracts.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { blocksAutomaticSemanticRecovery, semanticAttemptMaterial, semanticRecovery, semanticRecoveryAt,
  semanticRecoveryBlock, unresolvedSemanticAttempts } from "./runtime-recovery.js";
import { semanticResourceCondition } from "./runtime-recovery.js";
import { isProviderRecoveryAttempt } from "./runtime-provider-recovery.js";
import { compactCentralWorkingSet } from "../../learning/central/runtime/working-set.js";
import { CentralRuntimeBlocked } from "../../learning/central/runtime/errors.js";
import { centralDeliveredSourceRefs, hasUnlistedCentralMaterial } from "./deliberation-context.js";
import { CentralDeliberationError, isCentralDeliberationInputCapacity } from "./deliberation-contract.js";
import { isCompleteCentralOutputCapacityRejection } from "./deliberation-output-diagnostics.js";
import { recoverCentralOutputCapacityFailures } from "./runtime-output-capacity-recovery.js";
import { readCentralActionRejection } from "./runtime-action-rejection.js";
import { centralActionCorrection } from "./runtime-action-correction.js";
import { isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";
import { admissionRetirementFor, confirmsOriginalAdmission, semanticAdmissionMaterial, semanticAdmissionRef, unadmittedSemanticAttempt } from "./runtime-admission.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { OrganizationCasBusyError } from "./organization-cas.js";
import { deliveredPublicationConditions, deliveredSourcesWithPublicationConditions, isPublicationConditionRef, publicationCorrectionFor } from "./runtime-publication-correction.js";
import { isConsideredCentralIssueNotice } from "./runtime-source-issue-refs.js";
import { readOperationRefusal } from "./runtime-read-operation.js";
import { recallCentralComparisonContext } from "./runtime-comparison-context.js";
import { isPendingCentralAgendaRead, nextCentralAgendaOperation, performCentralAgendaRead } from "./runtime-agenda-read.js";
import { isActionableCentralChangeStructureRejection } from "./change-structure-rejection.js";
import { latestProviderWait, providerWaitForPositiveObservation, readProviderPositiveAdmissionMaterial,
  providerPositiveAdmissionMaterial, selectProviderPositiveAdmission } from "./runtime-provider-positive.js";
import type { ProviderPositiveAdmission, ProviderRecoveryUpdate } from "../../learning/central/runtime/provider-positive.js";
import { isCentralUnconfirmedThoughtWait, openCentralReturnedThought } from "./runtime-open-continuation.js";
import { readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { centralJudgmentResultMaterial, readCentralJudgmentProjection } from "./runtime-judgment.js";
import { CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON } from "../../learning/central/runtime/citation-rejection.js";
import { authenticatedCentralOutputCapacityIncrease, isCentralOutputCapacityIncreaseOperation, readCentralOutputCapacityIncrease,
  type CentralOutputCapacityIncreaseAdmission } from "./runtime-output-capacity-increase.js";
import type { CentralRuntimeAdvisoryPort } from "./central-advisory-port.js";

export interface CentralLearningDriverOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly enabled: () => boolean;
  readonly now: () => string;
  readonly source: CentralRuntimeSourcePort;
  readonly deliberation: CentralDeliberationPort;
  readonly execution: CentralRuntimeExecutionPort;
  readonly organization?: CentralRuntimeOrganizationPort;
  readonly advisories?: CentralRuntimeAdvisoryPort;
  /** A bounded communication recovery, never a learning polling interval. */
  readonly semanticRecoveryDelayMs?: number;
}

type Cursor = Awaited<ReturnType<ReturnType<typeof createCentralRuntimeStore>["read"]>>;

type Selection = { readonly intent: CentralLearningIntentDraft | null; readonly operation: CentralLearningOperation;
  readonly capacityIncrease?: CentralOutputCapacityIncreaseAdmission;
  readonly providerAdmission?: ProviderPositiveAdmission;
  readonly admission?: { readonly operationId: string; readonly blockRef: string } };

class SourceProgressCapacity extends Error {
  constructor(readonly sourceRefs: readonly string[]) { super("central_deliberation_source_progress_capacity"); }
}

const progress = (state: CentralLearningDriverProgress["state"], reason: string, sourceRefs: readonly string[] = []): CentralLearningDriverProgress =>
  ({ state, reason, sourceRefs });

function selectWork(state: CentralLearningRuntimeState, snapshot: CentralRuntimeSnapshot, now: number,
  history?: CentralRuntimeHistory): Selection | null {
  // Prepared/unknown source positions fence fresh agenda creation; they are not
  // read acknowledgements. Only the bounded semantic recovery may revisit them.
  const pending = new Set(history?.pendingSemanticSourceRefs ?? state.completed.filter(row => row.operation.kind === "think" && row.outcome !== "returned")
    .flatMap(row => row.operation.sourceRefs));
  const unseen = (ref: string) => !state.consumedSourceRefs.includes(ref) && !pending.has(ref);
  const considered = new Set(history?.consideredSourceRefs ?? []);
  const knownForChoice = new Map((history?.choiceFrontiers ?? []).filter(frontier => state.intents.some(intent => intent.intentId === frontier.intentId
    && frontier.choiceHash === contentHashOf(intent.continuation))).map(frontier => [frontier.intentId, new Set(frontier.sourceRefs)]));
  const relevant = (snapshot.reconsider ?? []).flatMap(change => {
    const purposes = state.intents.filter(intent => intent.continuation.kind !== "ended" && canonicalJson(intent.subject) === canonicalJson(change.subject));
    const authoritative = change.reason === "PA_current_ordinary_or_resolved_constraint_requires_review";
    const refs = change.sourceRefs.filter(ref => unseen(ref) && (authoritative || !isConsideredCentralIssueNotice(ref, considered) && purposes.some(intent => {
      return !knownForChoice.get(intent.intentId)?.has(ref);
    })));
    return purposes.length === 0 || refs.length === 0 ? [] : [{ ...change, sourceRefs: refs }];
  });

  // Unrelated interpretation chains cannot starve an executable commitment.
  // A source/PA change for that very purpose still gets its original review
  // before dispatch. Preparation, funding and execution keep their own gates.
  const affected = new Set(relevant.map(change => canonicalJson(change.subject)));
  for (const intent of state.intents) {
    if (intent.continuation.kind === "ready" && intent.continuation.operation.kind === "dispatch"
      && !affected.has(canonicalJson(intent.subject))) return { intent, operation: intent.continuation.operation };
  }

  // The original read remains queued while independent native work starts.
  if (state.agendaRead !== undefined) return { intent: null, operation: state.agendaRead };

  if (relevant.length > 0) return { intent: null, operation: { kind: "think",
    operationId: `central-reconsider:${contentHashOf(relevant)}`, purpose: "在交接点重审原目的相关的新目标、前提或反馈，然后决定尚未执行的研究承诺。",
    expectedChange: relevant.map(row => row.reason).join("\n"), sourceRefs: [...new Set(relevant.flatMap(row => row.sourceRefs))] } };

  const agendaOperation = nextCentralAgendaOperation(state, history);

  if (agendaOperation !== undefined) return { intent: null, operation: agendaOperation };

  for (const intent of state.intents) {
    if (intent.continuation.kind === "ready") return { intent, operation: intent.continuation.operation };
  }

  const recovery = semanticRecovery(state, now);

  if (recovery !== null) return { intent: state.intents.find(row => row.intentId === recovery.intentId) ?? null, operation: recovery.operation };

  const newSources = snapshot.sourceRefs.filter(ref => unseen(ref) && !considered.has(ref) && !isConsideredCentralIssueNotice(ref, considered));
  const dueRef = (intent: CentralLearningIntentDraft) => intent.continuation.kind === "waiting" && intent.continuation.wait.kind === "until"
    ? `central-wait-due:${contentHashOf([intent.intentId, intent.continuation.wait.at])}` : "";
  const due = state.intents.filter(intent => intent.continuation.kind === "waiting"
    && intent.continuation.wait.kind === "until" && intent.continuation.wait.at <= now && unseen(dueRef(intent)));

  if ((newSources.length === 0 && due.length === 0) || (snapshot.opportunities.length === 0 && state.intents.length === 0
    && snapshot.materials.length === 0)) return null;

  const sources = [...new Set([...newSources, ...due.flatMap(row => [...row.sourceRefs, dueRef(row)])])];

  return { intent: null, operation: { kind: "think", operationId: `central-agenda:${contentHashOf([state.scope, sources,
    due.map(row => row.intentId), state.completed.map(row => row.operation.operationId)])}`,
    purpose: "从实际工作与已有学习中选择值得投入的问题，形成可迁移的理解、有用能力和更好的学习组织方式，改善未来工作与协作；可延续、修订目的或另开相关问题。",
    expectedChange: due.length === 0 ? "依据当前材料与既有发现评估研究可能改变的未来决策、适用条件和有界调查的辨别价值；保留事实与待检验假设，选择有用的继续、改向、等待或结束。"
      : `原明确等待时点已到：${due.map(row => row.intentId).join(",")}；结合已有学习与未来工作价值重审条件和投入，到时不等于依赖已满足。`,
    sourceRefs: sources } };
}

/** Independent scope controller. The scope owner serializes invocations; the
 * local queue also fences asynchronous worker returns against an active drive. */
export function createCentralLearningDriver(options: CentralLearningDriverOptions): CentralLearningDriver {
  const store = createCentralRuntimeStore(options);
  const active = new Map<string, { readonly promise: Promise<void>; readonly controller: AbortController }>();
  const recoveryDelayMs = options.semanticRecoveryDelayMs ?? 2500;

  if (!Number.isSafeInteger(recoveryDelayMs) || recoveryDelayMs < 1) throw new Error("central_semantic_recovery_delay_invalid");

  let closed = false;
  let organizationBackoffUsed = false;
  let organizationBackoffRevision: number | undefined;
  let organizationBusyDuringDrive = false;
  let terminalError: Error | undefined;
  let tail: Promise<void> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const task = tail.then(action);
    tail = task.then(() => undefined, () => undefined); // Queue cleanup only; callers retain the original rejection.
    return task;
  };
  const save = (cursor: Cursor, state: CentralLearningRuntimeState, reason: string, sourceRefs: readonly string[],
    opportunityConsideration?: CentralOpportunityConsideration, providerRecoveryUpdate?: ProviderRecoveryUpdate) =>
    saveCentralRuntimeCheckpoint(store, cursor, state, reason, sourceRefs, opportunityConsideration, providerRecoveryUpdate);

  // Whole original bodies are durable independently of the hot agenda. A
  // physical append may refresh its revision, never replace a semantic head.
  const archiveOriginals = async (cursor: Cursor, materials: readonly CentralRuntimeMaterial[], operationId: string): Promise<Cursor> => {
    const head = cursor.stateRef;
    const archived = await archiveCentralRuntimeMaterials(store, cursor, materials, "independent");
    if (archived.cursor.stateRef !== head) throw new CentralRuntimeHeadChangedError(head, archived.cursor);
    if (archived.status === "contended") throw new CentralRuntimeCheckpointBusyError("stale_revision");
    if (archived.status === "capacity") throw new SourceProgressCapacity([operationId, archived.materialRef]);
    return archived.cursor;
  };
  const capacityIncrease = (cursor: Cursor, budget: CentralBudgetProjection, input: CentralLearningDriveInput, waitRef?: string) =>
    readCentralOutputCapacityIncrease({ state: cursor.state, history: cursor.history, budget, configuration: input.configuration,
      ...(waitRef === undefined ? {} : { waitRef }), lookupMaterial: async (ref, factRef) => {
        const found = await store.lookup(input.scope, { kind: "material", ref, factRef });
        return found.status === "found" && isCentralRuntimeMaterial(found.value) ? found.value : undefined;
      }, lookupCompleted: async (operationId, factRef) => {
        const found = await store.lookup(input.scope, { kind: "completed", operationId, factRef });
        return found.status === "found" && isCentralCompletedOperation(found.value) ? found.value : undefined;
      } });
  const retireProviderWait = async (cursor: Cursor, operationId: string): Promise<Cursor> => {
    const retired = new Set(cursor.history.retiredProviderWaitRefs ?? []);
    const refs = [...new Set((cursor.history.providerPositiveAdmissions ?? []).filter(row => row.admission.operationId === operationId)
      .map(row => row.admission.waitRef))].filter(ref => !retired.has(ref));
    return refs.length === 0 ? cursor : save(cursor, cursor.state, "central_provider_complete_return_retired_wait", [operationId],
      undefined, { retiredWaitRefs: refs });
  };
  const organizationBusy = (error: OrganizationCasBusyError, sourceRefs: readonly string[]): CentralLearningDriverProgress => {
    organizationBusyDuringDrive = true;
    const waiting = progress("waiting", `central_organization_busy_${error.phase}`, sourceRefs);
    // One existing owner deadline without progress. Only a proved later physical
    // prefix can extend the backoff; this is never new model evidence.
    const observed = error.observedRevision;
    const progressing = observed !== undefined && organizationBackoffRevision !== undefined && observed > organizationBackoffRevision;

    if ((organizationBackoffUsed && !progressing) || closed || !options.enabled()) return waiting;

    organizationBackoffUsed = true;

    if (observed !== undefined) organizationBackoffRevision = observed;

    return { ...waiting, wakeAt: Date.parse(options.now()) + recoveryDelayMs };
  };
  const publicationCorrection = async (cursor: Cursor, input: CentralLearningDriveInput) => {
    if (!cursor.state.intents.some(intent => intent.continuation.kind !== "ended")) return undefined;
    const materials = await options.organization?.readPublicationCorrection?.({ scope: input.scope, state: cursor.state,
      consumedSourceRefs: cursor.history.consumedSourceRefs }, input.signal) ?? [];
    if (!materials.every(isCentralRuntimeMaterial)) throw new Error("central_organization_publication_result_invalid");
    return publicationCorrectionFor(cursor.state, materials, cursor.history.consumedSourceRefs);
  };
  const admissionRetirements = async (cursor: Cursor, operationId: string) => {
    const original = async (ref: string) => {
      const live = cursor.state.materials.find(row => row.ref === ref);
      if (live !== undefined) return live;
      const archived = cursor.history.materials.find(row => row.ref === ref);
      if (archived === undefined) return undefined;
      const found = await store.lookup(cursor.state.scope, { kind: "material", ref, factRef: archived.factRef });
      if (found.status !== "found" || !isCentralRuntimeMaterial(found.value) || found.value.ref !== ref) throw new Error("central_admission_record_missing");
      return found.value;
    };
    const marker = await original(semanticAdmissionRef(operationId));
    if (marker === undefined) return [];

    const blockRef = marker.sourceRefs.at(-1);
    if (blockRef === undefined) throw new Error("central_semantic_admission_corrupt");

    const block = await original(blockRef);
    if (block === undefined) throw new Error("central_admission_record_missing");

    return admissionRetirementFor({ ...cursor.state, materials: [marker, block] }, operationId);
  };

  // Persist domain completion before publishing its organization feedback.
  const returned = async (work: CentralRuntimeWork, result: CentralRuntimeWorkResult, input: CentralLearningDriveInput) => {
    if (closed) return;

    const cursor = await store.read(input.scope);

    if (!cursor.state.running.some(row => row.workRef === work.workRef)) return;

    let state = completeOperation(cursor.state, { intentId: work.intentId, operation: work.operation, result, workRef: work.workRef });

    if (result.wait?.kind === "resources") {
      const current = await ensureCentralLearningBudget({ ...options, allowance: input.configuration.allowance,
        authorizationRef: input.configuration.authorizationRef,
        ...(input.configuration.rootRef === undefined ? {} : { rootRef: input.configuration.rootRef }) });

      if (!current.ok) throw new Error(current.reason);

      const condition = Object.assign(new Error(result.wait.reason), { failureClass: "resources" as const });

      state = { ...state, materials: mergeRuntimeMaterials(state.materials,
        [semanticRecoveryBlock(work.operation.operationId, condition, current.projection, input.configuration.configurationRef)]),
        consumedSourceRefs: [...new Set([...state.consumedSourceRefs, ...result.resultRefs, ...result.wait.sourceRefs])] };
    }

    const saved = await save(cursor, state, "central_domain_work_returned", [...new Set([work.workRef, ...result.resultRefs])]);
    let feedback: readonly CentralRuntimeMaterial[] | void;

    try {
      feedback = await options.organization?.recordResult?.({ scope: input.scope, decisionRef: work.operation.operationId,
        completed: state.completed.find(row => row.operation.operationId === work.operation.operationId)! }, input.signal);
    } catch (error) {
      if (!(error instanceof OrganizationCasBusyError) || !error.definiteUnwritten) throw error;
      // Completion is already durable. Original refresh can repair its feedback
      // gap on a later drive without dispatching this work a second time.
      const waiting = organizationBusy(error, [saved.stateRef, work.workRef]);
      await input.publish(waiting);
      return waiting;
    }

    if (feedback !== undefined && feedback.length > 0) await save(saved, { ...saved.state,
      materials: mergeRuntimeMaterials(saved.state.materials, feedback) }, "central_organization_feedback_available", feedback.map(row => row.ref));

    await input.publish({ ...stateProgress(state, Date.parse(options.now())), reason: "central_domain_work_returned",
      sourceRefs: [saved.stateRef, work.workRef] });
  };
  // A work reference owns one live controller and inherits scope cancellation.
  const launch = (work: CentralRuntimeWork, input: CentralLearningDriveInput) => {
    if (active.has(work.workRef)) return;

    const controller = new AbortController(), abortFromScope = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abortFromScope, { once: true });
    if (input.signal.aborted) abortFromScope();

    const running = options.execution.execute(work, controller.signal).then(
      result => serialize(() => returned(work, result, input)),
      error => serialize(() => returned(work, { outcome: "unknown", resultRefs: [work.workRef],
        publicResult: `原领域调用未确认：${error instanceof Error ? error.message : "central_work_failed"}；不自动重发。` }, input)),
    ).then(() => undefined).finally(() => {
      input.signal.removeEventListener("abort", abortFromScope);
      active.delete(work.workRef);
    });
    // Retain a terminal observer. An unknown Board write stops this controller;
    // publication is diagnostic only and never manufactures a successful result.
    const observed = running.catch(async error => {
      if (isCentralRuntimeCheckpointContention(error)) {
        // The original native result is retained by its owner and this work
        // remains running in the Board. Reconcile that same unit; never execute
        // its research again merely because the central writer was occupied.
        if (!closed) {
          try { await input.publish(progress("ready", "central_work_return_pending_checkpoint", [work.workRef])); }
          catch { /* The canonical running unit still remains available for recovery. */ }
        }
        return;
      }

      terminalError ??= error instanceof Error ? error : new Error("central_work_return_unconfirmed");

      if (!closed) {
        // Ready asks the owner to surface the stored fault on the next drive,
        // before any provider, source or dispatch work. It is not a retry.
        try { await input.publish(progress("ready", "central_work_return_unconfirmed", [work.workRef])); }
        catch {
          // Diagnostic publication must not replace the original terminal
          // failure. Every later drive still throws that same stored error.
        }
      }
    });

    active.set(work.workRef, { promise: observed, controller });
  };

  const applyOutput = async (cursor: Cursor, request: CentralDeliberationRequest,
    output: Awaited<ReturnType<CentralDeliberationPort["deliberate"]>>, input: CentralLearningDriveInput,
    delivery: { readonly ref?: string; readonly legacyNotices?: readonly string[]; readonly retiredWaitRef?: string;
      readonly wireEvidence?: unknown } = {}) => {
    const deliveryRef = delivery.ref, legacyNotices = delivery.legacyNotices ?? [];

    if (!isCentralDeliberationOutput(output)) throw new Error("central_deliberation_output_invalid");

    const invalid = validateAgendaTransition(request, output, cursor.history);
    if (invalid !== null) throw new Error(invalid);

    const resultRef = `central-deliberation-result:${contentHashOf(output)}`;
    const completed = { intentId: request.state.completed.find(row => row.operation.operationId === request.operation.operationId)?.intentId ?? "central:agenda",
      operation: request.operation, outcome: "returned" as const, resultRefs: [resultRef], publicResult: output.publicExplanation };
    // Keep the original result body/address for exact reads and compatibility.
    // Only the new authenticated control view assigns its current evidence role.
    const resultMaterial: CentralRuntimeMaterial = { ref: resultRef, kind: "knowledge", text: output.publicExplanation, sourceRefs: output.sourceRefs };
    const judgment = centralJudgmentResultMaterial({ scope: request.scope, operationId: request.operation.operationId,
      resultRef, original: resultMaterial });
    const opportunityConsideration: CentralOpportunityConsideration | undefined = deliveryRef === undefined ? undefined
      : { operationId: request.operation.operationId, deliveryRef, resultRef,
        sourceRefs: [...new Set(request.opportunities.map(opportunity => opportunity.sourceRef))] };
    const delivered = [...new Set([...deliveredSourcesWithPublicationConditions(request), ...legacyNotices.filter(ref => !isPublicationConditionRef(ref))])];
    const fresh = delivered.filter(ref => !cursor.history.consumedSourceRefs.includes(ref));

    if (fresh.length > CENTRAL_RUNTIME_LIMITS.references) throw new SourceProgressCapacity([request.operation.operationId, ...(deliveryRef === undefined ? [] : [deliveryRef])]);

    // Packing can create source pages/navigation views after intake archival.
    // Persist the actual delivered bodies without crowding its returned agenda.
    // Independent archival cannot advance our semantic head; a different head
    // belongs to a concurrent decision and must never be overwritten here.
    cursor = await archiveOriginals(cursor, mergeRuntimeMaterials(request.materials, request.organization), request.operation.operationId);

    const cleared = new Set(request.materials.filter(row => row.ref.startsWith("central-resource-change:")).map(row => {
      const body: unknown = JSON.parse(row.text);
      return typeof body === "object" && body !== null && "priorWaitRef" in body && typeof body.priorWaitRef === "string" ? body.priorWaitRef : "";
    }));

    if (delivery.retiredWaitRef !== undefined) cleared.add(delivery.retiredWaitRef);

    for (const ref of await admissionRetirements(cursor, request.operation.operationId)) cleared.add(ref);

    // Keep the latest original provider marker as a tombstone. Otherwise
    // compaction or an exact archive read could resurrect an older gate.
    for (const ref of cursor.history.retiredProviderWaitRefs ?? []) cleared.delete(ref);

    const returned = { ...cursor.state, intents: output.intents,
      ...(output.agendaRead === undefined ? {} : { agendaRead: output.agendaRead }),
      consumedSourceRefs: [...new Set([...cursor.state.consumedSourceRefs, ...delivered])],
      completed: [...cursor.state.completed.filter(row => row.operation.operationId !== request.operation.operationId), completed],
      // These are the exact materials delivered by the successful request, not
      // merely a prepared source snapshot. Preserve them through the original
      // runtime writer so native receivers and exact archive reads can prove
      // the same quoted body without charging for a second read operation.
      materials: mergeRuntimeMaterials(cursor.state.materials.filter(row => !cleared.has(row.ref)),
        request.materials.filter(row => !cleared.has(row.ref)),
        request.organization,
        [resultMaterial, judgment]) };
    // Historical output/proof stays immutable. Only a proven inherited host
    // marker in the runtime copy can become an open, uncommitted purpose.
    const next = openCentralReturnedThought({ state: returned, request, output, wireEvidence: delivery.wireEvidence });
    const considerationChars = opportunityConsideration === undefined ? 0 : canonicalJson({ opportunityConsideration }).length;

    if (canonicalJson(compactCentralWorkingSet(cursor.state, next, cursor.history.consumedSourceRefs, cursor.history.materials.map(row => row.ref))).length
      + considerationChars > CENTRAL_RUNTIME_LIMITS.jsonChars) {
      throw new SourceProgressCapacity([request.operation.operationId, ...(deliveryRef === undefined ? [] : [deliveryRef])]);
    }

    const choices = output.intents.filter(row => row.continuation.kind === "ready").map(row => row.continuation);

    // Freeze the public expectation before any selected downstream operation can execute.
    // Every paid planning computation also has its own original decision. A
    // reappraised but unchanged pending operation retains its first expectation;
    // the new agenda receipt keeps this computation and its actual cost visible.
    for (const choice of [null, ...choices]) {
      const recorded = await options.organization?.recordDecision?.({ request, output,
        role: choice === null ? "deliberation" : "operation_expectation",
        decisionRef: choice?.kind === "ready" ? choice.operation.operationId : request.operation.operationId,
        ...(deliveryRef === undefined ? {} : { deliveryRef }) }, input.signal);
      if (recorded !== undefined) {
        if (recorded.status !== "recorded" || !recorded.materials.every(isCentralRuntimeMaterial)) {
          throw new Error("central_organization_decision_result_invalid");
        }
      }
    }

    // Publication outcomes have their own bounded original Board receipt. Their
    // number or reconstructible bodies must not crowd out this legal agenda.
    const saved = await save(cursor, next, "central_deliberation_returned", output.sourceRefs, opportunityConsideration);

    if (output.knowledgeHandoffs !== undefined) {
      if (options.advisories === undefined) throw new Error("central_advisory_publisher_unavailable");
      await options.advisories.recordDecision({ scope: input.scope, appliedStateRef: saved.stateRef }, input.signal);
    }

    for (const work of cursor.state.running) {
      const intent = output.intents.find(row => row.intentId === work.intentId);
      if (intent?.continuation.kind === "ended") active.get(work.workRef)?.controller.abort("central_intent_investment_ended");
    }

    const correction = await publicationCorrection(saved, input);

    return correction !== undefined
      ? progress("ready", "central_organization_publication_condition_available", [saved.stateRef, correction.materials[0]!.ref])
      : stateProgress(saved.state, Date.parse(options.now()));
  };

  const recoverThought = async (cursor: Cursor, budgetId: string, input: CentralLearningDriveInput): Promise<Cursor> => {
    if (options.deliberation.inspect === undefined) return cursor;

    for (const pending of unresolvedSemanticAttempts(cursor.state)) {
      const found = await options.deliberation.inspect({ scope: input.scope, budgetId,
        operationId: pending.completed.operation.operationId }, input.signal);

      if (found.status !== "returned") continue;

      const current = cursor.stateRef === found.request.stateRef;

      cursor = await retireProviderWait(cursor, pending.completed.operation.operationId);

      if (current) {
        await applyOutput(cursor, found.request, found.output, input, { ref: found.deliveryRef, wireEvidence: found.wireEvidence });
      } else {
        const invalid = validateAgendaTransitionBeforeHistory(found.request, found.output);
        if (invalid !== null) throw new Error(invalid);

        const delivered = deliveredSourcesWithPublicationConditions(found.request);

        if (delivered.filter(ref => !cursor.history.consumedSourceRefs.includes(ref)).length > CENTRAL_RUNTIME_LIMITS.references) {
          throw new SourceProgressCapacity([found.request.operation.operationId, found.deliveryRef]);
        }

        // The immutable delivery already owns the complete returned thought.
        // Persist any original input bodies missing from runtime history before
        // acknowledging their delivery. Do not put every archived body back in
        // working memory when reconciling a response against a newer agenda.
        const archived = await archiveCentralRuntimeMaterials(store, cursor,
          mergeRuntimeMaterials(found.request.materials, found.request.organization));

        cursor = archived.cursor;

        if (archived.status === "contended") throw new CentralRuntimeCheckpointBusyError("stale_revision");

        if (archived.status === "capacity") throw new SourceProgressCapacity([found.request.operation.operationId, archived.materialRef]);

        // A returned central thought already contains its semantic decision.
        // A late receipt records it without inventing a new interpretation or
        // overwriting any newer continuation.
        const recorded = recordOperationResult(cursor.state, { intentId: pending.completed.intentId, operation: pending.completed.operation,
          result: { outcome: "returned", publicResult: found.output.publicExplanation,
            resultRefs: [...new Set([found.deliveryRef, ...found.sourceRefs])] } });
        const original = recorded.state.materials.find(row => row.ref === recorded.resultRef)!;
        const judgment = centralJudgmentResultMaterial({ scope: input.scope, operationId: found.request.operation.operationId,
          resultRef: recorded.resultRef, original });
        const completed = recorded.state;
        const retired = new Set(await admissionRetirements(cursor, found.request.operation.operationId));
        const state = { ...completed, materials: mergeRuntimeMaterials(completed.materials, [judgment])
          .filter(row => !retired.has(row.ref)),
          consumedSourceRefs: [...new Set([...completed.consumedSourceRefs, ...delivered])] };

        if (canonicalJson(compactCentralWorkingSet(cursor.state, state, cursor.history.consumedSourceRefs, cursor.history.materials.map(row => row.ref))).length > CENTRAL_RUNTIME_LIMITS.jsonChars) {
          throw new SourceProgressCapacity([found.request.operation.operationId, found.deliveryRef]);
        }

        // Record the real returned computation before retiring its pending
        // marker. A crash can then retry this freeze idempotently, without
        // applying stale choices or publishing old knowledge into a new agenda.
        await options.organization?.recordDecision?.({ request: found.request, output: found.output,
          decisionRef: found.request.operation.operationId, role: "deliberation", effects: "record_only",
          deliveryRef: found.deliveryRef }, input.signal);
        await save(cursor, state, "central_late_semantic_response_recovered_not_overwriting_new_agenda", [found.deliveryRef]);
      }

      cursor = await store.read(input.scope);
    }

    return cursor;
  };

  const recoverOpenContinuations = async (cursor: Cursor, budgetId: string, input: CentralLearningDriveInput): Promise<Cursor> => {
    if (options.deliberation.inspect === undefined) return cursor;

    for (const intent of cursor.state.intents) {
      if (!isCentralUnconfirmedThoughtWait(intent) || intent.continuation.kind !== "waiting") continue;

      const operationId = intent.continuation.wait.sourceRefs[0]!;
      const completed = cursor.state.completed.find(row => row.operation.operationId === operationId
        && row.intentId === intent.intentId && row.operation.kind === "think" && row.outcome === "returned");

      if (completed === undefined) continue;

      const original = await store.lookup(input.scope, { kind: "completed", operationId });

      // Repair only the exact original return checkpoint. A later runtime
      // decision, even one with the same wait body, is outside this recovery.
      if (original.status !== "found" || original.factRef !== cursor.stateRef) continue;

      const found = await options.deliberation.inspect({ scope: input.scope, budgetId, operationId }, input.signal);

      if (found.status !== "returned") continue;

      const state = openCentralReturnedThought({ state: cursor.state, request: found.request,
        output: found.output, wireEvidence: found.wireEvidence });

      if (state !== cursor.state) cursor = await save(cursor, state, "central_returned_thought_continuation_opened",
        [found.deliveryRef, ...completed.resultRefs]);
    }

    return cursor;
  };

  const deliberate = async (cursor: Cursor, snapshot: CentralRuntimeSnapshot, initial: Selection,
    budget: CentralBudgetProjection, budgetSequence: number, input: CentralLearningDriveInput): Promise<CentralLearningDriverProgress> => {
    let selected = initial;

    if (isCentralOutputCapacityIncreaseOperation(input.scope, selected.operation)
      && !authenticatedCentralOutputCapacityIncrease({ ...cursor.state,
        materials: mergeRuntimeMaterials(cursor.state.materials, snapshot.materials) }, cursor.history, budget, input.configuration, selected.operation)) {
      return progress("waiting", "central_output_capacity_increase_authority_unconfirmed", [selected.operation.operationId]);
    }

    const judgments = await readCentralJudgmentProjection(options);
    const contextMaterials = judgments.materials(snapshot.materials);
    const contextState = { ...cursor.state, materials: judgments.materials(cursor.state.materials) };
    // The current computation's dependencies may already have left the compact
    // working set during cold recovery. Resolve only exact original archived
    // bodies; this is not another source read, observation or model delivery.
    let deliveryMaterials = mergeRuntimeMaterials(contextMaterials, contextState.materials);
    const missingBodies = selected.operation.sourceRefs.filter(ref => !deliveryMaterials.some(row => row.ref === ref))
      .flatMap(ref => { const archived = cursor.history.materials.find(row => row.ref === ref);
      return archived === undefined ? []
        : [{ kind: "material" as const, ref, factRef: archived.factRef }]; });

    if (missingBodies.length > 0) {
      if (input.signal.aborted) return progress("ended", "central_runtime_cancelled", []);

      // One verified native replay resolves this whole dependency set. Replaying
      // the complete archive separately for each address stalls normal work and
      // cancellation as the original history grows.
      const found = await store.lookupMany(input.scope, missingBodies);

      for (let index = 0; index < missingBodies.length; index++) {
        const result = found[index];
        if (result?.status !== "found" || !isCentralRuntimeMaterial(result.value)
          || result.value.ref !== missingBodies[index]!.ref) throw new Error("central_runtime_source_missing");
        deliveryMaterials = mergeRuntimeMaterials(deliveryMaterials, [result.value]);
      }
    }

    if (input.signal.aborted) return progress("ended", "central_runtime_cancelled", []);

    deliveryMaterials = judgments.materials(mergeRuntimeMaterials(deliveryMaterials, await recallCentralComparisonContext({
      cursor: { ...cursor, state: contextState }, materials: contextMaterials, intent: selected.intent, store,
      projectMaterials: judgments.materials })));
    const organization = judgments.materials(mergeRuntimeMaterials(await options.organization?.recall({ scope: input.scope, state: contextState,
      opportunities: snapshot.opportunities, materials: contextMaterials, signal: input.signal }) ?? [],
      await options.advisories?.recall?.({ scope: input.scope, boardSequence: cursor.revision }, input.signal) ?? []));
    const issued: CentralRuntimeWorkResult = { outcome: "unknown", resultRefs: [],
      publicResult: "中央计算已登记；响应未确认。重启不自动重发；本次请求仍可返回公开结果。" };
    const issueState = (prior: CentralLearningRuntimeState) => {
      const resumed = selected.admission?.operationId === selected.operation.operationId;

      if (resumed && !prior.completed.some(row => row.operation.operationId === selected.operation.operationId
        && canonicalJson(row.operation) === canonicalJson(selected.operation))) throw new Error("central_admission_operation_mismatch");

      let next: CentralLearningRuntimeState = { ...prior, completed: [...prior.completed.filter(row => !resumed
        || row.operation.operationId !== selected.operation.operationId),
        { intentId: selected.intent?.intentId ?? "central:agenda", operation: selected.operation, ...issued }],
        materials: mergeRuntimeMaterials(prior.materials,
          [semanticAttemptMaterial(prior, selected.operation, Date.parse(options.now()), recoveryDelayMs)], selected.admission === undefined ? []
            : [semanticAdmissionMaterial(selected.operation.operationId, selected.admission.operationId, selected.admission.blockRef)],
          selected.capacityIncrease === undefined ? [] : deliveryMaterials.filter(row => row.ref === selected.capacityIncrease!.lineageRef)) };

      // Issuing consumes this operation. Transport outcome belongs to completed;
      // omission of a semantic successor must not turn into a fabricated wait.
      if (selected.intent?.continuation.kind === "ready"
        && selected.intent.continuation.operation.operationId === selected.operation.operationId) {
        next = replaceIntent(next, { ...selected.intent, continuation: { kind: "open" } });
      }

      return compactCentralWorkingSet(prior, next);
    };
    const state = issueState(cursor.state);
    let request: CentralDeliberationRequest = { schemaVersion: 1, scope: input.scope, budgetId: budget.budget.budgetId, configuration: input.configuration,
      boardSequence: Math.max(cursor.revision, budgetSequence), stateRef: cursor.stateRef, state, opportunities: snapshot.opportunities,
      resources: { boardSequence: budgetSequence, budgetId: budget.budget.budgetId, limits: budget.budget.limits,
        occupied: budget.occupied, available: budget.available, status: budget.status, holdReason: budget.holdReason ?? null },
      materials: mergeRuntimeMaterials(deliveryMaterials, state.materials), organization, operation: selected.operation };
    let checkpointState = state;
    const confirmedSourceRefs = new Set(cursor.history.consumedSourceRefs);
    const automatic = selected.intent === null && /^central-(agenda|reconsider):/.test(selected.operation.operationId);
    const deliveryConstraints: CentralDeliberationDeliveryConstraints = { projectJudgmentContext: judgments.request, sourceProgressFits(candidate, phase = "admission") {
      candidate = judgments.request(candidate);

      // Intermediate packing has not offered every source body yet. Capacity
      // still applies there; final admission must retain the actual trigger.
      // Unknown phases retain that strict check rather than bypassing it.
      if (phase !== "packing" && automatic && (!centralDeliveredSourceRefs(candidate).some(ref => selected.operation.sourceRefs.includes(ref)
        && !confirmedSourceRefs.has(ref)) || selected.operation.sourceRefs.filter(isPublicationConditionRef)
        .some(ref => !deliveredPublicationConditions(candidate).some(material => material.ref === ref)))) return false;

      const refs = deliveredSourcesWithPublicationConditions(candidate);

      if (refs.filter(ref => !confirmedSourceRefs.has(ref)).length > CENTRAL_RUNTIME_LIMITS.references) return false;

      const acknowledged = { ...checkpointState, consumedSourceRefs: [...new Set([...cursor.state.consumedSourceRefs, ...refs])],
        materials: mergeRuntimeMaterials(checkpointState.materials,
          [...candidate.materials, ...candidate.organization].filter(row => readCentralJudgmentMaterial(row) !== undefined)) };
      // Receipt identities are not known until return. Reserve their maximum
      // legal footprint before funding; these placeholders never leave this
      // pure size calculation or become a persisted receipt/source.
      const considerationChars = options.deliberation.inspect === undefined ? 0 : canonicalJson({ opportunityConsideration: {
        operationId: candidate.operation.operationId, deliveryRef: "x".repeat(256), resultRef: "x".repeat(256),
        sourceRefs: [...new Set(candidate.opportunities.map(opportunity => opportunity.sourceRef))],
      } }).length;

      return canonicalJson(compactCentralWorkingSet(cursor.state, acknowledged, cursor.history.consumedSourceRefs, cursor.history.materials.map(row => row.ref))).length
        + considerationChars <= CENTRAL_RUNTIME_LIMITS.jsonChars;
    } };
    const prepareDelivery = async (original: CentralDeliberationRequest) => {
      const projected = judgments.request(original);
      const prepared = options.deliberation.prepareDelivery === undefined ? projected
        : await options.deliberation.prepareDelivery(projected, input.signal, deliveryConstraints);

      if (prepared.scope !== original.scope || prepared.budgetId !== original.budgetId || prepared.stateRef !== original.stateRef
        || canonicalJson(prepared.operation) !== canonicalJson(original.operation)
        || canonicalJson(prepared.state.intents) !== canonicalJson(original.state.intents)) throw new Error("central_deliberation_delivery_mismatch");

      const correctionRefs = selected.operation.sourceRefs.filter(isPublicationConditionRef);
      const deliveredCorrections = new Set(deliveredPublicationConditions(prepared).map(material => material.ref));

      if (automatic && correctionRefs.some(ref => !deliveredCorrections.has(ref))) {
        throw new CentralDeliberationError("central_deliberation_publication_condition_context_capacity");
      }

      if (!deliveryConstraints.sourceProgressFits(prepared, "admission")) throw new SourceProgressCapacity([original.operation.operationId]);

      if (automatic && !centralDeliveredSourceRefs(prepared).some(ref => selected.operation.sourceRefs.includes(ref)
        && !cursor.history.consumedSourceRefs.includes(ref))) throw new CentralDeliberationError("central_deliberation_new_source_context_capacity");

      if (selected.providerAdmission !== undefined && !prepared.materials.some(material => {
        const proof = readProviderPositiveAdmissionMaterial(material, selected.operation, input.scope);
        return proof?.ref === selected.providerAdmission!.ref;
      })) throw new CentralDeliberationError("central_deliberation_provider_admission_context_capacity");

      if (selected.capacityIncrease !== undefined && !prepared.materials.some(material => material.ref === selected.capacityIncrease!.lineageRef)) {
        throw new CentralDeliberationError("central_deliberation_capacity_increase_context_capacity");
      }

      return prepared;
    };

    try {
      // Ownership and issue history govern a prospective host computation,
      // including provider recovery. Operation naming is not budget policy.
      const modelOwned = selected.intent?.continuation.kind === "ready"
        && selected.intent.continuation.operation.operationId === selected.operation.operationId;
      const freshAutomatic = !modelOwned && selected.operation.kind === "think"
        && selected.operation.maxOutputTokens === undefined
        && !cursor.history.operations.some(row => row.operationId === selected.operation.operationId)
        && !cursor.state.completed.some(row => row.operation.operationId === selected.operation.operationId)
        && !cursor.state.running.some(row => row.operation.operationId === selected.operation.operationId);

      if (freshAutomatic && options.deliberation.selectAutomaticOutput !== undefined) {
        // The current source notice/publication condition must fit as well as
        // the unchanged purpose and PA controls. Optional history cannot buy
        // admission by displacing the reason for this automatic computation.
        const maxOutputTokens = await options.deliberation.selectAutomaticOutput(request, input.signal, deliveryConstraints);
        if (maxOutputTokens !== undefined && selected.operation.kind === "think") {
          selected = { ...selected, operation: { ...selected.operation, maxOutputTokens } };
          checkpointState = issueState(cursor.state);
          request = { ...request, operation: selected.operation, state: checkpointState,
            materials: mergeRuntimeMaterials(deliveryMaterials, checkpointState.materials) };
        }
      }

      await prepareDelivery(request);
    }
    catch (error) { return progress("waiting", error instanceof Error ? error.message : "central_deliberation_capacity_unconfirmed", [cursor.stateRef]); }

    // Every original body is durable before its address can be deferred. Whole
    // batches use existing record capacity, without changing model exposure.
    const archived = await archiveCentralRuntimeMaterials(store, cursor, mergeRuntimeMaterials(snapshot.materials, organization,
      deliveryMaterials.filter(row => readCentralJudgmentMaterial(row) !== undefined)));

    cursor = archived.cursor;

    if (archived.status === "capacity") return progress("waiting", "central_runtime_source_archive_capacity", [archived.materialRef]);

    const contended = () => ({ ...progress("waiting", "central_runtime_checkpoint_contended", [cursor.stateRef]),
      wakeAt: Date.parse(options.now()) + recoveryDelayMs });

    if (archived.status === "contended") return contended();

    let claimed: Cursor | undefined;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Source archival can safely follow another intake. Issuing a computation
      // must still own the same exact purpose and an unissued original unit.
      if (selected.intent !== null && canonicalJson(cursor.state.intents.find(row => row.intentId === selected.intent!.intentId))
        !== canonicalJson(selected.intent)) return progress("ready", "central_selected_intent_changed", [cursor.stateRef]);

      if (selected.admission === undefined && (cursor.state.completed.some(row => row.operation.operationId === selected.operation.operationId)
        || cursor.state.running.some(row => row.operation.operationId === selected.operation.operationId))) {
        return progress("ready", "central_selected_operation_already_issued", [cursor.stateRef]);
      }

      try {
        claimed = await save(cursor, issueState(cursor.state), "central_deliberation_issued", selected.operation.sourceRefs,
          undefined, selected.providerAdmission === undefined ? undefined : { admission: selected.providerAdmission });
        break;
      } catch (error) {
        if (!(error instanceof CentralRuntimeHeadChangedError)) throw error;
        cursor = error.current;
      }
    }

    if (claimed === undefined) return contended();

    for (const ref of cursor.history.consumedSourceRefs) confirmedSourceRefs.add(ref);

    checkpointState = claimed.state;
    // Mechanical source archival can compact the live state. Preserve this
    // computation's frozen body candidates and add only the actual issued state,
    // rather than replacing them with the post-archive working set.
    request = { ...request, stateRef: claimed.stateRef, boardSequence: claimed.revision, state: claimed.state,
      materials: mergeRuntimeMaterials(deliveryMaterials, claimed.state.materials) };
    let output;

    try {
      request = await prepareDelivery(request);
      output = await options.deliberation.deliberate(request, input.signal, deliveryConstraints);
    }
    catch (error) {
      if (error instanceof CentralDeliberationError && error.delivery === "returned") {
        claimed = await retireProviderWait(claimed, selected.operation.operationId);
      }

      const failure = progress("waiting", error instanceof Error ? error.message : "central_deliberation_unconfirmed", [claimed.stateRef]);

      if (blocksAutomaticSemanticRecovery(error) || isCentralActionCorrectionOperation(input.scope, selected.operation)
        || isCentralOutputCapacityIncreaseOperation(input.scope, selected.operation)
        || isProviderRecoveryAttempt(claimed.state, selected.operation) || selected.providerAdmission !== undefined) {
        const failureAt = Date.parse(options.now());
        let blocked = (selected.admission?.operationId === selected.operation.operationId
          && error instanceof CentralDeliberationError && error.reason === "learning_budget_stale"
          ? claimed.state.materials.find(row => row.ref === selected.admission?.blockRef) : undefined)
          ?? semanticRecoveryBlock(selected.operation.operationId, error, budget, input.configuration.configurationRef,
          { state: claimed.state, operation: selected.operation, now: failureAt, recoveryDelayMs,
            ...(selected.providerAdmission === undefined ? {} : { positiveAdmission: true }),
            ...(input.configuration.generationRef === undefined ? {} : { generationRef: input.configuration.generationRef }),
            ...(input.configuration.providerConnectionRef === undefined ? {} : { providerConnectionRef: input.configuration.providerConnectionRef }) });
        const priorBlock = claimed.state.materials.find(row => row.ref === blocked.ref);

        if (priorBlock !== undefined && canonicalJson(priorBlock) !== canonicalJson(blocked)) {
          blocked = { ...blocked, ref: `${blocked.ref}:${contentHashOf(blocked.text)}` };
        }

        let waiting = { ...claimed.state, materials: mergeRuntimeMaterials(claimed.state.materials, [blocked]) };
        const condition = semanticResourceCondition(waiting, budget, input.configuration.configurationRef, failureAt, claimed.history,
          input.configuration.providerConnectionRef, { ...input.configuration,
            ...(selected.providerAdmission === undefined ? {} : { admittedProviderWaitRef: selected.providerAdmission.waitRef }) });

        if (selected.intent !== null && (condition.blocked || error instanceof CentralDeliberationError
          && error.delivery === "not_sent" && isCentralDeliberationInputCapacity(error.reason))) {
          waiting = replaceIntent(waiting, { ...selected.intent, continuation: { kind: "waiting", wait: {
            kind: "resources", reason: condition.reason ?? failure.reason,
            sourceRefs: [budget.budget.budgetId, blocked.ref, selected.operation.operationId] } } });
        }

        if (condition.reason === "provider_recovery_exhausted"
          || error instanceof Error && "failureClass" in error && (error.failureClass === "resources" || error.failureClass === "contract")) {
          waiting = { ...waiting, completed: waiting.completed.map(row => row.operation.operationId === selected.operation.operationId
            ? { ...row, outcome: "failed" as const, publicResult: condition.reason === "provider_recovery_exhausted"
              ? "provider_recovery_exhausted：一次通信恢复仍遭拒绝或结果未知；当前等待真实provider或连接/账户条件改变，原root未知费用继续占用。"
              : error instanceof CentralDeliberationError && error.delivery === "returned" && isCompleteCentralOutputCapacityRejection(error.outputDiagnostics)
                ? "中央操作已完整终止但输出容量用尽，没有可用语义决定；原reported费用保留，等待真实生成配置或研究输入改变。"
              : `中央操作明确失败：${condition.reason ?? failure.reason}；费用状态仍以原root收据为准。` } : row) };
        }

        const saved = await save(claimed, waiting, "central_semantic_recovery_requires_actual_condition", [blocked.ref]);

        // A complete, charged length refusal may justify one larger actual cap
        // already authorized by this policy. It never retries the old call.
        if (error instanceof CentralDeliberationError && error.delivery === "returned"
          && isCompleteCentralOutputCapacityRejection(error.outputDiagnostics)
          && !isCentralOutputCapacityIncreaseOperation(input.scope, selected.operation) && options.enabled() && !input.signal.aborted) {
          const current = await ensureCentralLearningBudget({ ...options, allowance: input.configuration.allowance,
            authorizationRef: input.configuration.authorizationRef,
            ...(input.configuration.rootRef === undefined ? {} : { rootRef: input.configuration.rootRef }) });
          if (current.ok) {
            const increase = await capacityIncrease(saved, current.projection, input, blocked.ref);
            if (increase !== undefined) return progress("ready", "central_output_capacity_increase_available", [saved.stateRef, increase.admission.waitRef]);
          }
        }

        // Only a newly recorded concrete refusal can request its own next
        // owner turn. That turn still rechecks the original funds, evidence,
        // active capability and one-operation fence before any reservation.
        if (error instanceof CentralDeliberationError && error.delivery === "returned"
          && (error.semanticRejection !== undefined || isActionableCentralChangeStructureRejection(error.structureRejection)
            || error.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON)
          && !isCentralActionCorrectionOperation(input.scope, selected.operation)
          && !isCentralOutputCapacityIncreaseOperation(input.scope, selected.operation) && options.enabled() && !input.signal.aborted) {
          const current = await ensureCentralLearningBudget({ ...options, allowance: input.configuration.allowance,
            authorizationRef: input.configuration.authorizationRef,
            ...(input.configuration.rootRef === undefined ? {} : { rootRef: input.configuration.rootRef }) });
          if (current.ok && current.projection.status === "available" && current.projection.available.calls > 0
            && current.projection.available.steps > 0 && current.projection.available.tokens > 0) {
            // The just-saved refusal is live; a missing body is insufficient
            // for this immediate continuation, rather than an archive search.
            const rejected = await readCentralActionRejection({ state: saved.state, history: saved.history,
              budget: current.projection, lookupMaterial: async () => undefined });
            if (rejected?.operation.operationId === selected.operation.operationId
              && centralActionCorrection(saved.state, saved.history, current.projection.budget.budgetId, rejected) !== undefined) {
              return progress("ready", "central_reference_rejection_feedback_available", [saved.stateRef, rejected.rejectionRef]);
            }
          }
        }

        if (error instanceof CentralDeliberationError && error.reason === "learning_budget_stale") {
          return { ...failure, wakeAt: failureAt + recoveryDelayMs };
        }

        const providerWait = input.configuration.providerConnectionRef === undefined ? undefined : providerWaitForPositiveObservation(saved.state,
          saved.history, input.configuration.providerConnectionRef, budget.budget.budgetId, saved.revision);

        return { ...failure, state: condition.recovery === undefined ? "waiting" : "ready",
          reason: condition.reason ?? failure.reason, ...(condition.wakeAt === undefined ? {} : { wakeAt: condition.wakeAt }),
          ...(providerWait === undefined ? {} : { providerWait }) };
      }

      const now = Date.parse(options.now());

      if (semanticRecovery(claimed.state, now) !== null) return { ...failure, state: "ready" };

      const wakeAt = semanticRecoveryAt(claimed.state, now);

      return wakeAt === undefined ? failure : { ...failure, wakeAt };
    }

    claimed = await retireProviderWait(claimed, selected.operation.operationId);
    const receipt = await options.deliberation.inspect?.({ scope: input.scope, budgetId: budget.budget.budgetId,
      operationId: selected.operation.operationId }, input.signal);

    if (receipt?.status === "returned") {
      if (receipt.request.scope !== request.scope || receipt.request.budgetId !== request.budgetId || receipt.request.stateRef !== request.stateRef
        || canonicalJson(receipt.request.operation) !== canonicalJson(request.operation) || canonicalJson(receipt.output) !== canonicalJson(output)
        || canonicalJson(receipt.request.state.intents) !== canonicalJson(request.state.intents)) throw new Error("central_deliberation_receipt_mismatch");
      request = receipt.request;
    }

    // The immutable refusal stays in history. It ceases to be an active wait
    // only after this admitted original computation or the new source review returns.
    const result = await applyOutput(claimed, request, output, input, {
      ...(receipt?.status === "returned" ? { ref: receipt.deliveryRef, wireEvidence: receipt.wireEvidence } : {}),
      ...(selected.admission === undefined ? {} : { retiredWaitRef: selected.admission.blockRef }),
      ...(options.deliberation.prepareDelivery === undefined && receipt?.status !== "returned"
        ? { legacyNotices: [...snapshot.sourceRefs, ...selected.operation.sourceRefs] } : {}) });

    return (snapshot.hasMore === true || hasUnlistedCentralMaterial(snapshot.materials, request)) && result.state !== "ready"
      ? progress("ready", "central_unconsumed_source_catalog_remaining", snapshot.sourceRefs) : result;
  };

  const operate = async (cursor: Cursor, selected: Selection, input: CentralLearningDriveInput): Promise<CentralLearningDriverProgress> => {
    if (selected.operation.kind === "read" && isPendingCentralAgendaRead(cursor.state, selected.operation)) {
      const result = await performCentralAgendaRead({ state: cursor.state, history: cursor.history, operation: selected.operation,
        source: options.source, signal: input.signal, enabled: options.enabled });
      const returnedRefs = new Set(result.sourceRefs);
      cursor = await archiveOriginals(cursor, result.state.materials.filter(row => returnedRefs.has(row.ref)), selected.operation.operationId);
      const saved = await save(cursor, result.state, result.reason, result.sourceRefs);
      return { ...(nextCentralAgendaOperation(saved.state, saved.history) === undefined
        ? stateProgress(saved.state, Date.parse(options.now())) : progress("ready", "central_agenda_read_result_requires_review")),
        reason: result.reason, sourceRefs: [saved.stateRef, ...result.sourceRefs] };
    }

    const intent = selected.intent;

    if (intent === null) throw new Error("central_operation_intent_required");

    const operation = selected.operation;

    if (operation.kind === "dispatch") {
      let work;

      try { work = await options.execution.prepare({ scope: input.scope, intent, operation,
        configuration: input.configuration, signal: input.signal }); }
      catch (error) {
        if (!(error instanceof CentralRuntimeBlocked)) throw error;

        let state = completeOperation(cursor.state, { intentId: intent.intentId, operation,
          result: { outcome: "returned", publicResult: `原域明确交还，尚未执行：${error.reason}`, resultRefs: error.sourceRefs } });

        if (error.boundary !== "preparation") state = replaceIntent(state, { ...intent, continuation: { kind: "waiting", wait: {
          kind: error.boundary === "resources" ? "resources" : "facts", reason: error.reason, sourceRefs: error.sourceRefs } } });

        if (error.boundary === "resources") {
          const current = await ensureCentralLearningBudget({ ...options, allowance: input.configuration.allowance,
            authorizationRef: input.configuration.authorizationRef,
            ...(input.configuration.rootRef === undefined ? {} : { rootRef: input.configuration.rootRef }) });

          if (!current.ok) throw new Error(current.reason);

          const condition = Object.assign(new Error(error.reason), { failureClass: "resources" as const });

          state = { ...state, materials: mergeRuntimeMaterials(state.materials,
            [semanticRecoveryBlock(operation.operationId, condition, current.projection, input.configuration.configurationRef)]),
            consumedSourceRefs: [...new Set([...state.consumedSourceRefs, ...error.sourceRefs])] };
        }

        const saved = await save(cursor, state, "central_domain_preparation_handback", error.sourceRefs);

        return stateProgress(saved.state, Date.parse(options.now()));
      }

      const saved = await save(cursor, startWork(cursor.state, work), "central_domain_work_prepared", [work.workRef]);

      launch(work, input);

      return { ...stateProgress(saved.state, Date.parse(options.now())), sourceRefs: [work.workRef] };
    }

    if (operation.kind === "think") throw new Error("central_think_requires_deliberation");

    let materials: readonly CentralRuntimeMaterial[];

    if (operation.kind === "read") {
      if (input.signal.aborted || !options.enabled()) return progress("waiting", "central_runtime_disabled_or_cancelled");

      const request = { scope: input.scope, operation, materials: cursor.state.materials, history: cursor.history };
      const repeated = readOperationRefusal(request);

      if (repeated !== undefined) {
        const state = replaceIntent(cursor.state, { ...intent, continuation: { kind: "waiting", wait: repeated.result.wait! } });
        const saved = await save(cursor, state, "central_read_condition_unchanged", [repeated.repeated!]);
        return stateProgress(saved.state, Date.parse(options.now()));
      }

      try { materials = await options.source.read(input.scope, operation.refs, operation.maximumChars, input.signal); }
      catch (error) {
        if (input.signal.aborted || !options.enabled()) throw error;

        const refusal = readOperationRefusal({ ...request, error });
        if (refusal === undefined) throw error;

        const state = completeOperation(cursor.state, { intentId: intent.intentId, operation, result: refusal.result });

        if (!isCentralLearningRuntimeState(compactCentralWorkingSet(cursor.state, state, cursor.history.consumedSourceRefs, cursor.history.materials.map(row => row.ref)))) {
          return progress("waiting", "central_read_refusal_checkpoint_capacity", [operation.operationId]);
        }

        const saved = await save(cursor, state, "central_source_read_not_obtained", [operation.operationId]);

        return stateProgress(saved.state, Date.parse(options.now()));
      }
    } else materials = [await options.execution.consult({ scope: input.scope, subject: intent.subject, allowance: operation.allowance, signal: input.signal })];

    const result = { outcome: "returned" as const,
      publicResult: `已完成${operation.kind}，公开材料保留原引用：${materials.map(row => row.ref).join(", ")}。`, resultRefs: materials.map(row => row.ref) };
    cursor = await archiveOriginals(cursor, materials, operation.operationId);
    const state = completeOperation(cursor.state, { intentId: intent.intentId, operation, result });
    const saved = await save(cursor, { ...state, materials: mergeRuntimeMaterials(state.materials, materials) }, "central_operation_returned", result.resultRefs);

    return progress("ready", "central_operation_returned", [saved.stateRef, ...result.resultRefs]);
  };

  // Reconcile durable in-flight work before selecting fresh source material.
  const drive = async (input: CentralLearningDriveInput): Promise<CentralLearningDriverProgress> => {
    if (input.scope !== options.scope) throw new Error("central_runtime_scope_mismatch");

    if (terminalError !== undefined) throw terminalError;

    if (closed || !options.enabled() || input.signal.aborted) return progress("waiting", "central_runtime_disabled_or_cancelled");

    const budget = await ensureCentralLearningBudget({ ...options, allowance: input.configuration.allowance,
      authorizationRef: input.configuration.authorizationRef,
      ...(input.configuration.rootRef === undefined ? {} : { rootRef: input.configuration.rootRef }) });

    if (!budget.ok) return progress("waiting", budget.reason);

    // The model's per-operation envelope and the live root's cumulative ceiling
    // have different jobs. Root adjustments are visible in resources; they do
    // not silently enlarge a single dispatch or reset its original purse.
    input = { ...input, configuration: { ...input.configuration, rootRef: budget.rootRef } };
    let cursor = await store.read(input.scope);

    cursor = await recoverThought(cursor, budget.projection.budget.budgetId, input);
    cursor = await recoverOpenContinuations(cursor, budget.projection.budget.budgetId, input);
    // A completed thought is no longer an unresolved attempt. Recover its
    // persisted applied publication choices independently of model execution.
    await options.advisories?.recoverApplied({ scope: input.scope }, input.signal);

    if (options.advisories !== undefined) cursor = await store.read(input.scope);

    const outputFailure = await recoverCentralOutputCapacityFailures({ state: cursor.state, history: cursor.history,
      budget: budget.projection, configuration: input.configuration, lookupMaterial: async (ref, factRef) => {
        const found = await store.lookup(input.scope, { kind: "material", ref, factRef });
        return found.status === "found" && isCentralRuntimeMaterial(found.value) ? found.value : undefined;
      } });

    if (outputFailure !== undefined) cursor = await save(cursor, outputFailure.state,
      "central_complete_output_capacity_failure_recovered", outputFailure.sourceRefs);

    const recoveredOrganization = await options.organization?.recoverResults?.({ scope: input.scope }, input.signal) ?? [];

    if (recoveredOrganization.length > 0) cursor = await save(cursor,
      { ...cursor.state, materials: mergeRuntimeMaterials(cursor.state.materials, recoveredOrganization) },
      "central_original_organization_progress_recovered", recoveredOrganization.map(row => row.ref));

    for (const work of cursor.state.running) {
      if (active.has(work.workRef)) continue;

      const result = await options.execution.recover(work, input.signal);

      if (result !== null && "kind" in result && result.kind === "ready_to_execute") launch(work, input);
      else if (result !== null && "outcome" in result) {
        const waiting = await returned(work, result, input);
        if (waiting !== undefined) return waiting;
        cursor = await store.read(input.scope);
      }
    }

    let snapshot = await options.source.snapshot(input.scope, input.signal, {
      wakeSourceRefs: input.wake.sourceRefs,
      subjects: cursor.state.intents.filter(row => row.continuation.kind !== "ended").map(row => row.subject),
      purposes: cursor.state.intents.filter(row => row.continuation.kind !== "ended").map(row => ({ subject: row.subject, purpose: row.goal,
        sourceRefs: [...new Set([row.intentId, ...row.sourceRefs, ...(row.derivation?.parentRefs ?? []), ...row.knowledge.flatMap(knowledge => knowledge.sourceRefs),
          ...(row.continuation.kind === "waiting" ? row.continuation.wait.sourceRefs : []),
          ...cursor.state.completed.filter(completed => completed.intentId === row.intentId).flatMap(completed => completed.resultRefs),
          ...(row.continuation.kind === "ready" ? row.continuation.operation.sourceRefs : [])])] })),
      sourceRefs: [...new Set([...cursor.history.consumedSourceRefs, ...cursor.state.intents.flatMap(row => [...row.sourceRefs,
        ...(row.derivation?.parentRefs ?? []),
          ...(row.continuation.kind === "ready" ? row.continuation.operation.sourceRefs : [])])])],
      consideredSourceRefs: cursor.history.consideredSourceRefs ?? [] });
    // A definite publication refusal is an original result, not an external
    // support sample. Offer one bounded correction through normal source
    // selection; the condition identity excludes proposal wording/delivery.
    // The original result receipt keeps it discoverable after compaction.
    const correction = await publicationCorrection(cursor, input);

    if (correction !== undefined) {
      const condition = correction.materials[0]!;
      const considered = new Set(cursor.history.consideredSourceRefs ?? []);
      const freshOriginal = snapshot.sourceRefs.some(ref => !cursor.history.consumedSourceRefs.includes(ref)
        && !cursor.history.pendingSemanticSourceRefs?.includes(ref)
        && !isConsideredCentralIssueNotice(ref, considered));

      snapshot = { ...snapshot, materials: mergeRuntimeMaterials(snapshot.materials, correction.materials), ...(freshOriginal ? {} : {
          sourceRefs: [...new Set([...snapshot.sourceRefs, condition.ref])],
          reconsider: [...(snapshot.reconsider ?? []), ...correction.purposes.map(intent => ({ subject: intent.subject,
            sourceRefs: [condition.ref], reason: "original_organization_publication_refused_requires_source_review_not_new_business_support" }))],
        }) };
    }

    let selectionState = { ...cursor.state, consumedSourceRefs: cursor.history.consumedSourceRefs };
    const unadmitted = unadmittedSemanticAttempt(selectionState);
    let admission: Selection["admission"];

    if (unadmitted !== undefined && options.deliberation.inspect !== undefined) {
      const found = await options.deliberation.inspect({ scope: input.scope, budgetId: budget.projection.budget.budgetId,
        operationId: unadmitted.completed.operation.operationId }, input.signal);
      if (confirmsOriginalAdmission(found, input.configuration, input.scope, unadmitted.completed.operation.operationId, unadmitted.reason)
        && !input.signal.aborted && options.enabled()) {
        if (found.status === "not_sent" && found.admission!.boardSequence > snapshot.boardSequence) {
          return progress("ready", "central_admission_source_prefix_changed", [cursor.stateRef]);
        }
        admission = { operationId: unadmitted.completed.operation.operationId, blockRef: unadmitted.blockRef };
        selectionState = { ...selectionState, materials: selectionState.materials.filter(row => row.ref !== unadmitted.blockRef) };
      }
    }

    let resourceCondition = semanticResourceCondition(selectionState, budget.projection, input.configuration.configurationRef, Date.parse(options.now()), cursor.history,
      input.configuration.providerConnectionRef, input.configuration);

    if (resourceCondition.material !== undefined) snapshot = { ...snapshot,
      sourceRefs: [...snapshot.sourceRefs, resourceCondition.material.ref], materials: [...snapshot.materials, resourceCondition.material] };

    const workState = admission === undefined ? selectionState : { ...selectionState, materials: cursor.state.materials };
    let selected: Selection | null = workState.agendaRead !== undefined || resourceCondition.recovery === undefined
      ? selectWork(workState, snapshot, Date.parse(options.now()), cursor.history)
      : { intent: selectionState.intents.find(row => row.intentId === resourceCondition.recovery!.intentId) ?? null,
          operation: resourceCondition.recovery.operation };

    if (admission !== undefined && unadmitted !== undefined
      && (selected === null || !isPendingCentralAgendaRead(cursor.state, selected.operation))) {
      // Only historical CAS admission may precede a fresh source/PA review.
      // A proved unsent cancellation resumes the exact original operation.
      if (!isCentralDeliberationInputCapacity(unadmitted.reason) || selected === null
        || selected.operation.operationId === unadmitted.completed.operation.operationId) selected = unadmitted.reason === "learning_budget_stale" && selected?.intent === null
        && /^central-(agenda|reconsider):/.test(selected.operation.operationId)
        ? { ...selected, admission } : {
        intent: cursor.state.intents.find(row => row.intentId === unadmitted.completed.intentId) ?? null,
        operation: unadmitted.completed.operation, admission };
    }

    if (selected === null) {
      // A valid old action correction must not hide the current authenticated
      // length continuation behind the unchanged global capacity wait.
      const increase = await capacityIncrease(cursor, budget.projection, input);
      if (increase !== undefined) {
        snapshot = { ...snapshot, materials: mergeRuntimeMaterials(snapshot.materials, increase.materials) };
        selectionState = { ...selectionState, materials: mergeRuntimeMaterials(selectionState.materials, increase.materials) };
        selected = { intent: increase.intent, operation: increase.operation, capacityIncrease: increase.admission };
      }
    }

    if (selected === null) {
      const rejected = await readCentralActionRejection({ state: cursor.state, history: cursor.history, budget: budget.projection,
        canCorrect: original => centralActionCorrection(cursor.state, cursor.history, budget.projection.budget.budgetId, original) !== undefined,

        lookupMaterial: async (ref, factRef) => {
          const found = await store.lookup(input.scope, { kind: "material", ref, factRef });
          return found.status === "found" && isCentralRuntimeMaterial(found.value) ? found.value : undefined;
        } });
      const correction = rejected === undefined ? undefined
        : centralActionCorrection(cursor.state, cursor.history, budget.projection.budget.budgetId, rejected);

      if (correction !== undefined) {
        snapshot = { ...snapshot, materials: mergeRuntimeMaterials(snapshot.materials, correction.materials) };
        selected = { intent: correction.intent, operation: correction.operation };
      }
    }

    const resourceWait = () => {
      const providerWait = input.configuration.providerConnectionRef === undefined ? undefined
        : providerWaitForPositiveObservation(selectionState, cursor.history, input.configuration.providerConnectionRef,
          budget.projection.budget.budgetId, cursor.revision);
      return { ...progress("waiting", resourceCondition.reason ?? "central_wait_for_actual_resource_or_configuration_change"),
        ...(providerWait === undefined ? {} : { providerWait }),
        ...(resourceCondition.wakeAt === undefined ? {} : { wakeAt: resourceCondition.wakeAt }) };
    };

    if (selected === null) return resourceCondition.blocked ? resourceWait() : stateProgress(cursor.state, Date.parse(options.now()));

    if (!isPendingCentralAgendaRead(cursor.state, selected.operation) && selected.admission?.operationId !== selected.operation.operationId
      && operationCompleted(cursor.state, selected.operation, cursor.history)) throw new Error("central_operation_already_issued");

    if (selected.operation.kind !== "think") return operate(cursor, selected, input);

    if (resourceCondition.blocked) {
      const priorSources = new Set([...cursor.history.consumedSourceRefs, ...(cursor.history.pendingSemanticSourceRefs ?? []),
        ...(cursor.history.consideredSourceRefs ?? [])]);
      const researchSourceRefs = [...snapshot.sourceRefs, ...cursor.state.completed.filter(row => row.outcome === "returned"
        && row.operation.kind !== "think").flatMap(row => row.resultRefs)].filter(ref => !priorSources.has(ref));

      resourceCondition = semanticResourceCondition(selectionState, budget.projection, input.configuration.configurationRef, Date.parse(options.now()), cursor.history,
        input.configuration.providerConnectionRef, { ...input.configuration, operation: selected.operation, researchSourceRefs });

      // Another ready thought can be blocked by this original length wait.
      // Only that actual blockage may yield to its authenticated continuation;
      // fresh research, PA review and provider recovery keep their own turn.
      if (resourceCondition.blocked
        && resourceCondition.reason === "central_deliberation_output_capacity_requires_changed_generation_or_research_input"
        && !selected.operation.operationId.startsWith("central-reconsider:")
        && selected.admission === undefined && selected.providerAdmission === undefined && selected.capacityIncrease === undefined) {
        const increase = await capacityIncrease(cursor, budget.projection, input);
        if (increase !== undefined) {
          const increasedState = { ...selectionState, materials: mergeRuntimeMaterials(selectionState.materials, increase.materials) };
          const increasedCondition = semanticResourceCondition(increasedState, budget.projection, input.configuration.configurationRef,
            Date.parse(options.now()), cursor.history, input.configuration.providerConnectionRef,
            { ...input.configuration, operation: increase.operation, researchSourceRefs });

          if (!increasedCondition.blocked && increasedCondition.recovery === undefined) {
            selectionState = increasedState;
            snapshot = { ...snapshot, materials: mergeRuntimeMaterials(snapshot.materials, increase.materials) };
            selected = { intent: increase.intent, operation: increase.operation, capacityIncrease: increase.admission };
            resourceCondition = increasedCondition;
          }
        }
      }

      if (resourceCondition.material !== undefined) snapshot = { ...snapshot,
        materials: mergeRuntimeMaterials(snapshot.materials, [resourceCondition.material]) };

      const wait = latestProviderWait(selectionState, cursor.history);
      const locator = wait === undefined ? undefined : cursor.history.materials.find(row => row.ref === wait.ref);
      const selectedOperation = selected.operation;
      const previousProviderAdmission = selected.admission?.operationId === selectedOperation.operationId
        ? (cursor.history.providerPositiveAdmissions ?? []).find(row => row.admission.operationId === selectedOperation.operationId
          && row.admission.operationSignature === centralOperationSignature(selectedOperation)
          && row.admission.scope === input.scope && row.admission.budgetId === budget.projection.budget.budgetId
          && row.admission.connectionRef === input.configuration.providerConnectionRef && row.admission.waitRef === wait?.ref
          && row.admission.waitFactRef === locator?.factRef && !cursor.history.retiredProviderWaitRefs?.includes(row.admission.waitRef))?.admission
        : undefined;
      const positive = previousProviderAdmission !== undefined
        ? { admission: previousProviderAdmission, material: providerPositiveAdmissionMaterial(previousProviderAdmission) }
        : wait === undefined || locator?.sequence === undefined || input.configuration.providerConnectionRef === undefined ? undefined
        : selectProviderPositiveAdmission({ state: selectionState, history: cursor.history, scope: input.scope,
          budgetId: budget.projection.budget.budgetId, connectionRef: input.configuration.providerConnectionRef,
          boardSequence: cursor.revision, now: Date.parse(options.now()), wait: { material: wait, factRef: locator.factRef, sequence: locator.sequence },
          selectedOperation: selected.operation, freshBusinessRefs: researchSourceRefs, notes: snapshot.providerPositiveNotes ?? [] });

      if (positive !== undefined) {
        const admitted = semanticResourceCondition(selectionState, budget.projection, input.configuration.configurationRef, Date.parse(options.now()),
          cursor.history, input.configuration.providerConnectionRef,
          { ...input.configuration, operation: selected.operation, researchSourceRefs, admittedProviderWaitRef: positive.admission.waitRef });
        if (!admitted.blocked) {
          selected = { ...selected, providerAdmission: positive.admission };
          resourceCondition = admitted;
          snapshot = { ...snapshot, materials: mergeRuntimeMaterials(snapshot.materials, [positive.material]) };
        }
      }
    }

    if (resourceCondition.blocked) return resourceWait();

    const currentBudget = await ensureCentralLearningBudget({ ...options, allowance: input.configuration.allowance,
      authorizationRef: input.configuration.authorizationRef,
      ...(input.configuration.rootRef === undefined ? {} : { rootRef: input.configuration.rootRef }) });

    if (!currentBudget.ok) return progress("waiting", currentBudget.reason);

    if (currentBudget.projection.status !== "available" || currentBudget.projection.available.calls < 1
      || currentBudget.projection.available.steps < 1 || currentBudget.projection.available.tokens < 1) return progress("waiting", "central_resources_unavailable");

    return deliberate(cursor, snapshot, selected, currentBudget.projection, currentBudget.board.sequence, input);
  };

  return { drive: input => serialize(async () => {
    organizationBusyDuringDrive = false;
    try {
      const result = await drive(input);
      if (!organizationBusyDuringDrive) {
        organizationBackoffUsed = false;
        organizationBackoffRevision = undefined;
      }
      return result;
    }
    catch (error) {
      if (error instanceof SourceProgressCapacity) return progress("waiting", error.message, error.sourceRefs);

      if (isCentralRuntimeCheckpointContention(error)) return {
        ...progress("waiting", "central_runtime_checkpoint_contended", input.wake.sourceRefs),
        wakeAt: Date.parse(options.now()) + recoveryDelayMs,
      };

      if (!(error instanceof OrganizationCasBusyError) || !error.definiteUnwritten) throw error;

      return organizationBusy(error, input.wake.sourceRefs);
    }
  }), async close() {
    closed = true;
    for (const entry of active.values()) entry.controller.abort("central_scope_owner_closed");
    await Promise.allSettled([...active.values()].map(entry => entry.promise));
    await tail;
  } };
}

function stateProgress(state: CentralLearningRuntimeState, now: number): CentralLearningDriverProgress {
  if (state.agendaRead !== undefined) return progress("ready", "central_agenda_source_read_pending");

  if (state.intents.some(row => row.continuation.kind === "ready")) return progress("ready", "central_committed_work_remaining");

  if (semanticRecovery(state, now) !== null) return progress("ready", "central_semantic_recovery_remaining");

  if (state.intents.length > 0 && state.running.length === 0 && state.intents.every(row => row.continuation.kind === "ended")) {
    return progress("ended", "central_current_investment_ended_goal_states_retained");
  }

  const deadlines = state.intents.flatMap(row => row.continuation.kind === "waiting" && row.continuation.wait.kind === "until"
    && row.continuation.wait.at > now ? [row.continuation.wait.at] : []);
  const recovery = semanticRecoveryAt(state, now);

  if (recovery !== undefined) deadlines.push(recovery);

  const waiting = progress("waiting", state.running.length > 0 ? "central_domain_work_running"
    : state.intents.some(row => row.continuation.kind === "open")
      && state.intents.every(row => row.continuation.kind === "open" || row.continuation.kind === "ended")
      ? "central_open_without_committed_successor" : "central_waiting_for_relevant_facts");

  return deadlines.length === 0 ? waiting : { ...waiting, wakeAt: Math.min(...deadlines) };
}
