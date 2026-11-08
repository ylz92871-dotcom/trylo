import { LEARNING_DOMAINS, type LearningDomain } from "../../../control/contracts.js";
import { canonicalJson, contentHashOf } from "../../../control/hash.js";
import type { GroundedExperimentQuestion, GroundedLearningTopic } from "./contracts.js";
import { fields, identity, sequence } from "./json-shape.js";
import { readTopicSubmission } from "./submission.js";

/** Immutable experiment selection for an existing question, never a grant or a rewritten question. */
export type TopicExperimentBinding = {
  readonly schemaVersion: 1; readonly sourceFactId: string; readonly sourcePayloadHash: string;
  readonly topicId: string; readonly scope: string; readonly domain: LearningDomain;
  readonly experiment: { readonly ref: string; readonly version: string; readonly conditionHash: string };
  readonly bindingBoardSequence: number; readonly resolverVersion: string; readonly sourceRef: string;
};

export type TopicExperimentBindingRecord = {
  readonly id: string; readonly sequence: number; readonly binding: TopicExperimentBinding;
};

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function bindingShape(value: unknown): value is TopicExperimentBinding {
  return fields(value, ["schemaVersion", "sourceFactId", "sourcePayloadHash", "topicId", "scope", "domain", "experiment",
    "bindingBoardSequence", "resolverVersion", "sourceRef"])
    && value.schemaVersion === 1 && [value.sourceFactId, value.topicId, value.scope, value.resolverVersion, value.sourceRef].every(identity)
    && hash(value.sourcePayloadHash) && LEARNING_DOMAINS.some(domain => domain === value.domain)
    && sequence(value.bindingBoardSequence) && fields(value.experiment, ["ref", "version", "conditionHash"])
    && identity(value.experiment.ref) && identity(value.experiment.version) && hash(value.experiment.conditionHash);
}

function frozenCopy(record: TopicExperimentBindingRecord): TopicExperimentBindingRecord {
  return Object.freeze({ id: record.id, sequence: record.sequence, binding: Object.freeze({ ...record.binding,
    experiment: Object.freeze({ ...record.binding.experiment }) }) });
}

/** This hash identifies the relation body independently of its Board position. */
export function topicExperimentBindingHash(record: TopicExperimentBindingRecord): string { return contentHashOf(record.binding); }

export function readTopicExperimentBindingRecord(value: unknown): TopicExperimentBindingRecord | undefined {
  if (!fields(value, ["id", "sequence", "binding"]) || !identity(value.id) || !bindingShape(value.binding) || !sequence(value.sequence)
    || value.sequence <= value.binding.bindingBoardSequence || value.id !== `topic-binding:${contentHashOf(value.binding)}`) return undefined;
  return frozenCopy({ id: value.id, sequence: value.sequence, binding: value.binding });
}

export function freezeTopicExperimentBindingRecord(record: TopicExperimentBindingRecord): TopicExperimentBindingRecord {
  const frozen = readTopicExperimentBindingRecord(record);
  if (frozen === undefined) throw new Error("topic_experiment_binding_invalid");
  return frozen;
}

/** Resolves execution ownership only; the Board/source matcher still proves the original payload. */
export function resolvedTopicExperiment(topic: GroundedLearningTopic, record?: TopicExperimentBindingRecord):
  ({ readonly domain: LearningDomain } & GroundedExperimentQuestion["experiment"]) | undefined {
  if (record === undefined) return topic.schemaVersion === 3 ? Object.freeze({ domain: topic.domain, ...topic.experiment }) : undefined;
  const binding = readTopicExperimentBindingRecord(record);
  return topic.schemaVersion === 2 && binding !== undefined && binding.binding.topicId === topic.topicId && binding.binding.scope === topic.scope
    ? Object.freeze({ domain: binding.binding.domain, ...binding.binding.experiment }) : undefined;
}

/** Regrounds the unchanged source. Execution owner may differ from the original question's domain. */
export function topicBindingMatchesSource(record: TopicExperimentBindingRecord, source: {
  readonly proposalJson: string; readonly windowJson: string; readonly topic: GroundedLearningTopic;
}, valuationBoardSequence: number): boolean {
  try {
    const binding = readTopicExperimentBindingRecord(record);
    if (binding === undefined || !sequence(valuationBoardSequence) || binding.sequence > valuationBoardSequence
      || source.topic.schemaVersion !== 2 || source.topic.topicId !== binding.binding.topicId || source.topic.scope !== binding.binding.scope
      || source.topic.basis.boardSequence > binding.binding.bindingBoardSequence) return false;

    const submission = readTopicSubmission(source.proposalJson, source.windowJson);
    if (!submission.ok || submission.value.kind !== "topic" || submission.value.topic.schemaVersion !== 2
      || canonicalJson(submission.value.topic) !== canonicalJson(source.topic)) return false;

    return binding.binding.sourcePayloadHash === contentHashOf({ schemaVersion: 1, type: "ws1_topic_candidate",
      proposal: JSON.parse(source.proposalJson) as unknown, evidenceWindow: JSON.parse(source.windowJson) as unknown });
  } catch { return false; }
}
