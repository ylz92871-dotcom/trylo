import { LEARNING_DOMAINS } from "../../../control/contracts.js";
import {
  TOPIC_EVIDENCE_ORIGINS, TOPIC_LIMITS,
  type TopicDraft, type TopicQuestionDraft, type TopicExperimentDraft, type TopicGenerationDraft, type TopicExperimentDescriptor, type TopicExperimentContext, type TopicEvidenceWindow, type TopicResult,
} from "./contracts.js";
import { fields, identity, list, sequence, text as boundedText } from "./json-shape.js";

type Fields = Record<string, unknown>;

function text(value: unknown, maximum: number = TOPIC_LIMITS.statementChars): value is string {
  return boundedText(value, maximum);
}

export function parseTopicDraft(json: string): TopicResult<TopicDraft> {
  return parseDraft(json, isDraft);
}

export function parseTopicQuestionDraft(json: string): TopicResult<TopicQuestionDraft> {
  return parseDraft(json, isQuestionDraft);
}

export function parseTopicExperimentDraft(json: string): TopicResult<TopicExperimentDraft> {
  return parseDraft(json, (value): value is TopicExperimentDraft =>
    fields(value, ["schemaVersion", "question", "whenRelevant", "expectedChange", "citations", "experimentRef"])
    && value.schemaVersion === 3 && identity(value.experimentRef) && questionFields(value));
}

/** Separate closed transport shape: explicit legacy versions are never retried through this parser. */
export function parseTopicGenerationDraft(json: string): TopicResult<TopicGenerationDraft> {
  return parseDraft(json, (value): value is TopicGenerationDraft => {
    if (fields(value, ["kind", "reason"]) && value.kind === "no_topic") return text(value.reason);
    return fields(value, ["kind", "question", "whenRelevant", "expectedChange", "citations",
      ...(typeof value === "object" && value !== null && "experimentRef" in value ? ["experimentRef"] : [])])
      && value.kind === "topic" && questionFields(value)
      && (!("experimentRef" in value) || identity(value.experimentRef));
  });
}

function parseDraft<T>(json: string, guard: (value: unknown) => value is T): TopicResult<T> {
  if (typeof json !== "string" || json.length > TOPIC_LIMITS.proposalChars) return { ok: false, reason: "topic_input_size" };
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { return { ok: false, reason: "topic_json_invalid" }; }
  if (!guard(value)) return { ok: false, reason: "topic_shape_invalid" };
  return { ok: true, value };
}

type QuestionFields = Pick<TopicDraft, "question" | "whenRelevant" | "expectedChange" | "citations">;

function questionFields(value: Fields): value is Fields & QuestionFields {
  return text(value.question) && text(value.whenRelevant) && text(value.expectedChange)
    && list(value.citations, 1, TOPIC_LIMITS.citations) && value.citations.every(citation => fields(citation, ["evidenceRef", "quote"])
      && identity(citation.evidenceRef) && text(citation.quote, TOPIC_LIMITS.quoteChars));
}

function isQuestionDraft(value: unknown): value is TopicQuestionDraft {
  return fields(value, ["schemaVersion", "question", "whenRelevant", "expectedChange", "citations"])
    && value.schemaVersion === 2 && questionFields(value);
}

function isDraft(value: unknown): value is TopicDraft {
  if (!fields(value, ["schemaVersion", "question", "whenRelevant", "expectedChange", "citations", "alternatives", "discriminator"])
    || value.schemaVersion !== 1 || !questionFields(value) || !list(value.alternatives, 2, TOPIC_LIMITS.alternatives)) return false;

  if (!value.alternatives.every(alternative => fields(alternative, ["id", "explanation"])
    && identity(alternative.id) && text(alternative.explanation))) return false;

  const ids = value.alternatives.map(alternative => (alternative as Fields).id);
  if (new Set(ids).size !== ids.length) return false;

  const discriminator = value.discriminator;

  return fields(discriminator, ["observation", "hypothesisIds"]) && text(discriminator.observation)
    && list(discriminator.hypothesisIds, 2, ids.length)
    && new Set(discriminator.hypothesisIds).size === discriminator.hypothesisIds.length
    && discriminator.hypothesisIds.every(id => identity(id) && ids.includes(id));
}

