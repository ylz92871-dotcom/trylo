import type { LearningAllocationOffer } from "../../../../control/allocation-contract.js";
import type { LearningIssue } from "../../../../control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { ExperienceReviewRequest } from "../experience-port.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { scopePredicateKey } from "../domain/scope-learning.js";
import { shortId } from "../../../../domains/shared/hash.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";
import type { BoardState } from "../../../../control/state.js";
import { readCentralMethodResearchCandidates } from "./central-research-candidate.js";
import { methodResearchIssueId, readMethodResearch } from "./central-research-records.js";
import { canonicalObservations } from "../domain/inference-observations.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";

const METHOD_REVIEW_POLICY = "qualified-experience-review-v1";

/** Stable algorithm/model identity is separate from this snapshot's private input. */
export function methodCentralStageIdentity(request: ExperienceReviewRequest, model: string, modelRef = model) {
  const stageRef = `method-stage:${request.snapshotId}:${contentHashOf(modelRef === model ? { request, model } : { request, model, modelRef })}`;
  const policyRef = methodCentralPolicyRef(model);
  const sourceBindingRef = methodCentralSourceBinding(request.versionId, request.scope.scopeId, request.snapshotId, stageRef);
  return { stageRef, policyRef, sourceBindingRef };
}

export function methodCentralPolicyRef(model: string): string {
  return `method-policy:${contentHashOf({ policy: METHOD_REVIEW_POLICY, model })}`;
}

/** Configuration identity defines transfer compatibility; it does not replace
 * the actual model name retained by the original provider/usage receipt. */
export function methodCentralPolicyFamilyRef(model: string, modelRef = model): string {
  return modelRef === model ? methodCentralPolicyRef(model)
    : `method-family:${contentHashOf({ policy: METHOD_REVIEW_POLICY, model, modelRef })}`;
}

/** Applicability is the original feature predicate, not the method/version or
 * this task's prose. An automatic version-specific enrollment gate supplies no
 * reusable task-environment class and therefore remains unidentified. */
export function methodCentralCondition(request: ExperienceReviewRequest) {
  const predicate = request.effectivePredicate ?? request.scope.predicate;
  const enrollmentFeature = `use_${shortId("s", [request.versionId])}`;
  if ([...predicate.all, ...predicate.exclude].some(literal => literal.feature === enrollmentFeature)) return undefined;
  const features: JsonObject = { kind: "method_effective_feature_predicate", all: predicate.all, exclude: predicate.exclude };
  return { ref: `method-condition:${contentHashOf(scopePredicateKey(predicate))}`,
    sourceRef: "trylo:method-effective-scope-predicate:v1", features };
}

export function methodCentralSourceBinding(versionId: string, scopeId: string, snapshotId: string, stageRef: string): string {
  return `method-source:${contentHashOf({ versionId, scopeId, snapshotId, stageRef })}`;
}

export function methodCentralSnapshotId(stageRef: string): string | undefined {
  return /^method-stage:(method-snapshot_[a-f0-9]{16}):[a-f0-9]{64}$/.exec(stageRef)?.[1];
}

/** Exact managed dispatch never focuses or funds again. The caller re-reads the
 * issue revision after the central application commits the original offer.
 */
export type ManagedMethodReview = {
  readonly issueId: string; readonly grantId: string; readonly expectedIssueRevision: number;
  readonly stageRef: string; readonly policyRef: string; readonly sourceBindingRef: string;
  readonly offer: LearningAllocationOffer;
  readonly sourceContext?: CentralLearningSourceContext;
};

export function methodFocusedTarget(issue: LearningIssue) {
  const reports = issue.reports.filter(item => "subsystem" in item.source && item.source.subsystem === "method");
  const versions = new Set(reports.map(item => "versionId" in item.source ? item.source.versionId : undefined));
  const scopes = new Set(reports.flatMap(item => item.facts.filter(fact => fact.startsWith("scope:")).map(fact => fact.slice(6))));
  const versionId = [...versions][0], scopeId = [...scopes][0];
  return reports.length === issue.reports.length && versions.size === 1 && scopes.size === 1 && versionId !== undefined && scopeId
    ? { versionId, scopeId } : undefined;
}

/** Feedback follows actual native candidate lineage. Research reception does
 * not manufacture a method version or change the qualified-review selector. */
