import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { readCentralRuntimePurposeHeads } from "../../learning/central/runtime/records.js";
import type { CentralAdvisoryPublish } from "./central-advisory-contracts.js";
import { readAppliedCentralAdvisoryDecisions } from "./central-advisory-applied-decisions.js";
import { centralAdvisoryKnowledgeHash, readCentralAdvisoryRecords } from "./central-advisory-records.js";
import { readCentralDeliberationDeliveriesFromFacts, type CentralDeliberationDelivery } from "./deliberation-receipts.js";

export interface CentralAdvisoryPublicationSource {
  readonly value: CentralAdvisoryPublish;
  readonly intent: CentralLearningIntentDraft;
  readonly knowledge: CentralLearningIntentDraft["knowledge"][number];
  readonly delivery: CentralDeliberationDelivery;
}

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** Original publication authority only. This does not trust stored access
 * summaries, decide current destination access, or classify a hypothesis as fact. */
export function readCentralAdvisoryPublicationSource(board: BoardState, scope: string,
  publicationRef: string): CentralAdvisoryPublicationSource | undefined {
  const facts = board.rewardV2Facts ?? [];
  const record = readCentralAdvisoryRecords(facts, scope, board.sequence).find(row => row.ref === publicationRef);
  if (record?.value.kind !== "publish") return undefined;

  const value = record.value;
  const decision = readAppliedCentralAdvisoryDecisions(facts, scope, board.sequence).find(row => row.appliedStateRef === value.appliedStateRef
    && row.appliedSequence === value.appliedSequence && row.deliveryRef === value.deliveryRef && row.decisionRef === value.decisionRef);
  if (decision === undefined || decision.request.budgetId !== value.budgetId
    || !decision.output.knowledgeHandoffs?.some(handoff => handoff.kind === "publish" && handoff.intentId === value.intentId
      && handoff.knowledgeHash === value.knowledgeHash && handoff.whenRelevant === value.whenRelevant && handoff.uncertainty === value.uncertainty)) return undefined;

  const purpose = readCentralRuntimePurposeHeads(facts.filter(fact => fact.sequence <= decision.appliedSequence), scope, decision.appliedSequence)
    .find(row => row.intent.intentId === value.intentId && row.factRef === value.purposeHeadRef);
  const knowledge = purpose?.intent.knowledge.find(entry => centralAdvisoryKnowledgeHash(entry) === value.knowledgeHash);
  if (purpose === undefined || knowledge === undefined || !same(purpose.intent.conditions, value.purposeConditions)
    || !same(knowledge, { statement: value.statement, conditions: value.conditions, sourceRefs: value.sourceRefs })) return undefined;

  const delivery = readCentralDeliberationDeliveriesFromFacts(facts, scope, board.sequence, [decision.deliveryRef])[0];

  return delivery === undefined ? undefined : { value, intent: purpose.intent, knowledge, delivery };
}
