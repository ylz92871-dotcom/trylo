import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest,
  CentralLearningIntentDraft, CentralRuntimeMaterial, CentralRuntimeOrganizationPort } from "../../learning/central/runtime/contracts.js";
import type { OrganizationDecision, OrganizationExperienceUse, OrganizationFeedback, OrganizationRecallPacket,
  OrganizationRecallQuery } from "../../learning/central/organization/contracts.js";
import { createCentralOrganizationService, type CentralOrganizationOptions, type OrganizationPublication } from "./organization-service.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { createCentralOrganizationFeedbackRefresh } from "./organization-feedback.js";
import { buildCentralOrganizationRecallQuery } from "./runtime-organization-query.js";
import { isOrganizationRecallQuery } from "../../learning/central/organization/validation.js";
import { deliveredOrganizationRecallPacket, organizationRecallMaterialMatches, organizationRecallNavigationMaterial } from "./runtime-organization-memory.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readCentralRuntimeCompletedIndex, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { buildOrganizationRuntimeProgress, centralOrganizationDeliberationRef, organizationDecisionForOperation,
  projectOrganizationRuntimeProgress } from "./organization-feedback-runtime.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createRuntimeOrganizationKnowledgePublisher } from "./runtime-organization-publication.js";
import { ORGANIZATION_CAS_ATTEMPTS, OrganizationCasBusyError, publishOrganizationWithCas } from "./organization-cas.js";
import { createOrganizationPublicationProjection } from "./organization-publication-projection.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { rejectedOriginalScopeUseNote } from "./organization-query-legacy.js";

export interface CentralRuntimeOrganizationOptions extends CentralOrganizationOptions {
  readonly workspaceId?: string;
  readonly service?: ReturnType<typeof createCentralOrganizationService>;
  readonly refresh?: Pick<ReturnType<typeof createCentralOrganizationFeedbackRefresh>, "refresh">;
  /** Original owner observations retain their own unit and supersession identities.
   * A work return alone cannot supply measured cost, actual adoption or business gain. */
  readonly feedback?: (input: { readonly scope: string; readonly decisionRef: string;
    readonly completed: CentralCompletedOperation }, signal: AbortSignal) => Promise<readonly OrganizationFeedback[]>;
}

export class CentralRuntimeOrganizationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CentralRuntimeOrganizationError";
  }
}

const unique = (refs: readonly string[]) => [...new Set(refs)];
const fail = (reason: string): never => { throw new CentralRuntimeOrganizationError(reason); };

/** Organization views have a smaller envelope than the original runtime facts.
 * Omission is public, and the original operation/delivery remains addressable. */
function prose(text: string): string {
  return text.length <= 4096 ? text : `${text.slice(0, 3960)} [${text.length - 3960} original characters omitted; consult source references]`;
}

function statements(values: readonly string[]): readonly string[] {
  return values.length <= 32 ? values.map(prose)
    : [...values.slice(0, 31).map(prose), `${values.length - 31} further statements remain in the original runtime source.`];
}

function references(values: readonly string[]): readonly string[] {
  const refs = unique(values);
  return refs.length <= 64 ? refs : [...refs.slice(0, 63), `organization-source-set:${contentHashOf(refs)}`];
}

const originalReferences = (refs: readonly string[]) => refs.filter(ref => !ref.startsWith("organization-")
  && !ref.startsWith("central-organization-") && !ref.startsWith("central-runtime-purpose-"));
const conditionKeys = (intent: CentralLearningIntentDraft) => [`plane:${intent.subject.plane}`,
  ...(intent.subject.plane === "agent" ? [`domain:${intent.subject.domain}`] : []),
  ...intent.conditions.map(condition => `condition:${contentHashOf(condition)}`)];

function saved(result: OrganizationPublication): void {
  if (result.status !== "saved") fail(result.status === "rejected" ? result.reason : `organization_${result.status}`);
}

const progressValue = (feedback: OrganizationFeedback) => {
  const { supersedes: _revision, ...value } = feedback;
  return canonicalJson(value);
};

/** Binds runtime deliberation to the original Board organization service. It owns
 * neither a second memory nor a second learning/subsystem lifecycle. */