export function methodIssueFeedbackTargets(state: BoardState, issue: LearningIssue) {
  const focused = methodFocusedTarget(issue);
  if (focused !== undefined) return { targets: [focused], sourceRefs: [] as readonly string[] };

  const report = issue.reports[0];
  if (report === undefined || !("kind" in report.source) || report.source.kind !== "research_request" || report.source.domain !== "prompt") return undefined;

  const { requestRef, intentRef } = report.source;

  if (issue.issueId !== methodResearchIssueId(requestRef) || issue.reports.some(item => !("kind" in item.source)
    || item.source.kind !== "research_request" || item.source.domain !== "prompt" || item.source.requestRef !== requestRef
    || item.source.intentRef !== intentRef)) return undefined;

  const history = readMethodResearch(state, issue.scope, requestRef);
  if (history === undefined || history.request.intentRef !== intentRef) return undefined;

  const candidates = readCentralMethodResearchCandidates(state, issue.scope, requestRef);
  if (candidates.length === 0) return undefined;

  return { targets: candidates.map(item => ({ versionId: item.versionId, scopeId: item.scopeId })),
    sourceRefs: [...new Set([requestRef, intentRef, history.requestId, ...candidates.flatMap(item => item.sourceRefs)])] };
}

/** Metadata selects exact native units at this same loaded Board prefix. It
 * cannot supply a missing payload, infer a writer or turn an assessment into a
 * new use. Child-card lineage is owned by the original metadata producer. */
export function methodAdvertisedFeedbackRecords(state: BoardState, issue: LearningIssue,
  changes: readonly ContentDomainFeedbackChange[]): readonly JsonObject[] {
  const selected = changes.filter(row => row.domain === "prompt" && row.issueId === issue.issueId);
  if (selected.length === 0) return [];

  const records: JsonObject[] = [];
  const observations = canonicalObservations(state.feedbacks.flatMap(row => row.observation === undefined ? [] : [row.observation]));

  for (const change of selected) {
    if (change.kind === "delivery") {
      const fielding = state.fieldings.find(row => row.exposureId === change.factRef);
      if (fielding === undefined || change.unitRef !== fielding.exposureId || change.revisionRef !== fielding.exposureId) continue;
      records.push({ kind: "method_delivery", unit: "method_provider_delivery", factRef: fielding.exposureId,
        unitRef: fielding.exposureId, revisionRef: fielding.exposureId, sourceRefs: [...new Set(change.sourceRefs)], payloadJson: canonicalJson(fielding) });
      continue;
    }

    const fact = state.methodExperienceFacts?.find(row => row.factId === change.factRef);
    if (fact !== undefined && change.revisionRef === fact.factId) {
      const decision = fact.kind === "decision", lifecycle = ["restriction", "scope_retired", "compilation_exit", "exit"].includes(fact.kind);
      const kind = decision && fact.decision.action === "adopt" ? "adoption" : "correction";
      const unitRef = decision ? fact.factId : "compilationId" in fact ? fact.compilationId : fact.versionId;
      if ((!decision && !lifecycle) || change.kind !== kind || change.unitRef !== unitRef) continue;
      records.push({ kind: `method_${fact.kind}`, unit: decision ? "method_adoption_decision" : "method_lifecycle_fact",
        factRef: fact.factId, unitRef, revisionRef: fact.factId, sourceRefs: [...new Set(change.sourceRefs)], payloadJson: canonicalJson(fact) });
      continue;
    }

    const observation = observations.find(row => row.observationId === change.factRef
      && change.revisionRef === `${row.observationId}:revision:${row.revision}`);
    if (observation === undefined || change.kind !== (observation.revision === 0 ? "quality" : "correction")) continue;

    const exposures = [...new Set(state.feedbacks.flatMap(row => row.observation === observation
      && row.exposureId !== undefined ? [row.exposureId] : []))];
    const exposureId = exposures.length === 1 ? exposures[0] : undefined;
    const delivered = state.fieldings.find(row => row.exposureId === exposureId);
    if (exposureId === undefined || change.unitRef !== exposureId || delivered?.versionId !== observation.versionId
      || delivered.scope !== observation.scopeId) continue;

    records.push({ kind: "method_assessment", unit: "method_task_assessment", factRef: observation.observationId,
      unitRef: exposureId, revisionRef: change.revisionRef, revision: observation.revision, exposureId, sourceRefs: [...new Set(change.sourceRefs)],
      source: observation.source, adoption: observation.adoption, outcome: observation.outcome,
      economicComparison: "unregistered", payloadJson: canonicalJson(observation) });
  }

  return records;
}
