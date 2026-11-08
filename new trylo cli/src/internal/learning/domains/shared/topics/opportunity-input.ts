import { fields } from "./json-shape.js";
import type { GroundedLearningTopic, TopicEvidenceWindow, TopicFailureReason } from "./contracts.js";
import { INFORMATION_LIMITS } from "./information-model.js";
import { parseTopicWindow } from "./parse.js";
import { readTopicSubmission } from "./submission.js";
import type { LearningDomain } from "../../../control/contracts.js";
import { readTopicExperimentBindingRecord, freezeTopicExperimentBindingRecord, topicBindingMatchesSource,
  type TopicExperimentBindingRecord } from "./experiment-binding.js";

export type TopicOpportunityCandidate = { readonly proposalJson: string; readonly windowJson: string;
  /** A separately recorded host resolution; the original proposal and window remain unchanged. */
  readonly experimentBinding?: TopicExperimentBindingRecord };

export type TopicOpportunityCommonInput = {
  /** A trusted host model, separate from the model's semantic proposal. Null means unknown. */
  readonly modelJson: string | null;
  readonly utilityUnit: string; readonly quotaUnit: string; readonly maxQuota: number; readonly nodeLimit?: number;
  readonly probeBindingHash?: string; readonly valuationBoardSequence?: number;
  readonly modelProvenanceHash?: string; readonly modelProvenanceJson?: string; readonly domainDecisionHash?: string;
};

export type TopicOpportunityInput = TopicOpportunityCommonInput & (
  | { readonly proposals: readonly string[]; readonly windowJson: string; readonly candidates?: never }
  | { readonly candidates: readonly TopicOpportunityCandidate[]; readonly proposals?: never; readonly windowJson?: never }
);

export type GroundedOpportunityCandidate = TopicOpportunityCandidate & {
  readonly window: TopicEvidenceWindow; readonly topic: GroundedLearningTopic | null;
};

export type TopicOpportunitySources =
  | { readonly status: "ready"; readonly candidates: readonly GroundedOpportunityCandidate[];
      readonly windows: readonly TopicEvidenceWindow[]; readonly topics: ReadonlyMap<string, GroundedLearningTopic>; readonly boardSequence: number;
      readonly domain: LearningDomain | undefined; readonly bindings: ReadonlyMap<string, TopicExperimentBindingRecord> }
  | { readonly status: "rejected"; readonly reason: TopicFailureReason | "topic_model_binding" | "topic_opportunity_budget" };

