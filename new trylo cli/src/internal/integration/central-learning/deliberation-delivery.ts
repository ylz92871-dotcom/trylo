import type { OrganizationRecallPacket } from "../../learning/central/organization/contracts.js";
import { isOrganizationRecord } from "../../learning/central/organization/validation.js";
import { isCentralUnreadNavigationMaterial, isCentralAgentResearchCapabilityMaterial } from "../../learning/central/runtime/material-role.js";
import { isCentralRuntimeEnvironmentCondition } from "./runtime-environment-condition.js";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, text } from "../../validation/json-shape.js";
import { isCentralLearningBudgetRootRef } from "../../learning/control/central-budget-parse.js";
import { isCentralBudgetLimitChange } from "../../learning/control/central-accounting-parse.js";
import { centralBudgetChangeSourceRef } from "./runtime-budget-source.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { readOrganizationPublicationCondition } from "./organization-publication-material.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { readOrganizationCandidateView, readOrganizationKnowledgeRevisionLocator, readOrganizationKnowledgeView } from "./organization-publication-view.js";
import { deliveredOrganizationRecallPacket } from "./runtime-organization-memory.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { selectedCentralSourceNotices, type CentralSourceCatalogNotice } from "./deliberation-source-notices.js";
import { selectedCentralNativeNotices, type CentralNativeChangeNotice } from "./deliberation-native-notices.js";
import { centralBusinessSourceDirectory, centralBusinessSourceBodyNotice, type CentralBusinessSourceDirectory } from "./deliberation-business-sources.js";
import { centralActionCorrectionMandatoryRefs } from "./runtime-action-correction.js";
import { centralOutputCapacityIncreaseOriginalOperation } from "./runtime-output-capacity-increase.js";
import { readProviderPositiveAdmissionMaterial } from "./runtime-provider-positive.js";
import { centralJudgmentControlRefs, isCentralJudgmentContextMaterial } from "../../learning/central/runtime/judgment.js";
import { isCentralSingleActionVersion } from "./change-single-action-version.js";
import { readCentralAdvisoryResultMaterial } from "../../learning/central/runtime/advisory-material.js";
import { unreviewedCentralAgendaReads } from "../../learning/central/runtime/working-set.js";

export interface CentralMaterialDelivery {
  readonly priority: number;
  readonly navigationOnly: boolean;
  readonly companionRefs: readonly string[];
  readonly packet?: OrganizationRecallPacket;
  readonly sourceNotices?: readonly CentralSourceCatalogNotice[];
  readonly nativeNotices?: readonly CentralNativeChangeNotice[];
  readonly businessSource?: CentralBusinessSourceDirectory;
  /** Complete host notice, explicitly excluding the unread feedback body. */
  readonly noticeBody?: true;
}

