import { contentHashOf, sha256Hex } from "../../../control/hash.js";
import type { GroundedTopic, GroundedQuestion, GroundedExperimentQuestion, TopicDraft, TopicEvidenceWindow, TopicResult } from "./contracts.js";
import { parseTopicDraft, parseTopicQuestionDraft, parseTopicExperimentDraft, parseTopicWindow } from "./parse.js";

/** Validates evidence coordinates, never the truth/usefulness/causality of a proposed explanation. */
export function groundLearningTopic(proposalJson: string, windowJson: string): TopicResult<GroundedTopic> {
  const window = parseTopicWindow(windowJson);
  if (!window.ok) return window;

  const draft = parseTopicDraft(proposalJson);
  if (!draft.ok) return draft;

  const grounded = groundCitations(draft.value, window.value);
  if (!grounded.ok) return grounded;

  const body = {
    schemaVersion: 1 as const, kind: "learning_topic" as const, status: "grounded_hypothesis" as const,
    domain: window.value.domain, scope: window.value.scope,
    basis: { boardSequence: window.value.boardSequence, evidenceWindowHash: contentHashOf(window.value) },
    question: draft.value.question, whenRelevant: draft.value.whenRelevant, expectedChange: draft.value.expectedChange,
    alternatives: draft.value.alternatives, discriminator: draft.value.discriminator, citations: grounded.value,
  };

  return { ok: true, value: freeze({ ...body, topicId: `topic:${contentHashOf(body)}` }) };
}

/** Anchors what is being asked without inventing hypotheses or treating a missing answer as invalid evidence. */
export function groundLearningQuestion(proposalJson: string, windowJson: string): TopicResult<GroundedQuestion> {
  const window = parseTopicWindow(windowJson);
  if (!window.ok) return window;

  const draft = parseTopicQuestionDraft(proposalJson);
  if (!draft.ok) return draft;

  const grounded = groundCitations(draft.value, window.value);
  if (!grounded.ok) return grounded;

  const body = { schemaVersion: 2 as const, kind: "learning_topic" as const, status: "grounded_question" as const,
    domain: window.value.domain, scope: window.value.scope,
    basis: { boardSequence: window.value.boardSequence, evidenceWindowHash: contentHashOf(window.value) },
    question: draft.value.question, whenRelevant: draft.value.whenRelevant, expectedChange: draft.value.expectedChange, citations: grounded.value };

  return { ok: true, value: freeze({ ...body, topicId: `topic:${contentHashOf(body)}` }) };
}

function groundCitations(draft: Pick<TopicDraft, "citations">, window: TopicEvidenceWindow): TopicResult<GroundedTopic["citations"]> {
  const citations: GroundedTopic["citations"][number][] = [], identities = new Set<string>();

  for (const citation of draft.citations) {
    const record = window.records.find(item => item.ref === citation.evidenceRef);
    if (record === undefined) return { ok: false, reason: "topic_evidence_missing" };

    const start = record.text.indexOf(citation.quote);
    if (start < 0) return { ok: false, reason: "topic_quote_missing" };

    if (record.text.indexOf(citation.quote, start + 1) >= 0) return { ok: false, reason: "topic_quote_ambiguous" };

    const end = start + citation.quote.length, identity = JSON.stringify([record.ref, start, end]);
    if (identities.has(identity)) return { ok: false, reason: "topic_citation_duplicate" };

    identities.add(identity);
    citations.push({ evidenceRef: record.ref, runId: record.runId, sequence: record.sequence,
      origin: record.origin, start, end, sourceHash: sha256Hex(record.text), quoteHash: sha256Hex(citation.quote) });
  }

  if (citations.every(citation => citation.origin === "model_proposal")) return { ok: false, reason: "topic_self_support_only" };

  return { ok: true, value: citations };
}

/** The model selects a host reference; the host retains experiment identity, domain and authority. */
export function groundLearningExperiment(proposalJson: string, windowJson: string): TopicResult<GroundedExperimentQuestion> {
  const window = parseTopicWindow(windowJson);
  if (!window.ok) return window;

  const draft = parseTopicExperimentDraft(proposalJson);
  if (!draft.ok) return draft;

  const experiment = window.value.experiments?.find(entry => entry.ref === draft.value.experimentRef);
  if (experiment === undefined) return { ok: false, reason: "topic_experiment_missing" };

  const grounded = groundCitations(draft.value, window.value);
  if (!grounded.ok) return grounded;

  const body = { schemaVersion: 3 as const, kind: "learning_topic" as const, status: "grounded_question" as const,
    domain: experiment.domain, scope: window.value.scope,
    basis: { boardSequence: window.value.boardSequence, evidenceWindowHash: contentHashOf(window.value) },
    question: draft.value.question, whenRelevant: draft.value.whenRelevant, expectedChange: draft.value.expectedChange,
    citations: grounded.value, experiment: { ref: experiment.ref, version: experiment.version,
      ...(experiment.conditionHash === undefined ? {} : { conditionHash: experiment.conditionHash }) } };

  return { ok: true, value: freeze({ ...body, topicId: `topic:${contentHashOf(body)}` }) };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