export function createCentralRuntimeOrganization(options: CentralRuntimeOrganizationOptions): CentralRuntimeOrganizationPort {
  const service = options.service ?? createCentralOrganizationService(options);
  const refresh = options.refresh ?? (options.workspaceId === undefined ? undefined
    : createCentralOrganizationFeedbackRefresh({ ...options, workspaceId: options.workspaceId, service }));
  const packets = new Map<string, OrganizationRecallPacket>();
  const feedbackMaterial = (factId: string, value: OrganizationFeedback) => createOrganizationFeedbackMaterial(options.scope, factId, value);
  const check = (scope: string, signal: AbortSignal) => {
    if (scope !== options.scope) fail("organization_scope_mismatch");
    if (signal.aborted) fail("organization_cancelled");
    if (!options.enabled()) fail("collect_disabled");
  };
  const publishKnowledge = createRuntimeOrganizationKnowledgePublisher(options, service, fail);
  const publicationReturns = createOrganizationPublicationProjection(options);

  return {
    async readPublicationCorrection(input, signal) {
      check(input.scope, signal);
      const active = new Set(input.state.intents.filter(intent => intent.continuation.kind !== "ended").map(intent => intent.intentId));
      if (active.size === 0) return [];

      const consumed = new Set(input.consumedSourceRefs);
      const eligible = new Map<string, readonly CentralRuntimeMaterial[]>();

      for (const row of await publicationReturns.list(signal, { consumedSourceRefs: input.consumedSourceRefs })) {
        check(input.scope, signal);

        if (!row.currentHeadUnchanged || consumed.has(row.condition.ref)) continue;

        const detail = readOrganizationPublicationRejection(row.detail, input.scope);
        if (detail === undefined) return fail("organization_publication_result_corrupt");

        if (detail.bindings.state !== "bound" || !detail.bindings.intentIds.some(id => active.has(id))) continue;

        // Keep the latest actually related detail for a stable cause. An earlier
        // unbound/withdrawn detail cannot hide a later related one.
        eligible.set(row.condition.ref, [row.condition, row.detail]);
      }

      return eligible.values().next().value ?? [];
    },

    async recall(input) {
      check(input.scope, input.signal);
      const active = input.state.intents.filter(intent => intent.continuation.kind !== "ended");
      const query = buildCentralOrganizationRecallQuery(input, options);
      const refreshed = await refresh?.refresh({ issueRefs: unique([...active.map(intent => intent.subject),
        ...input.opportunities.map(item => item.subject)].flatMap(subject => subject.plane === "agent" ? [subject.issueId] : [])),
        sourceRefs: unique([...query.sourceRefs, ...(input.materials ?? []).flatMap(material => [material.ref, ...material.sourceRefs])]) }, input.signal);

      check(input.scope, input.signal);

      if (refreshed !== undefined && refreshed.status !== "ready") return fail(refreshed.status === "rejected" ? refreshed.reason : `organization_feedback_${refreshed.status}`);

      const recalled = await service.prepareRecall(query, input.signal);

      check(input.scope, input.signal);

      if (recalled.status !== "ready") return fail(recalled.status === "rejected" ? recalled.reason : "organization_disabled");

      packets.clear();
      packets.set(recalled.packet.recallRef, recalled.packet);
      const queryText = canonicalJson({ role: "organization_retrieval_context_not_business_evidence", query: recalled.packet.query,
        recallRef: recalled.packet.recallRef });

      return [{ ref: recalled.packet.recallRef, kind: "organization", text: recalled.packet.materialJson,
        sourceRefs: unique([recalled.packet.recallRef, ...recalled.packet.entries.map(entry => entry.factId)]) },
      { ref: `organization-query:${contentHashOf(queryText)}`, kind: "organization", text: queryText,
        sourceRefs: recalled.packet.query.sourceRefs }, organizationRecallNavigationMaterial(),
      ...(refreshed?.status === "ready" ? refreshed.materials : [])];
    },

    async recordDecision(input, signal) {
      check(input.request.scope, signal);
      const role = input.role ?? (input.decisionRef === input.request.operation.operationId ? "deliberation" : "operation_expectation");
      if (role !== "deliberation" && role !== "operation_expectation") return fail("organization_decision_role_invalid");

      if (input.effects !== undefined && input.effects !== "record_only") return fail("organization_decision_effects_invalid");

      if (input.effects === "record_only" && (role !== "deliberation" || input.deliveryRef === undefined)) return fail("organization_record_only_delivery_required");

      if (role === "deliberation" && input.decisionRef !== input.request.operation.operationId) return fail("organization_deliberation_operation_mismatch");

      if (role === "operation_expectation" && input.output.intents.filter(intent => intent.continuation.kind === "ready"
        && intent.continuation.operation.operationId === input.decisionRef).length !== 1) return fail("organization_expectation_operation_mismatch");

      const publicationRef = role === "deliberation"
        ? centralOrganizationDeliberationRef(input.request.scope, input.request.operation.operationId) : input.decisionRef;
      const record = (use: OrganizationExperienceUse | null): OrganizationDecision => ({ ...decisionRecord({ ...input, role }, use), decisionRef: publicationRef });
      const current = await service.read();
      check(input.request.scope, signal);

      if (current.status !== "ready") return fail(current.status === "rejected" ? current.reason : "organization_disabled");

      let existing = current.projection.decisions.find(row => row.value.decisionRef === publicationRef);

      // A pre-role agenda may already use the raw operation ref. Reuse it only
      // when its complete frozen meaning matches this computation; an earlier
      // selected think expectation remains intact under that same raw ref.
      if (existing === undefined && role === "deliberation") {
        const legacy = current.projection.decisions.find(row => row.value.decisionRef === input.request.operation.operationId
          && row.value.purposeRef === input.request.operation.operationId);
        if (legacy !== undefined && canonicalJson(frozenChoice(legacy.value)) === canonicalJson(frozenChoice(record(legacy.value.experienceUse)))) existing = legacy;
      }

      if (existing !== undefined) {
        const candidate = record(existing.value.experienceUse);
        if (canonicalJson(frozenChoice(existing.value)) !== canonicalJson(frozenChoice(candidate))) {
          return fail("organization_decision_choice_conflict");
        }

        // Reconsideration may retain a pending operation. Its first freeze and
        // delivered experience remain immutable; another request is not another choice.
        return { status: "recorded", materials: await publishKnowledge(input, signal) };
      }

      let delivery: OrganizationExperienceUse | null = null;
      const deliveredMaterials = [...input.request.organization, ...input.request.materials, ...input.request.state.materials];

      if (input.effects !== "record_only" && input.deliveryRef !== undefined && input.output.organizationUse !== undefined) {
        const use = input.output.organizationUse;
        let packet = packets.get(use.recallRef);
        if (packet === undefined) {
          packet = deliveredMaterials.filter(material => material.ref === use.recallRef)
            .map(material => deliveredOrganizationRecallPacket(material, input.request.scope, deliveredMaterials))
            .find(candidate => candidate !== undefined);
        }

        if (packet === undefined) {
          const loaded = await service.read();
          check(input.request.scope, signal);
          if (loaded.status !== "ready") return fail(loaded.status === "rejected" ? loaded.reason : "organization_disabled");
          // A resumed exact decision reuses its original packet; do not reconstruct
          // its historical input from organization knowledge published afterwards.
          packet = loaded.projection.decisions.find(row => row.value.decisionRef === publicationRef)?.value.experienceUse?.packet;
        }

        if (packet === undefined) {
          const recalled = await service.prepareRecall(originalRecallQuery(input.request, options), signal);
          if (recalled.status === "ready") packet = recalled.packet;
        }

        if (packet === undefined || packet.recallRef !== use.recallRef) return fail("organization_delivered_packet_missing");

        if (!deliveredMaterials.some(material => organizationRecallMaterialMatches(packet, material))) return fail("organization_delivery_material_mismatch");

        delivery = { packet, deliveryRef: input.deliveryRef, changes: use.changes };
      }

      check(input.request.scope, signal);

      if (delivery !== null && (delivery.packet.scope !== input.request.scope
        || !deliveredMaterials.some(material => organizationRecallMaterialMatches(delivery.packet, material)))) fail("organization_delivery_material_mismatch");

      let decision = record(delivery);
      const rejectedUse = await rejectedOriginalScopeUseNote(decision, input, options, signal);

      check(input.request.scope, signal);

      if (rejectedUse !== undefined) {
        decision = { ...record(null), context: { ...decision.context, known: statements([rejectedUse, ...decision.context.known]) } };
      }

      saved(await publishOrganizationWithCas({ record: decision, phase: "publication", read: service.read,
        publish: service.freezeDecision, enabled: options.enabled, signal }));

      return { status: "recorded", materials: await publishKnowledge(input, signal) };
    },

    async recordResult(input, signal) {
      check(input.scope, signal);
      const progress = buildOrganizationRuntimeProgress(input.decisionRef, input.completed, input.scope);
      const frozen = await service.read();
      check(input.scope, signal);

      if (frozen.status !== "ready") return fail(frozen.status === "rejected" ? frozen.reason : "organization_disabled");

      // A native request may complete without a model's frozen organization
      // choice. Its canonical runtime completion is already retained; do not
      // invent an expectation or publish orphan organization feedback for it.
      // Archival repair uses this same eligibility rule when a choice exists.
      if (!frozen.projection.decisions.some(row => row.value.decisionRef === input.decisionRef
        && organizationDecisionForOperation(input.scope, row.value, input.completed.operation.operationId))) return [];

      const observed = await options.feedback?.(input, signal) ?? [];

      check(input.scope, signal);
      // This return is public progress only. Later owner feedback may supersede
      // its own original unit, without relabelling a worker return as adoption.
      const materials: CentralRuntimeMaterial[] = [];

      for (const feedback of [progress, ...observed]) {
        if (feedback.decisionRef !== input.decisionRef) fail("organization_feedback_decision_mismatch");

        let value = feedback;

        if (feedback === progress) {
          const current = await service.read();
          check(input.scope, signal);

          if (current.status !== "ready") return fail(current.status === "rejected" ? current.reason : "organization_disabled");

          const previous = current.projection.feedback.find(row => organizationFeedbackKey(row.value) === organizationFeedbackKey(feedback));
          if (previous !== undefined && progressValue(previous.value) === progressValue(feedback)) {
            materials.push(feedbackMaterial(previous.factId, previous.value));
            continue;
          }

          value = { ...feedback, supersedes: previous?.factId ?? null };
        }

        const result = await publishOrganizationWithCas({ record: value, phase: "result", read: service.read,
          publish: service.observe, enabled: options.enabled, signal });
        saved(result);

        if (result.status === "saved") materials.push(feedbackMaterial(result.factId, value));
      }

      return materials;
    },

    async recoverResults(input, signal) {
      check(input.scope, signal);
      const { loaded, current } = await (async () => {
        for (let attempt = 0; attempt < ORGANIZATION_CAS_ATTEMPTS; attempt++) {
          const loaded = await createBoardReader(options.boardRoot).load();
          check(input.scope, signal);
          if (!loaded.ok) return fail(loaded.reason);
          const current = await service.read();
          check(input.scope, signal);
          if (current.status !== "ready") return fail(current.status === "rejected" ? current.reason : "organization_disabled");
          if (current.revision === loaded.state.sequence) return { loaded, current };
        }
        throw new OrganizationCasBusyError("result");
      })();
      const heads = new Map(current.projection.feedback.map(row => [organizationFeedbackKey(row.value), row]));

      for (const feedback of projectOrganizationRuntimeProgress(loaded.state, current.projection)) {
        check(input.scope, signal);
        const result = await publishOrganizationWithCas({ record: feedback, phase: "result", read: service.read,
          publish: service.observe, enabled: options.enabled, signal });
        saved(result);
        if (result.status !== "saved") return fail("organization_runtime_feedback_unconfirmed");
        heads.set(organizationFeedbackKey(feedback), { factId: result.factId, sequence: result.revision, value: feedback });
      }

      const original = readCentralRuntimeRecords(loaded.state.rewardV2Facts ?? [], input.scope, loaded.state.sequence);
      const delivered = new Set(original.history.materials.map(row => row.ref));
      const completed = new Set(readCentralRuntimeCompletedIndex(loaded.state.rewardV2Facts ?? [], input.scope, loaded.state.sequence)
        .map(row => row.completed.operation.operationId));
      const decisions = new Map(current.projection.decisions.map(row => [row.value.decisionRef, row.value]));

      // If observe succeeded but the following runtime save did not, its original
      // fact is returned again. Prior archival delivery prevents compaction from
      // refilling working context on every drive; no new acknowledgement store.
      return [...heads.values()].filter(row => row.value.result.kind === "progress" && completed.has(row.value.unitRef)
        && organizationDecisionForOperation(input.scope, decisions.get(row.value.decisionRef), row.value.unitRef)
        && !delivered.has(row.factId) && !delivered.has(feedbackMaterial(row.factId, row.value).ref))
        .sort((a, b) => b.sequence - a.sequence).slice(0, 8)
        .map(row => feedbackMaterial(row.factId, row.value));
    },
  };
}

