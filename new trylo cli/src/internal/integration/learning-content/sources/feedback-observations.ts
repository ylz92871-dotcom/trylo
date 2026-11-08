import { contentHashOf } from "../../../learning/control/hash.js";
import type { BoardState } from "../../../learning/control/state.js";
import type { RewardSource } from "../../../learning/reward/contracts.js";
import type { ContentFeedbackObservation, FeedbackContentLink } from "../../../learning/central/content/feedback-contracts.js";
import type { SessionRecord } from "../../../ports/session.js";
import { parseEnvelope } from "../../../protocol/validate.js";
import { sessionContentRecordRef } from "./session.js";

/** Only already-targeted canonical user feedback becomes a targeted correction observation.
 * Plain user prose remains unassigned material for semantic review, regardless of its wording.
 */
export function automaticUserFeedback(board: BoardState, links: readonly FeedbackContentLink[]): readonly ContentFeedbackObservation[] {
  const output: ContentFeedbackObservation[] = [];
  const exposures = new Map((board.rewardExposures ?? []).map(row => [row.id, row]));
  const feedbacks = new Map<string, NonNullable<BoardState["rewardFeedbacks"]>[number][]>();

  for (const feedback of board.rewardFeedbacks ?? []) {
    if (feedback.origin !== "user") continue;
    const group = feedbacks.get(feedback.exposureId) ?? [];
    group.push(feedback);
    feedbacks.set(feedback.exposureId, group);
  }

  for (const link of links) {
    if (link.exposureId === undefined) continue;

    const exposure = exposures.get(link.exposureId);
    if (!exposure || exposure.source.sessionId !== link.source.sessionId || exposure.source.turnId !== link.source.turnId
      || exposure.source.attemptId !== link.source.attemptId || exposure.source.eventId !== link.source.eventId) continue;

    const ids = new Map<string, string>();

    for (const feedback of feedbacks.get(exposure.id) ?? []) {
      const id = `content-user-feedback:${contentHashOf([link.issueId, link.unitId, feedback.id])}`;

      ids.set(feedback.id, id);
      const supersedes = feedback.supersedes === undefined ? undefined : ids.get(feedback.supersedes);
      if (feedback.supersedes !== undefined && supersedes === undefined) throw new Error("content_user_feedback_prefix_missing");

      output.push({ id, issueId: link.issueId, unitId: link.unitId, source: link.source,
        observationSource: feedback.source, evidenceRefs: [feedback.id, ...feedback.evidenceIds], observedAt: feedback.observedAt,
        ...(supersedes === undefined ? {} : { supersedes }), kind: "user_correction", targetRef: exposure.id,
        targetRole: "unspecified", text: JSON.stringify({ role: "canonical_user_feedback_evaluation_or_correction",
          originalTarget: exposure.context, targets: exposure.targets, outcome: feedback.outcome,
          attribution: feedback.attribution, evidenceIds: feedback.evidenceIds,
          interpretation: "user_feedback_does_not_itself_identify_same_requirement_or_learning_gain" }) });
    }
  }

  return output;
}

/** Terminal total is a shared task bill, not the cost attributed to this tool or learned asset. */
export function automaticTaskCosts(records: readonly SessionRecord[], links: readonly FeedbackContentLink[]): readonly ContentFeedbackObservation[] {
  const output: ContentFeedbackObservation[] = [];
  const terminals = new Map<string, SessionRecord>(), terminalEvents = new Map<string, { readonly sequence: number; readonly source: RewardSource }[]>();

  for (const record of records) {
    if (record.turnId === undefined) continue;

    if (record.type === "terminal") terminals.set(record.turnId, record);

    if (record.type !== "envelope") continue;

    const parsed = parseEnvelope(record.payload.envelope);
    if (!parsed.ok || parsed.envelope.kind !== "terminal" || !parsed.envelope.sessionId || !parsed.envelope.turnId || !parsed.envelope.attemptId) continue;

    const source = { sessionId: parsed.envelope.sessionId, turnId: parsed.envelope.turnId, attemptId: parsed.envelope.attemptId, eventId: parsed.envelope.eventId };
    const events = terminalEvents.get(record.turnId) ?? [];
    events.push({ sequence: record.sequence, source });
    terminalEvents.set(record.turnId, events);
  }

  for (const link of links) {
    const terminal = terminals.get(link.source.turnId);
    if (!terminal || typeof terminal.payload.usage !== "object" || terminal.payload.usage === null || Array.isArray(terminal.payload.usage)) continue;

    const total = (terminal.payload.usage as { readonly totalTokens?: unknown }).totalTokens;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) continue;

    const event = [...(terminalEvents.get(link.source.turnId) ?? [])].reverse().find(row => row.sequence <= terminal.sequence
      && row.source.sessionId === link.source.sessionId);
    if (!event) continue;

    const measurementRef = sessionContentRecordRef(link.source.sessionId, terminal.sequence);

    output.push({ id: `content-task-cost:${contentHashOf([link.issueId, link.unitId, measurementRef])}`,
      issueId: link.issueId, unitId: link.unitId, source: link.source, observationSource: event.source,
      observedAt: Date.parse(terminal.at), evidenceRefs: [measurementRef], kind: "cost", quantity: total, unit: "tokens",
      metricRef: "execution.turn.total_tokens_shared_not_asset_attributed", measurementRef });
  }

  return output;
}
