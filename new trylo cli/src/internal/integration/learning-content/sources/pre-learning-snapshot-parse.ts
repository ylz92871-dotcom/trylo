import { ACTIVATION_POINTERS, ASSET_KINDS, JOB_STATES, LEARNING_DOMAINS } from "../../../learning/control/contracts.js";
import { coordinationScopeValid, isLearningIssueReport } from "../../../learning/control/coordination-parse.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { isCentralResponseTarget } from "../../../learning/control/decision/prediction-validation.js";
import { fields, sequence, text } from "../../../validation/json-shape.js";
import { createCentralResponseWindowDraft } from "../../learning-allocation/response-registration.js";
import { isCentralResponseProtocol } from "../../learning-allocation/response-protocol.js";
import { isCentralResponseWindow } from "../../learning-allocation/response-source.js";
import type { PreLearningSnapshotResult, PreLearningSourceSnapshot } from "./pre-learning-snapshot.js";

const ref = (value: unknown) => text(value, 512);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const array = (value: unknown, valid: (item: unknown) => boolean, maximum = 8192): value is unknown[] =>
  Array.isArray(value) && value.length <= maximum && value.every(valid);
const refs = (value: unknown): value is string[] => array(value, ref) && new Set(value).size === value.length;
const member = (values: readonly string[], value: unknown) => typeof value === "string" && values.includes(value);