function frozenChoice(decision: OrganizationDecision) {
  return { purposeRef: decision.purposeRef, purpose: decision.context.purpose, conditionKeys: decision.context.conditionKeys,
    program: decision.program, expectedChange: decision.expectation.change, issueRefs: decision.issueRefs, stageRefs: decision.stageRefs };
}

function originalRecallQuery(request: CentralDeliberationRequest, options: CentralOrganizationOptions): OrganizationRecallQuery {
  for (const material of request.organization) {
    if (material.ref !== `organization-query:${contentHashOf(material.text)}`) continue;

    let parsed: unknown;

    try { parsed = JSON.parse(material.text); }
    catch { return buildCentralOrganizationRecallQuery(request, options); }

    if (typeof parsed === "object" && parsed !== null && "role" in parsed
      && parsed.role === "organization_retrieval_context_not_business_evidence" && "query" in parsed
      && isOrganizationRecallQuery(parsed.query)) return parsed.query;
  }
  return buildCentralOrganizationRecallQuery(request, options);
}

function continuationProgram(intent: CentralLearningIntentDraft): string {
  const continuation = intent.continuation;
  return continuation.kind === "ready" ? canonicalJson(continuation.operation)
    : continuation.kind === "waiting" ? canonicalJson(continuation.wait) : canonicalJson(continuation);
}

