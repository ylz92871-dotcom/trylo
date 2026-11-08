import type { TopicBudgetBid } from "../../../control/topic-bid.js";
import type { GroundedLearningTopic, TopicFailureReason } from "./contracts.js";
import { canonicalJson, contentHashOf } from "../../../control/hash.js";
import { INFORMATION_LIMITS, readInformationModel, type InformationModelFailure } from "./information-model.js";
import { planTopicInformation, type InformationPlan } from "./information-plan.js";
import { identity } from "./json-shape.js";
import { readTopicOpportunitySources, type TopicOpportunityInput } from "./opportunity-input.js";
import type { LearningDomain } from "../../../control/contracts.js";
import type { TopicExperimentBindingRecord } from "./experiment-binding.js";

export type { TopicOpportunityInput } from "./opportunity-input.js";

export type TopicRecommendation =
  | { readonly status: "stop" }
  | { readonly status: "invalid_quota" }
  | { readonly status: "question"; readonly topic: GroundedLearningTopic; readonly declaredNetValue: number };

export type TopicOpportunity =
  | { readonly status: "rejected"; readonly reason: TopicFailureReason | InformationModelFailure
      | "topic_model_binding" | "topic_opportunity_budget" }
  | { readonly status: "empty" }
  | { readonly status: "unvalued"; readonly reason: "topic_model_required" }
  | { readonly status: "planning_limit"; readonly nodes: number }
  | { readonly status: "offered"; readonly bid: TopicBudgetBid; recommend(quota: number): TopicRecommendation };

/** Domain-owned composition, not a provider call or an authorization to run a proposed discriminator. */
export function prepareTopicOpportunity(input: TopicOpportunityInput): TopicOpportunity {
  const nodeLimit = input.nodeLimit ?? 20000;
  if (!Number.isSafeInteger(input.maxQuota) || input.maxQuota < 0 || input.maxQuota > INFORMATION_LIMITS.quota
    || !Number.isSafeInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > INFORMATION_LIMITS.nodes
    || !identity(input.utilityUnit) || !identity(input.quotaUnit)
    || (input.probeBindingHash !== undefined && !/^[a-f0-9]{64}$/.test(input.probeBindingHash))
    || (input.modelProvenanceHash !== undefined && !/^[a-f0-9]{64}$/.test(input.modelProvenanceHash))
    || (input.domainDecisionHash !== undefined && !/^[a-f0-9]{64}$/.test(input.domainDecisionHash))
    || !validProvenance(input)
    || (input.valuationBoardSequence !== undefined && (!Number.isSafeInteger(input.valuationBoardSequence) || input.valuationBoardSequence < 0))) {
    return { status: "rejected", reason: "topic_opportunity_budget" };
  }

  const sources = readTopicOpportunitySources(input);
  if (sources.status !== "ready") return sources;

  const topics = sources.topics;
  if (topics.size === 0) return { status: "empty" };

  if (input.modelJson === null) return { status: "unvalued", reason: "topic_model_required" };

  const model = readInformationModel(input.modelJson);
  if (!model.ok) return { status: "rejected", reason: model.reason };

  if (model.model.questions.length !== topics.size || model.model.questions.some(question => !topics.has(question.id))) {
    return { status: "rejected", reason: "topic_model_binding" };
  }

  return buildOffer(input, model.model, topics, nodeLimit, sources.boardSequence, sources.domain!, sources.bindings);
}

function validProvenance(input: TopicOpportunityInput): boolean {
  if (input.modelProvenanceJson === undefined) return true;
  if (typeof input.modelProvenanceJson !== "string" || input.modelProvenanceJson.length > 32768 || input.modelProvenanceHash === undefined) return false;
  try { return contentHashOf(JSON.parse(input.modelProvenanceJson)) === input.modelProvenanceHash; }
  catch { return false; }
}

function buildOffer(input: TopicOpportunityInput, model: import("./information-model.js").InformationModel,
  topics: ReadonlyMap<string, GroundedLearningTopic>, nodeLimit: number, boardSequence: number,
  domain: LearningDomain, bindings: ReadonlyMap<string, TopicExperimentBindingRecord>): TopicOpportunity {
  const plans = new Map<number, Extract<InformationPlan, { status: "planned" }>>();
  const modelJson = canonicalJson(model);
  let nodes = 0;

  for (let quota = 0; quota <= input.maxQuota; quota += 1) {
    if (nodes === nodeLimit) return { status: "planning_limit", nodes };
    const plan = planTopicInformation(modelJson, quota, nodeLimit - nodes);
    if (plan.status === "invalid") return { status: "rejected", reason: "topic_model_invalid" };
    nodes += plan.nodes;
    if (plan.status === "planning_limit") return { status: "planning_limit", nodes };
    plans.set(quota, plan);
  }

  // Retain the first topic's original evidence basis; only the valuation prefix can advance.
  const first = topics.values().next().value!;
  const body = { schemaVersion: 1 as const, domain, scope: first.scope,
    basis: Object.freeze({ ...first.basis, boardSequence }),
    utilityUnit: input.utilityUnit, quotaUnit: input.quotaUnit, modelKind: "declared_finite_expected_utility" as const,
    curve: Object.freeze([...plans].map(([quota, plan]) => Object.freeze({ quota, netValue: plan.netGain }))) };
  const bid: TopicBudgetBid = Object.freeze({ ...body, valuationId: `topic-value:${contentHashOf({ ...body,
    model, topicIds: [...topics.keys()], probeBindingHash: input.probeBindingHash ?? null,
    ...(bindings.size === 0 ? {} : { experimentBindings: [...bindings.values()] }),
    ...(input.domainDecisionHash === undefined ? {} : { domainDecisionHash: input.domainDecisionHash }),
    ...(input.modelProvenanceHash === undefined ? {} : { modelProvenanceHash: input.modelProvenanceHash }) })}` });

  return Object.freeze({ status: "offered" as const, bid,
    recommend(quota: number): TopicRecommendation {
      if (!Number.isSafeInteger(quota) || !plans.has(quota)) return { status: "invalid_quota" };
      const plan = plans.get(quota)!;
      return plan.questionId === null ? { status: "stop" }
        : { status: "question", topic: topics.get(plan.questionId)!, declaredNetValue: plan.netGain };
    },
  });
}