export function parseTopicWindow(json: string): TopicResult<TopicEvidenceWindow> {
  if (typeof json !== "string" || json.length > TOPIC_LIMITS.windowChars) return { ok: false, reason: "topic_input_size" };
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { return { ok: false, reason: "topic_window_invalid" }; }
  if (!isWindow(value)) return { ok: false, reason: "topic_window_invalid" };
  return { ok: true, value };
}

export function isTopicExperimentDescriptor(experiment: unknown): experiment is TopicExperimentDescriptor {
  if (typeof experiment !== "object" || experiment === null || Array.isArray(experiment)) return false;
  return fields(experiment, ["ref", "version", "domain", "purpose",
    ...("conditionHash" in experiment ? ["conditionHash"] : []), ...("context" in experiment ? ["context"] : [])])
    && (!("conditionHash" in experiment) || (typeof experiment.conditionHash === "string" && /^[a-f0-9]{64}$/.test(experiment.conditionHash)))
    && (!("context" in experiment) || isTopicExperimentContext(experiment.context))
    && identity(experiment.ref) && identity(experiment.version)
    && LEARNING_DOMAINS.some(domain => domain === experiment.domain) && text(experiment.purpose, 160);
}

export function isTopicExperimentContext(value: unknown): value is TopicExperimentContext {
  return fields(value, ["decision", "observation"]) && text(value.decision, 160) && text(value.observation, 160);
}

export function freezeTopicExperimentDescriptor(value: TopicExperimentDescriptor): TopicExperimentDescriptor {
  return Object.freeze({ ...value, ...(value.context === undefined ? {} : { context: Object.freeze({ ...value.context }) }) });
}

function isWindow(value: unknown): value is TopicEvidenceWindow {
  const keys = ["schemaVersion", "domain", "scope", "boardSequence", "watermarks", "records"];
  if ((!fields(value, keys) && !fields(value, [...keys, "experiments"]))
    || value.schemaVersion !== 1 || !LEARNING_DOMAINS.some(domain => domain === value.domain)
    || !identity(value.scope) || !sequence(value.boardSequence)
    || !list(value.watermarks, 1, TOPIC_LIMITS.evidenceRecords)
    || !list(value.records, 1, TOPIC_LIMITS.evidenceRecords)) return false;

  if ("experiments" in value) {
    if (!list(value.experiments, 0, 8) || !value.experiments.every(isTopicExperimentDescriptor)) return false;
    if (new Set(value.experiments.map(experiment => (experiment as Fields).ref)).size !== value.experiments.length) return false;
  }

  const watermarks = new Map<string, number>();

  for (const watermark of value.watermarks) {
    if (!fields(watermark, ["runId", "throughSequence"]) || !identity(watermark.runId)
      || !sequence(watermark.throughSequence) || watermarks.has(watermark.runId)) return false;
    watermarks.set(watermark.runId, watermark.throughSequence);
  }

  const refs = new Set<string>(), coordinates = new Set<string>();
  let totalChars = 0;

  for (const record of value.records) {
    if (!fields(record, ["ref", "runId", "sequence", "scope", "origin", "text"])
      // Execution's AttemptSequencer starts at zero; preserve its first event coordinate exactly.
      || !identity(record.ref) || !identity(record.runId) || !sequence(record.sequence)
      || record.scope !== value.scope || !TOPIC_EVIDENCE_ORIGINS.some(origin => origin === record.origin)
      || !text(record.text, TOPIC_LIMITS.evidenceTextChars)) return false;

    const through = watermarks.get(record.runId), coordinate = JSON.stringify([record.runId, record.sequence]);
    if (through === undefined || record.sequence > through || refs.has(record.ref) || coordinates.has(coordinate)) return false;

    refs.add(record.ref);
    coordinates.add(coordinate);
    totalChars += record.text.length;

    if (totalChars > TOPIC_LIMITS.totalEvidenceChars) return false;
  }

  return true;
}