export function centralMaterialObject(material: CentralRuntimeMaterial): Record<string, unknown> | undefined {
  let value: unknown;
  try { value = JSON.parse(material.text); } catch { return undefined; } // Prose has no typed delivery metadata.
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const directoryRoles = new Set(["organization_feedback_relationship_catalog_not_read_body",
  "shared_original_cost_units_not_additive_decision_spend", "organization_retrieval_context_not_business_evidence",
  "organization_hypothesis_navigation_not_business_evidence", "original_report_catalog_not_read_body",
  "host_normal_turn_source_catalog_not_read_body"]);

/** Delivery importance follows the actual operation, returned sources and active
 * purpose. Neither a broad organization kind nor an unread directory is evidence. */
export function centralMaterialDeliveryPlan(request: CentralDeliberationRequest,
  materials: readonly CentralRuntimeMaterial[]): ReadonlyMap<string, CentralMaterialDelivery> {
  const objects = new Map(materials.map(material => [material.ref, centralMaterialObject(material)]));
  const capacityOriginal = centralOutputCapacityIncreaseOriginalOperation(request, materials);
  const actionCorrectionRefs = centralActionCorrectionMandatoryRefs(capacityOriginal === undefined ? request
    : { ...request, operation: capacityOriginal }, materials);
  const judgmentRefs = centralJudgmentControlRefs(materials);
  const active = request.state.intents.filter(intent => intent.continuation.kind !== "ended");
  const activeIds = new Set(active.map(intent => intent.intentId));
  const activeIssues = new Set(active.flatMap(intent => intent.subject.plane === "agent" ? [intent.subject.issueId] : []));
  const current = new Set(request.operation.sourceRefs);
  const relevant = new Set([...current, ...active.flatMap(intent => [intent.intentId, ...intent.sourceRefs,
    ...intent.knowledge.flatMap(knowledge => knowledge.sourceRefs), ...(intent.derivation?.parentRefs ?? []),
    ...(intent.continuation.kind === "waiting" ? intent.continuation.wait.sourceRefs : [])])]);
  const returned = [...request.state.completed].reverse().find(row => row.outcome === "returned");
  const readRefs = new Set(returned?.operation.kind === "read" ? [...returned.operation.refs, ...returned.resultRefs] : []);
  const unreviewed = new Set(unreviewedCentralAgendaReads(request.state).map(row => row.operation.operationId));
  const relevantRead = [...request.state.completed].reverse().find(row => row.outcome === "returned"
    && row.operation.kind === "read" && (current.has(row.operation.operationId) || row.resultRefs.some(ref => current.has(ref))
      || unreviewed.has(row.operation.operationId) && row.resultRefs.some(ref => relevant.has(ref))));
  const requiredReadResults = new Set(relevantRead?.resultRefs ?? []);
  const conditions = new Set(materials.filter(material => readOrganizationPublicationCondition(material, request.scope) !== undefined).map(row => row.ref));
  const associated = new Set<string>();

  for (const material of materials) {
    const rejection = readOrganizationPublicationRejection(material, request.scope);
    if (rejection === undefined || !conditions.has(rejection.conditionRef)) continue;

    associated.add(material.ref);

    for (const candidate of materials) {
      const head = readOrganizationKnowledgeView(candidate, request.scope);
      const proposal = readOrganizationCandidateView(candidate, request.scope);
      const locator = readOrganizationKnowledgeRevisionLocator(candidate, request.scope, materials);

      if (head?.factId === rejection.currentHeadFactId || proposal?.deliveryRef === rejection.deliveryRef
        && proposal.index === rejection.candidateIndex) associated.add(candidate.ref);

      if (locator?.factId === rejection.currentHeadFactId) {
        associated.add(candidate.ref);
        const fragmentRef = objects.get(candidate.ref)?.fragmentRef;
        if (typeof fragmentRef === "string") associated.add(fragmentRef);
      }
    }
  }

  return new Map(materials.map(material => {
    const object = objects.get(material.ref), exact = relevant.has(material.ref);
    const packet = deliveredOrganizationRecallPacket(material, request.scope, materials);
    const locator = readOrganizationKnowledgeRevisionLocator(material, request.scope, materials);
    const sourceNotices = selectedCentralSourceNotices(material, request.operation.sourceRefs);
    const nativeNotices = selectedCentralNativeNotices(material, request.operation.sourceRefs);
    const businessSource = centralBusinessSourceDirectory(material);
    const companionRefs = locator !== undefined && typeof object?.fragmentRef === "string" ? [object.fragmentRef]
      : packet === undefined ? [] : materials.filter(row => objects.get(row.ref)?.role === "organization_retrieval_context_not_business_evidence"
      && objects.get(row.ref)?.recallRef === packet.recallRef
      && canonicalJson(objects.get(row.ref)?.query) === canonicalJson(packet.query)).map(row => row.ref);
    const plan = (priority: number, navigationOnly = false, noticeBody = false): CentralMaterialDelivery =>
      ({ priority, navigationOnly, companionRefs, ...(packet === undefined ? {} : { packet }),
        ...(sourceNotices.length === 0 ? {} : { sourceNotices }), ...(nativeNotices.length === 0 ? {} : { nativeNotices }),
        ...(businessSource === undefined ? {} : { businessSource }), ...(noticeBody ? { noticeBody: true as const } : {}) });

    // Preparation is repeated before funding. Its own immutable navigation
    // already carries the selected native/report/business notice; repacking
    // must not demote it to an opaque address and lose that exact trigger.
    // This retains only navigation, never source-body or feedback authority.
    if (object?.role === "central_source_body_not_delivered"
      && material.ref === `central-source-navigation:${contentHashOf(object)}` && material.text === canonicalJson(object)
      && object.originalKind === material.kind && typeof object.originalRef === "string" && typeof object.readRef === "string"
      && typeof object.sourceHash === "string" && /^[a-f0-9]{64}$/.test(object.sourceHash)
      && Number.isSafeInteger(object.totalChars) && Number(object.totalChars) >= 0) {
      const notices = [...(Array.isArray(object.sourceNotices) ? object.sourceNotices : []),
        ...(Array.isArray(object.nativeChangeReads) ? object.nativeChangeReads : []), object.businessSource];
      if (notices.some(row => typeof row === "object" && row !== null && "noticeRef" in row
        && typeof row.noticeRef === "string" && current.has(row.noticeRef) && material.sourceRefs.includes(row.noticeRef))) {
        return [material.ref, plan(1, true, true)];
      }
    }

    // An unread feedback body's capacity notice is itself the current trigger.
    // Deliver its real read address and size, without claiming the original
    // feedback was read. Wrapping it in a generic address loses that trigger.
    if (material.kind === "organization" && fields(object, ["role", "readRef", "minimumCharacters", "explanation"])
      && object.role === "organization_feedback_not_delivered_capacity" && typeof object.readRef === "string"
      && Number.isSafeInteger(object.minimumCharacters) && Number(object.minimumCharacters) > 0
      && material.ref === `organization-capacity:${contentHashOf(material.text)}`
      && material.sourceRefs.includes(object.readRef) && current.has(object.readRef)) return [material.ref, plan(1, true, true)];

    // A review must receive exactly what its relevant read returned, including
    // a bounded page or navigation result when that was the actual result.
    // Another completed think cannot demote that dependency to an address.
    if (requiredReadResults.has(material.ref)) return [material.ref, plan(0)];

    const nativeFeedback = readOrganizationFeedbackMaterial(material, request.scope);

    // Reconsideration of an actual use/outcome must receive its exact native
    // feedback before optional owned-state/history consumes the wire allowance.
    if (nativeFeedback !== undefined && nativeFeedback.value.result.kind !== "cost"
      && (current.has(material.ref) || current.has(nativeFeedback.factId))) return [material.ref, plan(0)];

    const handoffResult = readCentralAdvisoryResultMaterial(material);
    if (handoffResult?.scope === request.scope && (current.has(material.ref)
      || handoffResult.entries.some(entry => entry.intentId !== null && activeIds.has(entry.intentId)))) return [material.ref, plan(0)];

    if (isCentralAgentResearchCapabilityMaterial(material)) return [material.ref, plan(0)];

    if (isCentralRuntimeEnvironmentCondition(material)) return [material.ref, plan(0)];

    if (fields(object, ["schemaVersion", "role", "rootRef", "change"]) && object.schemaVersion === 1
      && object.role === "original_root_budget_limit_change_not_business_evidence"
      && isCentralLearningBudgetRootRef(object.rootRef) && object.rootRef.scope === request.scope && isCentralBudgetLimitChange(object.change)
      && material.kind === "source" && material.text === canonicalJson(object)
      && material.ref === `central-runtime-constraint:${contentHashOf(material.text)}`
      && canonicalJson(material.sourceRefs) === canonicalJson([object.rootRef.budgetId,
        centralBudgetChangeSourceRef(object.rootRef.budgetId, object.change.changeId)])) return [material.ref, plan(0)];

    // A real connection change must carry its complete host condition into
    // reconsideration, just like the mounted runtime capabilities.
    if (object !== undefined && fields(object, ["role", "scope", "providerId", "model", "providerConnectionRef",
      ...(Object.hasOwn(object, "decisionFormat") ? ["decisionFormat"] : []),
      ...(Object.hasOwn(object, "decisionVersion") ? ["decisionVersion"] : [])])
      && object.role === "actual_provider_connection_not_business_evidence" && object.scope === request.scope
      && text(object.providerId, 512) && text(object.model, 512) && text(object.providerConnectionRef, 512)
      && (!Object.hasOwn(object, "decisionFormat") || object.decisionFormat === "action_tool" || object.decisionFormat === "action_json")
      && (!Object.hasOwn(object, "decisionVersion") || isCentralSingleActionVersion(object.decisionVersion))
      && material.kind === "source" && material.sourceRefs.length === 0 && material.text === canonicalJson(object)
      && material.ref === `central-runtime-constraint:${contentHashOf(material.text)}`) return [material.ref, plan(0)];

    if (isCentralJudgmentContextMaterial(material, judgmentRefs)) return [material.ref, plan(current.has(material.ref)
      || material.sourceRefs.some(ref => judgmentRefs.has(ref) && current.has(ref)) ? 1 : 3)];

    if (actionCorrectionRefs.has(material.ref)) return [material.ref, plan(0)];

    if (readProviderPositiveAdmissionMaterial(material, request.operation, request.scope) !== undefined) return [material.ref, plan(0)];

    if (object?.role === "PA_current_constraint_not_business_evidence" && typeof object.issueId === "string"
      && material.ref === `central-runtime-constraint:${contentHashOf(material.text)}`) {
      // A user's representative can change the current commitment. Being
      // non-business evidence does not make that governance decision optional.
      return [material.ref, exact || activeIssues.has(object.issueId) ? plan(0) : plan(5, true)];
    }

    if (material.ref.startsWith("central-semantic-attempt:") && object?.operationId === request.operation.operationId
      || conditions.has(material.ref) && request.operation.sourceRefs.includes(material.ref)) return [material.ref, plan(0)];

    if (conditions.has(material.ref) || associated.has(material.ref)) return [material.ref, plan(1)];

    // A just-returned explicit read must not become another unread directory.
    if (readRefs.has(material.ref) || !isCentralUnreadNavigationMaterial(material)
      && material.sourceRefs.some(ref => readRefs.has(ref))) return [material.ref, plan(1)];

    if (sourceNotices.length > 0) return [material.ref, plan(1, true)];

    if (material.ref.startsWith("central-runtime-native-catalog:")) return [material.ref, plan(nativeNotices.length > 0 ? 1 : 5, true)];

    if (businessSource !== undefined && request.operation.sourceRefs.some(ref => ref === material.ref
      || ref === businessSource.noticeRef)) return [material.ref, plan(1, true)];

    if (packet !== undefined && packet.entries.length > 0) {
      // The organization port just prepared this query for the current purpose.
      // Archived packets acquire the same opportunity only through an actual read.
      return [material.ref, plan(request.organization.some(row => row.ref === material.ref) || exact ? 1 : 3)];
    }

    const feedback = nativeFeedback?.value;
    if (feedback !== undefined) return [material.ref, plan(feedback.result.kind === "cost" ? 5
      : feedback.result.kind === "progress" ? 2 : 1, feedback.result.kind === "cost")];

    if (typeof object?.role === "string" && directoryRoles.has(object.role)) return [material.ref, plan(5, true)];

    if (object?.role === "original_organization_decision_not_business_evidence" && isOrganizationRecord(object.value)
      && object.value.kind === "decision") {
      const current = exact || activeIds.has(object.value.purposeRef) || object.value.stageRefs.includes(request.operation.operationId);
      return [material.ref, plan(current ? 2 : 5, !current)];
    }

    if (material.ref.startsWith("central-source-navigation:")) {
      if (object?.role !== "central_source_body_not_delivered" || typeof object.originalRef !== "string"
        || typeof object.deliveryPriority !== "number" || !Number.isSafeInteger(object.deliveryPriority)
        || object.deliveryPriority < 0 || object.deliveryPriority > 5) throw new CentralDeliberationError("central_deliberation_navigation_invalid");
      return [material.ref, plan(5, true)];
    }

    const currentBody = material.kind === "source" && !isCentralUnreadNavigationMaterial(material)
      && (current.has(material.ref) || material.sourceRefs.some(ref => current.has(ref))
        || current.has(centralBusinessSourceBodyNotice(material, materials) ?? ""));

    return [material.ref, plan(material.kind === "feedback" || currentBody ? 1
      : material.kind === "work_result" || exact || material.sourceRefs.some(ref => relevant.has(ref)) ? 2
        : material.kind === "source" ? 3 : 4)];
  }));
}
