import { contentHashOf } from "../../learning/control/hash.js";
import type { FeedbackExplanationRead } from "../../integration/reward/explanation-reader.js";
import type { FeedbackInvestigationQuestion, LegacyFeedbackUnitExplanation } from "../../learning/reward/explanation/explanation-policy.js";

export const FEEDBACK_OUTPUT_BYTES = 64 * 1024;

type Success = Extract<FeedbackExplanationRead, { ok: true }>;

const KINDS = ["missing_qualifying_close", "unresolved_failure_meaning", "revision_target", "revision_reveal"] as const;

function display(value: string, compact: boolean) {
  const shown = compact ? value.slice(0, 48) : value;
  return { display: shown, truncated: shown !== value, ...(shown === value ? {} : { identityHash: contentHashOf(value) }) };
}

const limits = (available: number, shown: number) => ({ available, shown, omitted: available - shown });

function reportedSummary(result: Success) {
  const row = result.reported;
  return { schemaVersion: row.schemaVersion, algorithm: row.algorithm, status: row.status, target: row.target,
    population: row.population, counts: row.counts, chainCount: row.chainCount, residualScale: row.residualScale,
    centerRole: row.centerRole, delta: row.delta, budgetRule: row.budgetRule, coverageBasis: row.coverageBasis,
    interpretation: row.interpretation, actualMeanSupport: row.actualMeanSupport,
    conditionalMeanBands: row.conditionalMeanBands, totalBoundary: row.totalBoundary,
    chainDetails: { ...limits(row.chains.length, 0), selection: "programmatic_reader_only" } };
}

function questions(result: Success, compact: boolean) {
  const births = new Map(result.bindings.map(row => [row.unit.unitId, row.unit.registeredAt]));
  const arrivals = new Map<string, number>();

  if (result.legacy.status === "available") for (const row of result.legacy.units) {
    if (row.status === "matched") for (const entry of row.feedbackHistory) arrivals.set(entry.feedback.id, entry.feedbackArrayIndex);
  }

  const rank = (question: FeedbackInvestigationQuestion) => question.feedbackIds.length > 0
    ? Math.max(...question.feedbackIds.map(id => arrivals.get(id) ?? -1)) : births.get(question.unitId) ?? -1;
  const groups = KINDS.map(kind => {
    const candidates = result.questions.filter(row => row.kind === kind);
    const chosen = candidates.reduce<FeedbackInvestigationQuestion | undefined>((prior, row) =>
      prior === undefined || rank(row) > rank(prior) ? row : prior, undefined);

    return { kind, ...limits(candidates.length, chosen === undefined ? 0 : 1),
      item: chosen === undefined ? null : { unitId: chosen.unitId, text: chosen.text,
        evidence: { ...limits(chosen.evidenceIds.length, Math.min(2, chosen.evidenceIds.length)),
          items: chosen.evidenceIds.slice(-2).map(id => display(id, compact)) },
        feedback: { ...limits(chosen.feedbackIds.length, Math.min(2, chosen.feedbackIds.length)),
          items: chosen.feedbackIds.slice(-2).map(id => display(id, compact)) } } };
  });

  return { ...limits(result.questions.length, groups.filter(row => row.item !== null).length),
    selection: "one_recent_per_kind", groups };
}

function legacyCard(row: LegacyFeedbackUnitExplanation | undefined, compact: boolean) {
  if (row === undefined) return { status: "unavailable" };

  if (row.status !== "matched") return { status: row.status };

  const signal = row.activeSignals.at(-1);
  const adjustments = signal?.signal.adjustments ?? [];

  return { status: row.status,
    history: { ...limits(row.feedbackHistory.length, Math.min(2, row.feedbackHistory.length)), selection: "recent_feedback_arrival",
      items: row.feedbackHistory.slice(-2).reverse().map(entry => ({ feedbackArrayIndex: entry.feedbackArrayIndex,
        state: entry.state, feedbackId: display(entry.feedback.id, compact), origin: entry.feedback.origin,
        outcome: entry.feedback.outcome, observedAt: entry.feedback.observedAt,
        evidenceCount: entry.feedback.evidenceIds.length,
        ...(entry.feedback.supersedes === undefined ? {} : { supersedes: display(entry.feedback.supersedes, compact) }) })) },
    activeSignals: { ...limits(row.activeSignals.length, signal === undefined ? 0 : 1), selection: "recent_active_feedback",
      latest: signal === undefined ? null : { feedbackId: display(signal.signal.feedbackId, compact),
        basis: signal.basis, direction: signal.signal.direction, origin: signal.signal.origin,
        normalizedValue: signal.signal.normalizedValue ?? null,
        adjustments: { ...limits(adjustments.length, Math.min(2, adjustments.length)), selection: "first_two_original_adjustments",
          items: adjustments.slice(0, 2).map((update, adjustmentOrdinal) => ({ adjustmentOrdinal,
            target: { kind: display(update.target.kind, compact), id: display(update.target.id, compact), version: display(update.target.version, compact) },
            predictionError: update.predictionError, innovation: update.innovation, gain: update.gain,
            signedCredit: update.signedCredit, before: update.before, after: update.after,
            currentUpdateMeanChange: update.after.mean - update.before.mean })) } } } };
}