function decisionRecord(input: { readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput;
  readonly decisionRef: string; readonly role?: "operation_expectation" | "deliberation";
  readonly effects?: "record_only";
  readonly deliveryRef?: string }, experienceUse: OrganizationExperienceUse | null): OrganizationDecision {
  const intents = input.output.intents;
  const agenda = input.role === "deliberation" || input.role === undefined && input.decisionRef === input.request.operation.operationId;
  const selected = agenda ? undefined : intents.find(intent => intent.continuation.kind === "ready" && intent.continuation.operation.operationId === input.decisionRef);
  const continuation = selected?.continuation;
  const program = agenda ? canonicalJson({ kind: "agenda", operation: input.request.operation,
    publicExplanation: input.output.publicExplanation, alternatives: input.output.alternatives ?? [],
    choices: intents.map(intent => ({ intentId: intent.intentId, goal: intent.goal, continuation: intent.continuation })) })
    : selected === undefined ? "No current learning commitment was returned." : continuationProgram(selected);
  const active = input.request.state.intents.filter(intent => intent.continuation.kind !== "ended");

  return { kind: "decision", decisionRef: input.decisionRef,
    purposeRef: agenda ? input.request.operation.operationId : selected?.intentId ?? input.request.stateRef,
    context: { purpose: prose(agenda ? input.request.operation.purpose : selected?.goal ?? input.output.publicExplanation),
      conditionKeys: agenda ? unique(active.flatMap(conditionKeys)).slice(0, 32) : selected === undefined ? [] : unique(conditionKeys(selected)).slice(0, 32),
      known: statements(agenda ? [...(input.effects === "record_only" ? [
        "Recovered historical public delivery only: no historical downstream choice is executed or applied to the current agenda, and no historical organization knowledge is published.",
        "Historical experience-use claims remain in the immutable original delivery. experienceUse:null does not assert that no experience was read or used; it asserts no revalidated current-prefix experience-use claim here.",
      ] : []), ...active.flatMap(intent => intent.knowledge.map(item => item.statement))]
        : selected === undefined ? [] : [...selected.conditions.map(condition => `Original condition: ${condition}`), ...selected.knowledge.map(item => item.statement)]),
      residual: statements(agenda ? active.flatMap(intent => intent.residual) : selected?.residual ?? []) },
    program: { programRef: `central-organization-program:${contentHashOf(program)}`, depth: prose(program),
      timing: agenda || continuation?.kind === "ready" ? "now" : continuation?.kind === "waiting" ? "wait" : "stop" },
    expectation: { change: prose(agenda ? input.request.operation.expectedChange : continuation?.kind === "ready" ? continuation.operation.expectedChange
      : selected?.commitment.purpose ?? "No additional expenditure selected."),
      uncertainties: statements(agenda ? active.flatMap(intent => intent.commitment.assumptions) : selected?.commitment.assumptions ?? []) },
    alternatives: statements(input.output.alternatives ?? []),
    issueRefs: agenda ? references(intents.flatMap(intent => intent.subject.plane === "agent" ? [intent.subject.issueId] : [intent.subject.questionRef]))
      : selected === undefined ? [] : selected.subject.plane === "agent" ? [selected.subject.issueId] : [selected.subject.questionRef],
    stageRefs: agenda ? references(intents.flatMap(intent => intent.continuation.kind === "ready" ? [intent.continuation.operation.operationId] : []))
      : continuation?.kind === "ready" ? [continuation.operation.operationId] : [],
    sourceRefs: references(originalReferences([input.request.stateRef, input.request.operation.operationId, input.request.budgetId,
      centralDeliberationReservation(input.request), ...(input.deliveryRef === undefined ? [] : [input.deliveryRef]),
      ...(agenda ? [...input.output.sourceRefs, ...intents.flatMap(intent => intent.sourceRefs)] : selected?.sourceRefs ?? []),
      ...(continuation?.kind === "ready" ? continuation.operation.sourceRefs : [])])), experienceUse };
}
