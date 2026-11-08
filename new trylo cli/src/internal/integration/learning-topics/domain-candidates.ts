import { canonicalJson } from "../../learning/control/hash.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { fields } from "../../validation/json-shape.js";
import type { TopicDomainModelCandidate } from "./domain-model.js";
import { topicBindingMatchesSource } from "../../learning/domains/shared/topics/experiment-binding.js";
import { topicExperimentBindings } from "./experiment-binding.js";

/** Rebuild each question from its own recorded evidence window, without merging or rewriting old knowledge. */
export function topicDomainCandidates(facts: readonly RewardV2Fact[], scope: string, domain: LearningDomain,
  boardSequence: number): readonly TopicDomainModelCandidate[] {
  const candidates: TopicDomainModelCandidate[] = [], seen = new Set<string>();
  const bindings = topicExperimentBindings(facts, scope);
  // A newly resolved question may predate the ordinary recent-fact window.
  // Recover its actual source fact; never recreate it with today's evidence prefix.
  const selectedFacts = new Set(facts.slice(-256).map(fact => fact.id));

  for (const record of bindings.filter(record => record.sequence <= boardSequence && record.binding.domain === domain).slice(-256)) {
    selectedFacts.add(record.binding.sourceFactId);
  }

  for (const fact of facts) {
    if (!selectedFacts.has(fact.id)) continue;

    if (fact.scope !== scope || fact.kind !== "opportunity" || fact.sequence > boardSequence) continue;

    const raw: unknown = JSON.parse(fact.payloadJson);
    if (!fields(raw, ["schemaVersion", "type", "proposal", "evidenceWindow"])
      || raw.schemaVersion !== 1 || raw.type !== "ws1_topic_candidate") continue;

    const proposalJson = canonicalJson(raw.proposal), windowJson = canonicalJson(raw.evidenceWindow);
    const submission = readTopicSubmission(proposalJson, windowJson);
    if (!submission.ok || submission.value.kind !== "topic") continue;

    const topic = submission.value.topic;
    if (topic.scope !== scope || topic.basis.boardSequence > boardSequence || seen.has(topic.topicId)) continue;

    const original = { proposalJson, windowJson, topic };
    const matched = topic.schemaVersion === 2 ? bindings.filter(record => record.binding.sourceFactId === fact.id
      && topicBindingMatchesSource(record, original, boardSequence)) : [];
    if (matched.length > 1) throw new Error("topic_experiment_binding_conflict");

    const experimentBinding = matched[0];
    if ((experimentBinding?.binding.domain ?? topic.domain) !== domain) continue;

    seen.add(topic.topicId);
    candidates.push(Object.freeze({ ...original, ...(experimentBinding === undefined ? {} : { experimentBinding }) }));
  }

  return Object.freeze(candidates);
}