function revision(result: Success, compact: boolean) {
  if (result.legacyRevision.status === "unavailable") return result.legacyRevision;

  const row = result.legacyRevision.value;
  if (row.status === "none") return row;

  const binding = result.bindings.find(binding => binding.unit.unitId === row.unitId);

  return { status: row.status, basis: row.basis, unitId: row.unitId,
    sourceLocator: { sessionId: result.source.sessionId, registeredAt: binding?.unit.registeredAt ?? null },
    feedbackId: display(row.feedbackId, compact), supersedes: display(row.supersedes, compact),
    feedbackArrayIndex: row.feedbackArrayIndex, beforeFeedbackCount: row.beforeFeedbackCount,
    afterFeedbackCount: row.afterFeedbackCount, currentFeedbackCount: row.currentFeedbackCount,
    targets: row.targets.map((target, targetOrdinal) => ({ targetOrdinal,
      target: { kind: display(target.target.kind, compact), id: display(target.target.id, compact), version: display(target.target.version, compact) },
      before: target.before, after: target.after, beforeBasis: target.beforeBasis, afterBasis: target.afterBasis,
      meanDifference: target.meanDifference, varianceDifference: target.varianceDifference })) };
}

function summary(result: Success, compact: boolean) {
  const byUnit = new Map(result.legacy.status === "available" ? result.legacy.units.map(row => [row.unitId, row]) : []);
  const selected = compact ? [] : result.bindings.slice(-8).reverse();

  return { schemaVersion: result.schemaVersion, ok: true,
    source: { sessionId: result.source.sessionId, workspace: display(result.source.workspaceId, compact),
      cohortThrough: result.source.cohortThrough, observedThrough: result.source.observedThrough,
      tornTail: result.source.tornTail, decoder: result.source.decoder, basisHash: result.source.basisHash,
      observedRequests: result.source.observedRequests },
    reported: reportedSummary(result),
    board: result.legacy.status === "available" ? { status: "available", revision: result.legacy.revision }
      : { status: "unavailable", reason: result.legacy.reason },
    unitCards: { ...limits(result.bindings.length, selected.length), selection: compact ? "compact_summary_cards_omitted" : "recent_registration_eight",
      items: selected.map(binding => ({ unitId: binding.unit.unitId, registeredAt: binding.unit.registeredAt,
        report: binding.unit.status, revealedAt: binding.unit.status === "pending" ? null : binding.unit.revealedAt,
        toolName: display(binding.toolName, compact), otherReason: binding.otherReason ?? null,
        legacy: legacyCard(byUnit.get(binding.unit.unitId), compact) })) },
    questions: questions(result, compact), legacyRevision: revision(result, compact),
    display: { compact, byteLimit: FEEDBACK_OUTPUT_BYTES, fullResult: "programmatic_reader",
      scope: "presentation_only_full_cohort_estimation_unchanged" } };
}

/** Presentation caps never change the estimation population, head selection or revision comparison. */
export function formatFeedbackRead(result: FeedbackExplanationRead): string {
  if (!result.ok) return JSON.stringify(result);

  const normal = JSON.stringify(summary(result, false));
  if (Buffer.byteLength(normal, "utf8") + 1 <= FEEDBACK_OUTPUT_BYTES) return normal;

  const compact = JSON.stringify(summary(result, true));

  // Compact labels have fixed display lengths; all counts, bands and revision numbers survive.
  if (Buffer.byteLength(compact, "utf8") + 1 > FEEDBACK_OUTPUT_BYTES) throw new RangeError("feedback_summary_budget_invariant");

  return compact;
}
