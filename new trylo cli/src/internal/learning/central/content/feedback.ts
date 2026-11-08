import { contentHashOf } from "../../control/hash.js";
import type { LegacyFeedbackUnitExplanation, RewardExposureBinding } from "../../reward/explanation/explanation-policy.js";
import type { ContentFeedbackExplanation, ContentFeedbackInput, ContentFeedbackMaterial, ContentFeedbackObservation,
  ContentFeedbackObservationEntry, ContentFeedbackProjection, ContentFeedbackRow, FeedbackContentLink } from "./feedback-contracts.js";
import { feedbackLinkKey, feedbackSourceKey, validateContentFeedbackInput } from "./feedback-validation.js";

type AvailableExplanation = Extract<ContentFeedbackExplanation, { readonly ok: true }>;

type ReadIndex = { readonly bindings: ReadonlyMap<string, RewardExposureBinding>;
  readonly legacy: ReadonlyMap<string, LegacyFeedbackUnitExplanation> };

function observationsFor(observations: readonly ContentFeedbackObservation[]): readonly ContentFeedbackObservationEntry[] {
  const superseded = new Set(observations.flatMap(item => item.supersedes === undefined ? [] : [item.supersedes]));
  return observations.map(observation => ({ observation, state: superseded.has(observation.id) ? "superseded" : "active" }));
}

function association(link: FeedbackContentLink, binding: RewardExposureBinding | undefined): ContentFeedbackRow["association"] {
  if (!binding) return { status: "unlinked", reason: "unit_missing" };
  if (feedbackSourceKey(binding.source) !== feedbackSourceKey(link.source)) return { status: "unlinked", reason: "source_mismatch" };
  if (link.exposureId !== undefined && binding.exposureId !== link.exposureId) return { status: "unlinked", reason: "exposure_mismatch" };
  return { status: "linked", registeredAt: binding.unit.registeredAt };
}

function observationFacets(link: FeedbackContentLink, observations: readonly ContentFeedbackObservationEntry[], linked: boolean) {
  const active = observations.filter(item => item.state === "active").map(item => item.observation);
  const task = active.filter(item => item.kind === "task_result");
  const bound = task.filter(item => link.requirementRefs.includes(item.requirementRef));
  const qualified = bound.filter(item => item.result !== "unknown");
  const costs = active.filter(item => item.kind === "cost");
  const taskResult: ContentFeedbackRow["taskResult"] = !linked ? { status: "unknown", reason: "unlinked_use" }
    : qualified.length > 0 ? { status: "observed", observationIds: qualified.map(item => item.id) }
      : { status: "unknown", reason: bound.length > 0 ? "task_measurement_unknown"
        : task.length > 0 ? "requirement_not_bound" : "no_task_measurement" };
  const cost: ContentFeedbackRow["cost"] = !linked ? { status: "unknown", reason: "unlinked_use" }
    : costs.length > 0 ? { status: "observed", observationIds: costs.map(item => item.id) }
      : { status: "unknown", reason: "no_cost_measurement" };

  return { taskResult, cost, learningGain: { status: "unknown", reason: "no_identified_learning_gain",
    claimObservationIds: active.filter(item => item.kind === "learning_gain").map(item => item.id) } as const };
}

function availableRow(link: FeedbackContentLink, read: AvailableExplanation,
  observations: readonly ContentFeedbackObservationEntry[], index: ReadIndex): ContentFeedbackRow {
  const binding = index.bindings.get(link.unitId);
  const linked = association(link, binding);
  const legacy = read.legacy.status === "available" ? index.legacy.get(link.unitId)
    : { unitId: link.unitId, status: "unavailable" as const, reason: read.legacy.reason };
  const revision = read.legacyRevision.status === "available" ? read.legacyRevision.value : { status: "none" as const };

  return { link, association: linked,
    report: linked.status === "linked" && binding !== undefined ? { status: "available", unit: binding.unit,
      ...(binding.closeEventId === undefined ? {} : { closeEventId: binding.closeEventId }) }
      : { status: "unknown", reason: linked.status === "unlinked" ? linked.reason : "unit_missing" },
    legacy: linked.status === "linked" ? legacy ?? { unitId: link.unitId, status: "not_recorded" }
      : { unitId: link.unitId, status: "unavailable", reason: "unlinked_use" },
    revision: linked.status === "linked" && revision.status === "compared" && revision.unitId === link.unitId
      && feedbackSourceKey(revision.source) === feedbackSourceKey(link.source) ? revision : { status: "none" },
    observations, ...observationFacets(link, observations, linked.status === "linked"),
    questions: linked.status === "linked" ? read.questions.filter(item => item.unitId === link.unitId) : [] };
}

