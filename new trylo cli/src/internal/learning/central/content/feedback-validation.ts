import type { RewardSource } from "../../reward/contracts.js";
import type { ContentFeedbackInput, ContentFeedbackObservation, FeedbackContentLink } from "./feedback-contracts.js";

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function texts(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(text); }

function source(value: RewardSource): boolean {
  return value !== null && typeof value === "object" && text(value.sessionId) && text(value.turnId)
    && text(value.attemptId) && text(value.eventId);
}

export function feedbackSourceKey(value: RewardSource): string {
  return JSON.stringify([value.sessionId, value.turnId, value.attemptId, value.eventId]);
}

export function feedbackLinkKey(value: Pick<FeedbackContentLink, "issueId" | "unitId" | "source">): string {
  return JSON.stringify([value.issueId, value.unitId, feedbackSourceKey(value.source)]);
}

function validLink(link: FeedbackContentLink): boolean {
  return link !== null && typeof link === "object" && text(link.issueId) && text(link.scope) && text(link.domain)
    && text(link.unitId) && source(link.source) && (link.topicId === undefined || text(link.topicId))
    && (link.exposureId === undefined || text(link.exposureId)) && texts(link.requirementRefs)
    && Array.isArray(link.artifactRefs) && link.artifactRefs.every(ref => ref !== null && typeof ref === "object"
      && text(ref.ref) && text(ref.version));
}

function validObservation(observation: ContentFeedbackObservation): boolean {
  if (observation === null || typeof observation !== "object" || !text(observation.id) || !text(observation.issueId)
    || !text(observation.unitId) || !source(observation.source) || !source(observation.observationSource)
    || !texts(observation.evidenceRefs) || observation.evidenceRefs.length === 0
    || !Number.isFinite(observation.observedAt) || observation.observedAt < 0
    || (observation.supersedes !== undefined && !text(observation.supersedes))) return false;
  switch (observation.kind) {
    case "task_result": return text(observation.requirementRef) && text(observation.measurementRef)
      && ["success", "failure", "partial", "unknown"].includes(observation.result);
    case "cost": return Number.isFinite(observation.quantity) && observation.quantity >= 0
      && text(observation.unit) && text(observation.metricRef) && text(observation.measurementRef);
    case "user_correction": return text(observation.text) && text(observation.targetRef)
      && ["same_requirement", "new_requirement", "unspecified"].includes(observation.targetRole);
    case "learning_gain": {
      const comparison = observation.comparison;
      return Number.isFinite(observation.value) && text(observation.metricRef) && comparison !== null
        && typeof comparison === "object" && text(comparison.baselineRef) && text(comparison.treatmentRef)
        && comparison.baselineRef !== comparison.treatmentRef && text(comparison.requirementRef)
        && text(comparison.windowRef) && text(comparison.conditionRef) && text(comparison.protocolRef)
        && texts(comparison.measurementRefs) && comparison.measurementRefs.length === 2;
    }
    default: return false;
  }
}

/** Fail closed on ambiguous identities rather than silently attaching a correction to another use. */
export function validateContentFeedbackInput(input: ContentFeedbackInput): void {
  if (!input || !Array.isArray(input.links) || !input.links.every(validLink)) throw new TypeError("invalid_content_feedback_links");

  if (input.links.length > 4096 || (input.observations?.length ?? 0) > 16384) throw new RangeError("content_feedback_capacity");

  const keys = input.links.map(feedbackLinkKey);
  if (new Set(keys).size !== keys.length) throw new RangeError("duplicate_content_feedback_link");

  if (input.observations !== undefined && !Array.isArray(input.observations)) throw new TypeError("invalid_content_feedback_observations");

  const seen = new Map<string, ContentFeedbackObservation>();
  const superseded = new Set<string>();

  for (const observation of input.observations ?? []) {
    if (!validObservation(observation)) throw new TypeError("invalid_content_feedback_observation");

    if (seen.has(observation.id)) throw new RangeError("duplicate_content_feedback_observation");

    if (observation.supersedes !== undefined) {
      const prior = seen.get(observation.supersedes);
      if (!prior || prior.kind !== observation.kind || feedbackLinkKey(prior) !== feedbackLinkKey(observation)
        || prior.observedAt > observation.observedAt || superseded.has(prior.id)) throw new RangeError("invalid_content_feedback_revision");
      superseded.add(prior.id);
    }

    seen.set(observation.id, observation);
  }

  const read = input.explanation;
  if (!read || read.schemaVersion !== 1 || typeof read.ok !== "boolean") throw new TypeError("invalid_content_feedback_explanation");

  if (!read.ok) {
    if (!text(read.reason)) throw new TypeError("invalid_content_feedback_failure");
    return;
  }

  if (!read.source || !text(read.source.sessionId) || !text(read.source.basisHash) || !text(read.source.decoder)
    || !Number.isSafeInteger(read.source.cohortThrough) || read.source.cohortThrough < 0
    || !Number.isSafeInteger(read.source.observedThrough) || read.source.observedThrough < read.source.cohortThrough
    || !Array.isArray(read.bindings) || !Array.isArray(read.questions)) throw new TypeError("invalid_content_feedback_position");

  const units = new Set<string>();

  for (const binding of read.bindings) {
    if (!binding || !binding.unit || !text(binding.unit.unitId) || !source(binding.source)
      || binding.source.sessionId !== read.source.sessionId || units.has(binding.unit.unitId)
      || !Number.isSafeInteger(binding.unit.registeredAt) || binding.unit.registeredAt < 0
      || binding.unit.registeredAt > read.source.cohortThrough) throw new TypeError("invalid_content_feedback_binding");

    if (binding.unit.status !== "pending" && (!["success", "failure", "other"].includes(binding.unit.status)
      || !Number.isSafeInteger(binding.unit.revealedAt) || binding.unit.revealedAt <= binding.unit.registeredAt
      || binding.unit.revealedAt > read.source.observedThrough)) throw new TypeError("invalid_content_feedback_report");

    if (binding.unit.status === "pending" && "revealedAt" in binding.unit) throw new TypeError("invalid_content_feedback_report");

    units.add(binding.unit.unitId);
  }

  if (read.reported?.schemaVersion !== 1 || read.reported.population !== read.bindings.length
    || read.reported.interpretation !== "reported_channel_only_not_task_quality_or_causal_credit") throw new TypeError("invalid_content_feedback_reported_population");

  if (!read.legacy || (read.legacy.status === "available" ? !Number.isSafeInteger(read.legacy.revision)
    || read.legacy.revision < 0 || !Array.isArray(read.legacy.units) : read.legacy.status !== "unavailable" || !text(read.legacy.reason))) {
    throw new TypeError("invalid_content_feedback_board_position");
  }

  if (!read.legacyRevision || (read.legacyRevision.status === "unavailable" && !text(read.legacyRevision.reason))
    || !["available", "unavailable"].includes(read.legacyRevision.status)) throw new TypeError("invalid_content_feedback_legacy_revision");

  if (read.legacyRevision.status === "available") {
    const revision = read.legacyRevision.value;
    if (!revision || !["none", "compared"].includes(revision.status)) throw new TypeError("invalid_content_feedback_legacy_revision");
    if (revision.status === "compared" && (!text(revision.unitId) || !source(revision.source)
      || !text(revision.feedbackId) || !text(revision.supersedes) || !Array.isArray(revision.targets))) {
      throw new TypeError("invalid_content_feedback_legacy_revision");
    }
  }
}
