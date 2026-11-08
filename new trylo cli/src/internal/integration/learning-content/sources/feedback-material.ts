import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentEvidenceRecord, ContentMaterial, ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import type { SessionRecord } from "../../../ports/session.js";
import { sessionContentRecordRef, sessionContentRecordView } from "./session.js";
import { contentSourceViewContext } from "./source-text-view.js";
import { sessionRecordOrigin } from "./session-decode.js";
import type { ContentAdoptionProjection } from "./adoption-contract.js";

/** Keep the actual use and all later task feedback. Later user text has candidates, never an invented correction target. */
export function adoptionFeedbackMaterialBatch(input: {
  readonly adoption: ContentAdoptionProjection; readonly records: readonly SessionRecord[];
  readonly scope: string; readonly sessionId: string; readonly secrets?: readonly string[];
}): ContentMaterialBatch {
  const records: ContentEvidenceRecord[] = [], materials: ContentMaterial[] = [];
  const users = input.records.flatMap(row => {
    if (sessionRecordOrigin(row) !== "user_statement") return [];
    const view = sessionContentRecordView(row, input.scope, input.secrets);
    return view?.record.origin === "user_statement" ? [{ row, view }] : [];
  });

  // Exact later-user originals are archived once. Per-adoption model views nominate a bounded recent set.
  for (const user of users) records.push(user.view.record);

  const userIndexText = canonicalJson({ role: "later_user_source_index_not_correction_assignment", sessionId: input.sessionId,
    sources: users.map(({ row, view }) => ({ ref: view.record.ref, sequence: row.sequence, turnId: row.turnId ?? null,
      ...(view.changed ? { originalSource: view.original } : {}) })) });
  const userIndexRef = `content-user-source-index:${contentHashOf(userIndexText)}`;

  records.push({ ref: userIndexRef, runId: userIndexRef, sequence: 0, scope: input.scope, origin: "execution_result", text: userIndexText });
  const terminals = input.records.filter(row => row.type === "terminal"), requirements = input.records.filter(row => row.type === "turn_input");

  for (const adopted of input.adoption.adoptions) {
    const availableUsers = users.filter(({ row }) => row.sequence > (adopted.sourceSequence ?? -1)
      || row.turnId !== undefined && row.turnId === adopted.turnId);
    const sameTurn = availableUsers.filter(({ row }) => row.turnId !== undefined && row.turnId === adopted.turnId);
    const laterUsers = [...new Map([...sameTurn, ...availableUsers.slice(-4)].map(user => [user.row.sequence, user])).values()];
    const originalTask = requirements.filter(row => row.turnId === adopted.turnId)
      .flatMap(row => {
        const view = sessionContentRecordView(row, input.scope, input.secrets);
        return view === undefined ? [] : [view.record.ref];
      });
    const nextWorkflow = adopted.basis !== "workflow_session_adoption" ? undefined : input.adoption.adoptions
      .filter(row => row.basis === "workflow_session_adoption" && (row.sourceSequence ?? -1) > (adopted.sourceSequence ?? -1))
      .sort((left, right) => (left.sourceSequence ?? 0) - (right.sourceSequence ?? 0))[0]?.sourceSequence;
    const task = terminals.filter(row => adopted.turnId !== undefined ? row.turnId === adopted.turnId
      : adopted.basis === "workflow_session_adoption" && row.sequence > (adopted.sourceSequence ?? -1)
        && (nextWorkflow === undefined || row.sequence < nextWorkflow))
      .map(row => ({ ref: sessionContentRecordRef(input.sessionId, row.sequence), sequence: row.sequence,
        turnId: row.turnId ?? null, payload: row.payload, interpretation: "task_lifecycle_and_total_usage_not_task_quality_or_asset_credit" }));
    const userRefs = laterUsers.map(({ view }) => view.record.ref);
    const text = canonicalJson({ schemaVersion: 1, role: "actual_adoption_and_later_feedback", adoption: adopted,
      originalRequirementRefs: originalTask, taskReports: task,
      laterUserInput: { role: "unassigned_later_user_input_candidates_for_semantic_review", sourceRefs: userRefs,
        available: availableUsers.length, shown: laterUsers.length, omitted: availableUsers.length - laterUsers.length, fullSourceIndexRef: userIndexRef,
        targetKnown: false, instruction: "Read the original text and compare original requirements and artifact conditions before proposing any correction association." },
      interpretation: "display_or_execution_is_not_following_or_benefit_task_success_is_not_learning_gain" });
    const ref = `content-adoption-feedback:${contentHashOf(text)}`;

    records.push({ ref, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text });
    const links = { issueIds: adopted.artifact.issueIds, topicIds: adopted.artifact.topicIds,
      artifactRefs: [{ id: adopted.artifact.ref, version: adopted.artifact.version }] };

    materials.push({ id: ref, kind: "feedback", subsystem: adopted.artifact.subsystem,
      context: "Canonical actual-adoption receipt and later task/user sources; user target remains semantically unassigned.",
      recordRefs: [ref], requirementIds: [], answerIds: [], links });

    for (const { row, view } of laterUsers) {
      const ref = view.record.ref;
      const context = canonicalJson({ role: "later_user_input_unassigned", originalSession: input.sessionId,
        originalTurn: row.turnId ?? null, afterAdoptionRef: adopted.ref, targetKnown: false });
      materials.push({ id: `content-user-review:${contentHashOf([adopted.ref, ref])}`, kind: "feedback", subsystem: adopted.artifact.subsystem,
        context: view.changed ? contentSourceViewContext(view, context) : context,
        recordRefs: [ref], requirementIds: [], answerIds: [], links });
    }
  }

  return { records, materials, requirements: [], answers: [] };
}