function optionalFields(value: unknown, required: readonly string[], optional: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function catalog(value: unknown, valid: (item: unknown) => boolean, maximum: number): boolean {
  return fields(value, ["available", "selected", "omitted"]) && sequence(value.available) && sequence(value.omitted)
    && array(value.selected, valid, maximum) && value.available === value.selected.length + value.omitted;
}

function sourceReference(value: unknown): boolean {
  return fields(value, ["ref", "hash", "originalScope"]) && ref(value.ref) && hash(value.hash) && ref(value.originalScope);
}

function report(value: unknown): boolean {
  return fields(value, ["reportId", "reportHash", "source", "evidenceRefs"]) && hash(value.reportHash)
    // Reuse the original report owner's source union; this projection is only validation, never a new report.
    && isLearningIssueReport({ reportId: value.reportId, source: value.source, facts: [value.reportHash], evidenceRefs: value.evidenceRefs });
}

function asset(value: unknown): boolean {
  return fields(value, ["versionId", "kind", "originalScope", "contentHash", "parentVersionId", "proposalRef"])
    && [value.versionId, value.originalScope].every(ref) && member(ASSET_KINDS, value.kind) && hash(value.contentHash)
    && (value.parentVersionId === null || ref(value.parentVersionId)) && (value.proposalRef === null || ref(value.proposalRef));
}

function job(value: unknown): boolean {
  return fields(value, ["jobId", "originalScope", "domain", "attempt", "state", "observationRef", "originalDedupeKey"])
    && [value.jobId, value.originalScope, value.observationRef, value.originalDedupeKey].every(ref)
    && member(LEARNING_DOMAINS, value.domain) && member(JOB_STATES, value.state) && sequence(value.attempt);
}

function activation(value: unknown, through: number): boolean {
  return optionalFields(value, ["activationId", "scope", "assetKind", "pointer", "versionId", "boardSequence", "generation"],
    ["previousVersionId", "approvalRef", "breaker", "rollbackReason"])
    && [value.activationId, value.scope, value.versionId].every(ref) && member(ASSET_KINDS, value.assetKind)
    && member(ACTIVATION_POINTERS, value.pointer) && sequence(value.boardSequence) && value.boardSequence <= through && sequence(value.generation)
    && ["previousVersionId", "approvalRef", "rollbackReason"].every(key => !Object.hasOwn(value, key) || ref(value[key]))
    && (!Object.hasOwn(value, "breaker") || fields(value.breaker, ["open", "reason", "consecutiveFailures"])
      && typeof value.breaker.open === "boolean" && ref(value.breaker.reason) && sequence(value.breaker.consecutiveFailures));
}

function registration(value: unknown, through: number, scope: string): boolean {
  if (!fields(value, ["target", "window", "protocol", "factId"]) || !ref(value.factId) || !isCentralResponseTarget(value.target)
    || !isCentralResponseWindow(value.window, through, value.target) || value.window.boundary !== "complete"
    || value.window.opportunity.scope !== scope || value.protocol !== null && !isCentralResponseProtocol(value.protocol)) return false;

  const window = value.window;
  const original = createCentralResponseWindowDraft({ opportunity: window.opportunity, unitId: window.unitId,
    grantId: window.grantId, measurementIds: window.measurementIds, comparison: window.comparison }, value.target, value.protocol ?? undefined);

  return original.status === "ready" && original.value.id === value.factId;
}

function snapshotShape(value: unknown): value is PreLearningSourceSnapshot {
  if (!fields(value, ["schemaVersion", "kind", "snapshotId", "sourceHash", "knownAtBoardSequence", "scope", "issueId", "domain", "qualification",
    "originalFocus", "originalReports", "methodScope", "assets", "sourceJobs", "sourceFacts", "activePointers", "actualUses", "responseRegistrations", "missingSources", "sourceRefs"])
    || value.schemaVersion !== 1 || value.kind !== "pre_learning_source_snapshot" || !ref(value.snapshotId) || !hash(value.sourceHash)
    || !sequence(value.knownAtBoardSequence) || !coordinationScopeValid(value.scope) || !ref(value.issueId) || !member(LEARNING_DOMAINS, value.domain)
    || value.qualification !== "source_snapshot_not_counterfactual_or_learning_gain") return false;

  const through = value.knownAtBoardSequence, scope = value.scope;

  return fields(value.originalFocus, ["decisionRevision", "reasonHash", "sourceRefs"]) && sequence(value.originalFocus.decisionRevision)
    && value.originalFocus.decisionRevision > 0 && hash(value.originalFocus.reasonHash) && refs(value.originalFocus.sourceRefs)
    && catalog(value.originalReports, report, 16)
    && (value.methodScope === null || fields(value.methodScope, ["versionId", "scopeId"]) && ref(value.methodScope.versionId) && ref(value.methodScope.scopeId))
    && (value.domain === "prompt" || value.methodScope === null) && array(value.assets, asset) && array(value.sourceJobs, job)
    && array(value.sourceFacts, item => fields(item, ["ref", "sequence", "algorithmVersion", "payloadHash"])
      && ref(item.ref) && sequence(item.sequence) && item.sequence <= through && ref(item.algorithmVersion) && hash(item.payloadHash))
    && array(value.activePointers, item => activation(item, through))
    && fields(value.actualUses, ["methodFieldings", "toolUses", "rewardExposures"])
    && Object.values(value.actualUses).every(item => catalog(item, sourceReference, 32))
    && catalog(value.responseRegistrations, item => registration(item, through, scope), 16)
    && array(value.missingSources, item => fields(item, ["ref", "reason"]) && ref(item.ref)
      && member(["external_or_unknown_source", "active_asset_missing", "method_scope_unresolved", "source_report_catalog_omitted"], item.reason))
    && refs(value.sourceRefs) && value.sourceRefs.includes(value.issueId);
}

/** Persisted v1 snapshots carry only source coordinates and hashes. Unknown schema, shape or hash fails closed. */
export function isPreLearningSourceSnapshot(value: unknown): value is PreLearningSourceSnapshot {
  if (!snapshotShape(value)) return false;
  const { sourceHash, snapshotId, ...body } = value;
  return sourceHash === contentHashOf(body) && snapshotId === `pre-learning-source:${sourceHash}`;
}

export function readPreLearningSourceSnapshot(value: unknown): PreLearningSnapshotResult {
  return isPreLearningSourceSnapshot(value) ? { ok: true, value: freezePreLearningSourceSnapshot(structuredClone(value)) }
    : { ok: false, reason: "pre_learning_snapshot_invalid" };
}

/** Both the source builder and persistence reader use the same immutable transport contract. */
export function freezePreLearningSourceSnapshot(value: PreLearningSourceSnapshot): PreLearningSourceSnapshot {
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    Object.values(item).forEach(freeze);
    Object.freeze(item);
  };
  freeze(value);
  return value;
}
