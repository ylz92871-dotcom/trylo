import type { BoardState } from "../../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentMaterialBatch, ContentSubsystem } from "../../../learning/central/content/material-contract.js";
import type { ContentArtifactMapping } from "./artifact.js";

/** An explicit Board correction survives even when the current journal has none of its original uses.
 * This transports the recorded sources unchanged and never invents an SFN report or its original known-at.
 */
export function boardUserFeedbackMaterialBatch(input: {
  readonly board: BoardState; readonly scope: string; readonly subsystem: ContentSubsystem;
  readonly artifacts: readonly ContentArtifactMapping[]; readonly issueId?: string;
}): ContentMaterialBatch {
  const records: ContentMaterialBatch["records"][number][] = [], materials: ContentMaterialBatch["materials"][number][] = [];
  const byExposure = new Map<string, { readonly feedback: NonNullable<BoardState["rewardFeedbacks"]>[number]; readonly feedbackArrayIndex: number }[]>();

  (input.board.rewardFeedbacks ?? []).forEach((feedback, feedbackArrayIndex) => {
    if (feedback.origin !== "user") return;
    const group = byExposure.get(feedback.exposureId) ?? [];
    group.push({ feedback, feedbackArrayIndex });
    byExposure.set(feedback.exposureId, group);
  });

  for (const [exposureArrayIndex, exposure] of (input.board.rewardExposures ?? []).entries()) {
    const history = byExposure.get(exposure.id) ?? [];
    if (history.length === 0) continue;

    const feedbackIds = new Set(history.map(row => row.feedback.id));
    const artifacts = input.artifacts.filter(artifact => exposure.targets.some(target => target.id === artifact.ref && target.version === artifact.version));
    const explicitIssues = (input.board.learningIssues ?? []).filter(issue => issue.scope === input.scope && issue.reports.some(report =>
      report.evidenceRefs.some(ref => ref === exposure.id || feedbackIds.has(ref))));
    const issueIds = [...new Set([...artifacts.flatMap(row => row.issueIds), ...explicitIssues.map(row => row.issueId)])];
    if (input.issueId !== undefined && !issueIds.includes(input.issueId)) continue;

    if (artifacts.length === 0 && explicitIssues.length === 0) continue;

    const superseded = new Set(history.flatMap(row => row.feedback.supersedes === undefined ? [] : [row.feedback.supersedes]));
    const sourceRefs = [...new Set([exposure.id, ...artifacts.flatMap(row => row.sourceRefs),
      ...history.flatMap(row => [row.feedback.id, ...row.feedback.evidenceIds])])];
    const text = canonicalJson({ schemaVersion: 1, role: "board_explicit_user_feedback_without_requiring_current_session_binding",
      exposure, history: history.map(row => ({ ...row, state: superseded.has(row.feedback.id) ? "superseded" : "active" })),
      sourceRefs, issueIds, artifactRefs: artifacts.map(row => ({ id: row.ref, version: row.version })),
      // The outer packet/read result carries B. Unrelated funding must not mutate the identity
      // of these same immutable exposure/feedback sources or invalidate a worker's prepared input.
      sourcePosition: { exposureArrayIndex, feedbackIndicesAreNotBoardSequences: true },
      reportStatus: "not_inferred_from_current_journal", taskResult: "not_inferred", learningGain: "not_identified",
      interpretation: "explicit_user_feedback_may_evaluate_correct_or_change_requirements_compare_original_evidence_before_revision" });
    const ref = `content-board-user-feedback:${contentHashOf(text)}`;

    records.push({ ref, runId: ref, sequence: 0, scope: input.scope, origin: "user_statement", text });
    materials.push({ id: ref, kind: "feedback", subsystem: input.subsystem,
      context: canonicalJson({ source: "Board.rewardFeedbacks", sourceRefs, originalExposureSource: exposure.source,
        originalFeedbackSources: history.map(row => row.feedback.source), currentReportPopulation: "unchanged" }),
      recordRefs: [ref], requirementIds: [], answerIds: [], links: { issueIds,
        topicIds: [...new Set(artifacts.flatMap(row => row.topicIds))],
        artifactRefs: artifacts.map(row => ({ id: row.ref, version: row.version })) } });
  }

  return { records, materials, requirements: [], answers: [] };
}
