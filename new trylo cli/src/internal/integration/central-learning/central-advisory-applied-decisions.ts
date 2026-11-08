import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { lookupCentralRuntimeRecords, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { isCentralCompletedOperation } from "../../learning/central/runtime/validation.js";
import { readCentralDeliberationDeliveriesFromFacts } from "./deliberation-receipts.js";

export interface AppliedCentralAdvisoryDecision {
  readonly appliedStateRef: string;
  readonly appliedSequence: number;
  readonly deliveryRef: string;
  readonly decisionRef: string;
  readonly request: CentralDeliberationRequest;
  readonly output: CentralDeliberationOutput;
}

/** Recover decisions only from the original applied agenda checkpoint.
 * A saved response or a late record-only completion is not an applied decision.
 * The native readers authenticate the whole chain and each immutable delivery;
 * this projection neither writes a pending ledger nor changes any purpose. */
export function readAppliedCentralDecisions(facts: readonly RewardV2Fact[], scope: string,
  boardSequence: number): readonly AppliedCentralAdvisoryDecision[] {
  const considerations = readCentralRuntimeRecords(facts, scope, boardSequence).history.consideredDeliveries ?? [];
  if (considerations.length === 0) return [];

  const completed = lookupCentralRuntimeRecords(facts, scope, boardSequence, considerations.map(row => ({
    kind: "completed", operationId: row.operationId, factRef: row.factRef,
  })));
  const deliveries = readCentralDeliberationDeliveriesFromFacts(facts, scope, boardSequence,
    considerations.map(row => row.deliveryRef));
  const byId = new Map(facts.map(fact => [fact.id, fact]));
  const decisions: AppliedCentralAdvisoryDecision[] = [];

  for (const [index, consideration] of considerations.entries()) {
    const original = completed[index], delivery = deliveries[index];
    const appliedFact = byId.get(consideration.factRef), deliveryFact = byId.get(consideration.deliveryRef);
    if (original?.status !== "found" || !isCentralCompletedOperation(original.value) || delivery === undefined
      || appliedFact?.sequence !== consideration.sequence || deliveryFact === undefined
      || deliveryFact.sequence >= consideration.sequence) throw new Error("central_advisory_applied_receipt_binding_invalid");

    const value = original.value, { request, output } = delivery;
    const resultRef = `central-deliberation-result:${contentHashOf(output)}`;
    const opportunityRefs = [...new Set(request.opportunities.map(row => row.sourceRef))];
    if (value.outcome !== "returned" || value.operation.kind !== "think"
      || request.scope !== scope || request.operation.operationId !== consideration.operationId
      || delivery.deliveryRef !== consideration.deliveryRef || original.factRef !== consideration.factRef
      || canonicalJson(value.operation) !== canonicalJson(request.operation)
      || value.publicResult !== output.publicExplanation || !value.resultRefs.includes(resultRef)
      || consideration.resultRef !== resultRef
      || canonicalJson(consideration.sourceRefs) !== canonicalJson(opportunityRefs)) {
      throw new Error("central_advisory_applied_decision_binding_invalid");
    }

    decisions.push({ appliedStateRef: consideration.factRef, appliedSequence: consideration.sequence,
      deliveryRef: consideration.deliveryRef, decisionRef: request.operation.operationId, request, output });
  }

  // Replay order is authoritative even after compaction: replaying an old
  // publish must never occur after a later applied withdrawal.
  return decisions.sort((left, right) => left.appliedSequence - right.appliedSequence);
}

/** Publication recovery is the handoff-bearing subset of authenticated applied decisions. */
export function readAppliedCentralAdvisoryDecisions(facts: readonly RewardV2Fact[], scope: string,
  boardSequence: number): readonly AppliedCentralAdvisoryDecision[] {
  return readAppliedCentralDecisions(facts, scope, boardSequence)
    .filter(row => row.output.knowledgeHandoffs !== undefined && row.output.knowledgeHandoffs.length > 0);
}
