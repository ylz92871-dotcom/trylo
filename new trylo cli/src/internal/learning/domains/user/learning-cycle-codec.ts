import { POLICY_DIMENSIONS, ELIGIBILITY_CLASSES, ELIGIBILITY_ROUTES } from "./contracts.js";
import type { UserCycleRecord, UserLearningVersion } from "./learning-cycle-contract.js";
import { boundedText as text, objectValue as object, stringList as refs } from "./semantic-draft.js";
import { sha256Hex } from "../shared/hash.js";

const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optional = (value: unknown): boolean => value === undefined || text(value);
const list = (value: unknown, guard: (item: unknown) => boolean, maximum = 32): boolean => Array.isArray(value) && value.length <= maximum && value.every(guard);
const confidence = (value: unknown): boolean => object(value) && number(value.score) && value.score <= 1 && ["low", "medium", "high"].includes(String(value.band));

function eligibility(value: unknown): boolean {
  return object(value) && text(value.id) && refs(value.sourceEvidenceIds) && ELIGIBILITY_CLASSES.some(item => item === value.classification)
    && ELIGIBILITY_ROUTES.some(item => item === value.route) && text(value.rationale) && refs(value.alternativeExplanations) && number(value.createdAt);
}

function conclusion(value: unknown): boolean {
  return object(value) && [value.id, value.userId, value.statement, value.scopeFingerprint, value.stableKey].every(item => text(item))
    && POLICY_DIMENSIONS.some(item => item === value.dimension) && refs(value.supporting) && refs(value.counter) && refs(value.contextual)
    && number(value.strength) && value.strength <= 1 && ["emerging", "stable", "drifting", "disputed"].includes(String(value.temporalState))
    && ["active", "superseded", "retired"].includes(String(value.status)) && number(value.version) && number(value.createdAt) && number(value.updatedAt);
}

function model(value: unknown): boolean {
  return object(value) && [value.id, value.userId, value.statement, value.scopeFingerprint, value.stableKey].every(item => text(item))
    && POLICY_DIMENSIONS.some(item => item === value.dimension) && confidence(value.truth) && confidence(value.scope)
    && ["unknown", "helpful", "harmful", "mixed"].includes(String(value.effectiveness))
    && ["unconfirmed", "user_confirmed", "cognition_confirmed", "behavior_confirmed"].includes(String(value.confirmation))
    && ["D0", "D1", "D2"].includes(String(value.distance)) && refs(value.alternativeExplanations) && refs(value.derivedFromConclusionIds)
    && refs(value.counterevidence) && ["active", "disputed", "superseded", "retired"].includes(String(value.status))
    && number(value.version) && number(value.createdAt) && number(value.updatedAt);
}

function policy(value: unknown): boolean {
  if (!object(value) || !object(value.rule) || !refs(value.includeTerms) || !refs(value.excludeTerms) || !text(value.applicability)) return false;
  const rule = value.rule;
  return [rule.id, rule.bundleId, rule.instruction].every(item => text(item)) && POLICY_DIMENSIONS.some(item => item === rule.domain)
    && rule.kind === "prompt_directive" && ["soft", "advisory", "strong_default"].includes(String(rule.strength))
    && ["explicit", "inferred"].includes(String(rule.originMark)) && refs(rule.sourceUserModelIds) && refs(rule.sourceConclusionIds)
    && refs(rule.sourceEvidenceIds) && refs(rule.sourceCommitmentIds) && rule.status === "active" && number(rule.version) && number(rule.createdAt);
}

export function isUserLearningVersion(value: unknown): value is UserLearningVersion {
  if (!object(value) || value.schemaVersion !== 1 || ![value.versionId, value.questionRef, value.sourcePrefixRef, value.scopeFingerprint, value.bundleChecksum].every(item => text(item))
    || !(value.availability === undefined || value.availability === "candidate" || value.availability === "ready")
    || !optional(value.previousVersionId) || !refs(value.evidenceIds, 32768) || !list(value.eligibility, eligibility, 32768)
    || !list(value.conclusions, conclusion, 4096) || !list(value.models, model, 4096) || !list(value.policies, policy, 4096) || !number(value.at)) return false;

  if (value.revisions !== undefined && !list(value.revisions, item => object(item)
    && [item.ruleId, item.evidenceId, item.quote, item.reason].every(value => text(value))
    && (item.action === "pause" || item.action === "replace"))) return false;

  // The body is fully guarded above. Check content integrity as well as structure at the read boundary.
  const version = value as UserLearningVersion;

  return version.bundleChecksum === sha256Hex(JSON.stringify(version.policies.map(item => [item.rule.id, item.rule.instruction])))
    && version.policies.every(item => item.rule.bundleId === version.versionId && item.rule.sourceEvidenceIds.every(id => version.evidenceIds.includes(id))
      && item.rule.sourceUserModelIds.every(id => version.models.some(model => model.id === id)));
}

export function isUserCycleRecord(value: unknown): value is UserCycleRecord {
  if (!object(value)) return false;

  if (value.record === "learning_version") return isUserLearningVersion(value.version);

  if (value.record === "learning_progress") {
    const progress = value.progress;
    return object(progress) && progress.schemaVersion === 1 && [progress.questionRef, progress.sourcePrefixRef, progress.scopeFingerprint,
      progress.understanding, progress.remaining, progress.nextAction].every(item => text(item)) && number(progress.step) && number(progress.at)
      && ["continue", "clarification", "completed", "no_result", "unknown"].includes(String(progress.state))
      && optional(progress.versionId) && optional(progress.workRef) && optional(progress.clarification)
      && (progress.consumedEvidenceIds === undefined || refs(progress.consumedEvidenceIds, 32768))
      && (progress.committedReservationIds === undefined || refs(progress.committedReservationIds, 32));
  }

  if (value.record === "policy_fielding") {
    const fielding = value.fielding;
    return object(fielding) && [fielding.receiptId, fielding.versionId, fielding.scopeFingerprint, fielding.attemptId, fielding.turnId].every(item => text(item))
      && refs(fielding.ruleIds) && fielding.ruleIds.length > 0 && number(fielding.beat) && number(fielding.at);
  }

  if (value.record === "policy_feedback") {
    const feedback = value.feedback;
    return object(feedback) && [feedback.feedbackId, feedback.sourceEventId, feedback.receiptId, feedback.versionId, feedback.scopeFingerprint].every(item => text(item))
      && optional(feedback.sourceEvidenceId) && refs(feedback.ruleIds) && number(feedback.at)
      && ["explicit_helpful", "explicit_unhelpful", "correction", "rollback"].includes(String(feedback.signal))
      && ["observe", "pause"].includes(String(feedback.disposition));
  }

  return false;
}
