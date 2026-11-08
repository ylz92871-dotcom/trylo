import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { canonicalObservations } from "../domain/inference-observations.js";
import { isCompilationApplied } from "../domain/compilation-review.js";
import { methodAdvertisedFeedbackRecords, methodIssueFeedbackTargets } from "./central-source.js";
import { methodCentralFeedbackChangesForIssue } from "./central-feedback-changes.js";
import { experienceViewOf } from "./experience-store.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";

type Selection = { readonly scope: string; readonly issueId: string; readonly nativeChanges?: readonly ContentDomainFeedbackChange[] };

/** The scope is the canonical issue scope. Its method condition scopeId is
 * decoded from the original source report, never supplied by another caller. */
export async function readMethodCentralFeedback(input: Selection & { readonly boardRoot: string }) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) throw new Error(`method_central_feedback:${loaded.reason}`);
  return methodCentralFeedbackFromBoard(loaded.state, input);
}

/** Read-only source projection. Delivery, adoption, execution and assessments
 * retain their original units; none establishes a counterfactual economic gain.
 * Full original payloads preserve conditions and late observation corrections. */
export function methodCentralFeedbackFromBoard(state: BoardState, selection: Selection) {
  const issue = state.learningIssues?.find(item => item.issueId === selection.issueId && item.scope === selection.scope);
  const selected = issue === undefined ? undefined : methodIssueFeedbackTargets(state, issue);

  if (issue === undefined) return undefined;

  // A supplied catalog row is navigation, not proof of ownership. Reuse the
  // native owner's exact per-issue index at this Board prefix before resolving it.
  const changeKey = (row: ContentDomainFeedbackChange) => canonicalJson({ domain: row.domain, issueId: row.issueId,
    kind: row.kind, factRef: row.factRef, unitRef: row.unitRef, revisionRef: row.revisionRef,
    sourceRefs: [...new Set(row.sourceRefs)].sort() });
  const supplied = selection.nativeChanges ?? [];
  const canonical = new Set(supplied.length === 0 ? [] : methodCentralFeedbackChangesForIssue(state, selection).map(changeKey));
  const advertised = methodAdvertisedFeedbackRecords(state, issue, supplied.filter(row => canonical.has(changeKey(row))));
  if (selected === undefined && advertised.length === 0) return undefined;

  const targets = selected?.targets ?? [];
  const view = experienceViewOf(state), records: JsonObject[] = [];
  const sourceRefs = new Set([issue.issueId, ...issue.reports.map(item => item.reportId), ...(selected?.sourceRefs ?? []), ...targets.map(item => item.versionId)]);
  const grant = state.centralLearningGrants?.find(item => item.issueId === issue.issueId && item.domain === "prompt" && item.scope === selection.scope);
  const versions = new Map(targets.map(item => [item.versionId, new Set([item.scopeId])])), compilations = new Set<string>();

  for (const fact of view.facts) {
    if (fact.kind !== "review" || !versions.get(fact.versionId)?.has(fact.scopeId)) continue;

    compilations.add(fact.factId);
    sourceRefs.add(fact.factId);
    const receipt = grant?.reservations.find(item => item.usage?.kind === "reported" && item.usage.model !== undefined
      && item.reservationId === shortId("method-review", [fact.snapshotId, item.usage.model]));
    if (receipt !== undefined && grant !== undefined) {
      sourceRefs.add(grant.grantId);
      sourceRefs.add(receipt.reservationId);
    }

    records.push({ kind: "method_review", unit: "method_review_proposal", factRef: fact.factId,
      revisionRef: `method-review:${contentHashOf(fact)}`, compilationApplied: isCompilationApplied(view.facts, fact),
      centralReservationRef: receipt?.reservationId ?? null, payloadJson: canonicalJson(fact) });

    if (fact.review.decision === "behavior" && fact.review.revisedMethod !== undefined) {
      const versionId = shortId("method-revision", [fact.versionId, fact.review.revisedMethod]);
      const child = view.variants.find(item => item.versionId === versionId && item.card.lineage.parentVersionId === fact.versionId
        && item.card.hint === fact.review.revisedMethod);
      if (child !== undefined) {
        versions.set(child.versionId, new Set([fact.scopeId]));
        sourceRefs.add(child.versionId);
        records.push({ kind: "method_behavior_revision", unit: "method_version_proposal", factRef: child.versionId,
          originatingReviewRef: fact.factId, revisionRef: child.versionId, payloadJson: canonicalJson(child.card) });
      }
    }
  }

  const belongs = (versionId: string, scopeId: string, compilationId?: string) => versions.get(versionId)?.has(scopeId) === true
    && (compilationId === undefined || compilations.has(compilationId));

  for (const fielding of state.fieldings) {
    if (!belongs(fielding.versionId, fielding.scope, fielding.binding?.compilationId)) continue;
    sourceRefs.add(fielding.exposureId);
    records.push({ kind: "method_delivery", unit: "method_provider_delivery", factRef: fielding.exposureId,
      revisionRef: fielding.exposureId, payloadJson: canonicalJson(fielding) });
  }

  for (const fact of view.facts) {
    const relevant = fact.kind === "decision" ? belongs(fact.versionId, fact.decision.scopeId, fact.decision.compilationId)
      : fact.kind === "execution" ? belongs(fact.versionId, fact.trace.scopeId, fact.trace.compilationId)
        : (fact.kind === "compilation_exit" || fact.kind === "restriction" || fact.kind === "scope_retired")
          ? belongs(fact.versionId, fact.scopeId) : fact.kind === "exit" && versions.has(fact.versionId)
            && (fact.scopeId === undefined || versions.get(fact.versionId)?.has(fact.scopeId));
    if (!relevant) continue;

    sourceRefs.add(fact.factId);
    records.push({ kind: `method_${fact.kind}`, unit: fact.kind === "execution" ? "method_associated_tool_execution"
      : fact.kind === "decision" ? "method_adoption_decision" : "method_lifecycle_fact", factRef: fact.factId,
      revisionRef: fact.factId, payloadJson: canonicalJson(fact) });
  }

  // Original corrections replace one assessment, not an extra independent trial.
  for (const observation of canonicalObservations(view.observations)) {
    if (!belongs(observation.versionId, observation.scopeId, observation.compilationId)) continue;

    // canonicalObservations retains the original row object. Its actual writer
    // relation survives multiple exposures in one opportunity; no tuple join.
    const exposureIds = [...new Set(state.feedbacks.flatMap(item => item.observation === observation && item.exposureId !== undefined ? [item.exposureId] : []))];
    const exposureId = exposureIds.length === 1 ? exposureIds[0] : undefined;

    sourceRefs.add(observation.observationId);

    if (exposureId !== undefined) sourceRefs.add(exposureId);

    records.push({ kind: "method_assessment", unit: "method_task_assessment", factRef: observation.observationId,
      revisionRef: `${observation.observationId}:revision:${observation.revision}`, revision: observation.revision,
      ...(exposureId === undefined ? {} : { exposureId }),
      source: observation.source, adoption: observation.adoption, outcome: observation.outcome,
      economicComparison: "unregistered", payloadJson: canonicalJson(observation) });
  }

  for (const record of advertised) {
    const existing = records.findIndex(row => row.kind === record.kind && row.factRef === record.factRef && row.revisionRef === record.revisionRef);
    if (existing < 0) records.push(record);
    else records[existing] = { ...records[existing]!, unitRef: record.unitRef!, sourceRefs: record.sourceRefs! };
    for (const ref of [record.factRef, record.revisionRef, record.exposureId]) if (typeof ref === "string") sourceRefs.add(ref);
  }

  const refs = [...sourceRefs].sort();

  return { sourceRef: `method-central-feedback:${contentHashOf({ issueId: issue.issueId, targets, records })}`,
    sourceRefs: refs, records };
}
