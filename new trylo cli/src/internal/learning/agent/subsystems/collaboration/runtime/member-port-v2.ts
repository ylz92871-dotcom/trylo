import { contentHashOf } from "../../../../control/hash.js";
import { ACTION_DIMENSIONS } from "../domain/v2-parse.js";
import type { CollaborationDimension } from "../domain/v2-contracts.js";
import type { CollaborationRound, SubagentCollaborationPort } from "../../../../../subagent/collaboration.js";
import type { ExposureV2, SelectedV2, SessionOptionsV2 } from "./session-types-v2.js";
import type { CollaborationTimelineV2 } from "./timeline-v2.js";
import { collaborationExcerptV2 } from "./summary-v2.js";

type RoundState = { readonly round: CollaborationRound; readonly selection?: SelectedV2; exposure?: ExposureV2; startedEventId?: string };

export function createCollaborationMemberPortV2(options: SessionOptionsV2, timeline: CollaborationTimelineV2,
  delivered: (round: CollaborationRound) => Promise<void>): SubagentCollaborationPort {
  const rounds = new Map<string, RoundState>();
  const key = (round: Pick<CollaborationRound, "teamRunId" | "taskId" | "memberId" | "round">) =>
    contentHashOf([round.teamRunId, round.taskId, round.memberId, round.round]);

  return {
    async accountUsage(round, usage) { await timeline.usage(timeline.context(round), round.executionId ?? `${round.taskId}:execution`, usage.totalTokens); },
    async prepare(round, signal) {
      if (!options.enabled() || options.signal?.aborted || signal.aborted) return undefined;
      const selection = await options.subsystem.prepareActions(timeline.context(round), "member", options.grant.maxPromptChars);
      if (signal.aborted || options.signal?.aborted || !options.enabled()) return undefined;
      if (rounds.size >= 64) {
        options.warn("collaboration_round_capacity");
        return undefined;
      }
      rounds.set(key(round), { round, ...(selection.kind === "selected" ? { selection } : {}) });
      return selection.kind === "selected" ? selection.guidance : undefined;
    },
    async dispatched(round, requestId, guidance) {
      const item = rounds.get(key(round));
      if (item === undefined || !options.enabled()) return;

      const eventId = await timeline.event({ id: `${requestId}:member-start`, context: timeline.context(round), dimension: "assignment",
        action: "member_started", summary: `Frozen member ${round.memberId} began assigned round ${round.round}.`,
        evidenceRefs: [`request:${requestId}`, `assignment:${contentHashOf(round.assignment)}`] });
      if (eventId !== undefined) item.startedEventId = eventId;

      if (eventId !== undefined && item.selection !== undefined && guidance === item.selection.guidance) {
        const exposure = await timeline.expose(item.selection, requestId);
        if (exposure !== undefined) item.exposure = exposure;
      }

      await delivered(round);
    },
    async completed(round, output) {
      if (options.signal?.aborted) return;

      const item = rounds.get(key(round));
      rounds.delete(key(round));

      if (item === undefined || !options.enabled()) return;

      await timeline.event({ id: `${key(round)}:answer`, context: timeline.context(round), dimension: "handoff", action: "member_answered",
        summary: `Member ${round.memberId} returned an answer; quality remains unverified.`, evidenceRefs: [`output:${contentHashOf(output)}`] });
      // Empty pending/blockers are valid explicit "none". Semantic handoff quality
      // requires independent evidence, so this runtime observation assigns no score.
      await timeline.episode(timeline.context(round), { delivery: "unverified" });
    },
    async ended(identity, status, errorCode) {
      const item = rounds.get(key(identity));
      rounds.delete(key(identity));

      if (item === undefined || !options.enabled()) return;

      await timeline.event({ id: `${key(identity)}:terminal`, context: timeline.context(item.round), dimension: "rework", action: "member_terminal",
        terminalMetadata: true,
        summary: `Runtime ended member round with status ${status}; no capability judgment follows from this terminal.`,
        evidenceRefs: [`runtime:${status}`, ...(errorCode === undefined ? [] : [`error:${errorCode}`])] });
      await timeline.episode(timeline.context(item.round), { delivery: "unverified" }, false, true);
    },
    async capture(round, event) { timeline.capture(event, round); },
    async report(round, report) {
      if (!options.enabled()) return;

      await timeline.flush();
      const item = rounds.get(key(round)), context = timeline.context(round);
      const refs = report.evidenceRefs.filter(ref => timeline.knownReference(ref));
      if (refs.length !== report.evidenceRefs.length) {
        options.warn("collaboration_report_ungrounded");
        return;
      }

      if (report.operation === "share_reference" && refs.length === 0) {
        options.warn("collaboration_shared_references_missing");
        return;
      }

      if (refs.length === 0 && item?.startedEventId !== undefined) refs.push(item.startedEventId);

      if (refs.length === 0) {
        options.warn("collaboration_report_ungrounded");
        return;
      }

      if (report.operation !== undefined) {
        if (report.dimension !== ACTION_DIMENSIONS[report.operation]) {
          options.warn("collaboration_report_operation_mismatch");
          return;
        }
        const id = await timeline.event({ id: `${report.id}:communication`, context, dimension: report.dimension as CollaborationDimension,
          action: report.operation, summary: `Member delivered a ${report.operation} notification to the parent mailbox. Supplied claim (unverified): ${collaborationExcerptV2(report.summary)}`, evidenceRefs: refs });
        const action = item?.exposure?.selection.actions.find(value => value.actionId === report.learningActionId && value.operation === report.operation);
        await timeline.adopt(item?.exposure, action?.actionId, id);
      }

      if (round.role === "reviewer" || round.role === "verifier") await timeline.event({ id: `${report.id}:assessment`, context,
        dimension: report.dimension as CollaborationDimension, action: "peer_assessment", summary: report.summary, source: "peer_report", evidenceRefs: refs,
        causedBy: [...new Set([...refs.filter(ref => timeline.knownEvent(ref)), ...(item?.startedEventId === undefined ? [] : [item.startedEventId])])] });
    },
  };
}