/** Every proposal is grounded against its own unchanged window. No synthetic common evidence window is created. */
export function readTopicOpportunitySources(input: TopicOpportunityInput): TopicOpportunitySources {
  const rejected = (reason: Extract<TopicOpportunitySources, { status: "rejected" }>["reason"]): TopicOpportunitySources => ({ status: "rejected", reason });
  const multi = Object.hasOwn(input, "candidates"), windows: TopicEvidenceWindow[] = [];
  let sources: readonly TopicOpportunityCandidate[];

  if (multi) {
    if (Object.hasOwn(input, "proposals") || Object.hasOwn(input, "windowJson") || !Array.isArray(input.candidates)
      || input.candidates.length > INFORMATION_LIMITS.questions || !input.candidates.every(row => (fields(row, ["proposalJson", "windowJson"])
        || fields(row, ["proposalJson", "windowJson", "experimentBinding"]))
        && typeof row.proposalJson === "string" && typeof row.windowJson === "string")) return rejected("topic_opportunity_budget");
    sources = input.candidates;
  } else {
    if (!Array.isArray(input.proposals) || input.proposals.length > INFORMATION_LIMITS.questions || typeof input.windowJson !== "string") return rejected("topic_opportunity_budget");
    const window = parseTopicWindow(input.windowJson);
    if (!window.ok) return rejected(window.reason);
    windows.push(window.value);
    sources = input.proposals.map(proposalJson => ({ proposalJson, windowJson: input.windowJson! }));
  }

  const candidates: GroundedOpportunityCandidate[] = [], topics = new Map<string, GroundedLearningTopic>();
  const bindings = new Map<string, TopicExperimentBindingRecord>();
  let domain: LearningDomain | undefined;

  for (const source of sources) {
    const readWindow = parseTopicWindow(source.windowJson);
    if (!readWindow.ok) return rejected(readWindow.reason);

    const window = readWindow.value;

    if (multi) windows.push(window);

    const submission = readTopicSubmission(source.proposalJson, source.windowJson);
    if (!submission.ok) return rejected(submission.reason);

    const topic = submission.value.kind === "topic" ? submission.value.topic : null;

    if (windows[0]!.scope !== window.scope) return rejected("topic_model_binding");

    let binding: TopicExperimentBindingRecord | undefined;

    if (Object.hasOwn(source, "experimentBinding")) {
      binding = readTopicExperimentBindingRecord(source.experimentBinding);
      if (binding === undefined || topic === null || input.valuationBoardSequence === undefined
        || !topicBindingMatchesSource(binding, { ...source, topic }, input.valuationBoardSequence)) return rejected("topic_model_binding");
    }

    if (topic !== null) {
      const effectiveDomain = binding?.binding.domain ?? topic.domain;
      if ((domain !== undefined && domain !== effectiveDomain) || topics.has(topic.topicId)) return rejected("topic_model_binding");
      domain = effectiveDomain;
      topics.set(topic.topicId, topic);
      if (binding !== undefined) bindings.set(topic.topicId, freezeTopicExperimentBindingRecord(binding));
    }

    candidates.push(Object.freeze({ proposalJson: source.proposalJson, windowJson: source.windowJson, window, topic,
      ...(binding === undefined ? {} : { experimentBinding: bindings.get(topic!.topicId)! }) }));
  }

  const latest = windows.reduce((maximum, window) => Math.max(maximum, window.boardSequence), 0);
  if (input.valuationBoardSequence !== undefined && (!Number.isSafeInteger(input.valuationBoardSequence) || input.valuationBoardSequence < latest)) return rejected("topic_model_binding");

  return { status: "ready", candidates: Object.freeze(candidates), windows: Object.freeze(windows), topics,
    boardSequence: input.valuationBoardSequence ?? latest, domain, bindings };
}

/** Capture only the accepted union branch and known common fields before an asynchronous execution can begin. */
export function freezeTopicOpportunityInput(input: TopicOpportunityInput): TopicOpportunityInput | undefined {
  const sources = readTopicOpportunitySources(input);
  if (sources.status !== "ready") return undefined;

  const common: TopicOpportunityCommonInput = { modelJson: input.modelJson,
    utilityUnit: input.utilityUnit, quotaUnit: input.quotaUnit, maxQuota: input.maxQuota,
    ...(input.nodeLimit === undefined ? {} : { nodeLimit: input.nodeLimit }),
    ...(input.probeBindingHash === undefined ? {} : { probeBindingHash: input.probeBindingHash }),
    ...(input.valuationBoardSequence === undefined ? {} : { valuationBoardSequence: input.valuationBoardSequence }),
    ...(input.modelProvenanceHash === undefined ? {} : { modelProvenanceHash: input.modelProvenanceHash }),
    ...(input.modelProvenanceJson === undefined ? {} : { modelProvenanceJson: input.modelProvenanceJson }),
    ...(input.domainDecisionHash === undefined ? {} : { domainDecisionHash: input.domainDecisionHash }) };

  if (Object.hasOwn(input, "candidates")) return Object.freeze({ ...common,
    candidates: Object.freeze(sources.candidates.map(source => Object.freeze({ proposalJson: source.proposalJson, windowJson: source.windowJson,
      ...(source.experimentBinding === undefined ? {} : { experimentBinding: freezeTopicExperimentBindingRecord(source.experimentBinding) }) }))) });

  return Object.freeze({ ...common, proposals: Object.freeze([...input.proposals!]), windowJson: input.windowJson! });
}