function unavailableRow(link: FeedbackContentLink, reason: string,
  observations: readonly ContentFeedbackObservationEntry[]): ContentFeedbackRow {
  return { link, association: { status: "unlinked", reason: "source_unavailable" }, report: { status: "unknown", reason },
    legacy: { unitId: link.unitId, status: "unavailable", reason }, revision: { status: "none" }, observations,
    ...observationFacets(link, observations, false), questions: [] };
}

function material(row: ContentFeedbackRow, position: ContentFeedbackProjection["sourcePosition"],
  board: ContentFeedbackProjection["boardPosition"]): ContentFeedbackMaterial {
  const legacyRefs = row.legacy.status === "matched" ? row.legacy.feedbackHistory.flatMap(item => [item.feedback.id,
    ...item.feedback.evidenceIds, `reward-source:${feedbackSourceKey(item.feedback.source)}`]) : [];
  const sourceRefs = [...new Set([...row.link.requirementRefs, ...row.link.artifactRefs.map(item => item.ref),
    `reward-source:${feedbackSourceKey(row.link.source)}`, ...(row.link.exposureId === undefined ? [] : [row.link.exposureId]),
    ...legacyRefs,
    ...row.observations.flatMap(item => [...item.observation.evidenceRefs,
      `reward-source:${feedbackSourceKey(item.observation.observationSource)}`])])];
  const text = JSON.stringify({ schemaVersion: 1, role: "feedback_for_learning_problem_review", sourcePosition: position,
    boardPosition: board, ...row });

  return { ref: `content-feedback:${contentHashOf(text)}`, text, sourceRefs, issueId: row.link.issueId, domain: row.link.domain };
}

/** Pure, replacement projection. It consumes the actual explanation read without writing or re-estimating it.
 * Each source/unit address must match; task measurements and gain claims never relabel a first-close report.
 * Same-unit corrections preserve arrival history and supersedes; semantic continue/revise/end remains with the model.
 */
export function buildContentFeedbackProjection(input: ContentFeedbackInput): ContentFeedbackProjection {
  validateContentFeedbackInput(input);
  const observations = input.observations ?? [];
  const grouped = new Map<string, ContentFeedbackObservation[]>();

  for (const item of observations) {
    const key = feedbackLinkKey(item), group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }

  const read = input.explanation;
  const sourcePosition = read.ok ? read.source : null;
  const boardPosition: ContentFeedbackProjection["boardPosition"] = read.ok && read.legacy.status === "available"
    ? { status: "available", revision: read.legacy.revision }
    : { status: "unavailable", reason: read.ok ? read.legacy.status === "unavailable" ? read.legacy.reason : "board_unavailable" : read.reason };
  const index: ReadIndex = { bindings: new Map(read.ok ? read.bindings.map(item => [item.unit.unitId, item]) : []),
    legacy: new Map(read.ok && read.legacy.status === "available" ? read.legacy.units.map(item => [item.unitId, item]) : []) };
  const rows = input.links.map(link => {
    const history = observationsFor(grouped.get(feedbackLinkKey(link)) ?? []);
    return read.ok ? availableRow(link, read, history, index) : unavailableRow(link, read.reason, history);
  });
  const linkedKeys = new Set(rows.filter(row => row.association.status === "linked").map(row => feedbackLinkKey(row.link)));

  return { schemaVersion: 1, status: read.ok ? "available" : "source_unavailable", sourcePosition, boardPosition,
    reported: read.ok ? read.reported : null, rows,
    unlinkedObservations: observations.filter(item => !linkedKeys.has(feedbackLinkKey(item))),
    materialRecords: rows.map(row => material(row, sourcePosition, boardPosition)),
    interpretation: "reports_task_results_costs_and_gain_claims_are_distinct" };
}
