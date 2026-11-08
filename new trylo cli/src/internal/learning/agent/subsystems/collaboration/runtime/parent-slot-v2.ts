import type { LearningPortShape } from "../../../../../integration/user-learning/port.js";
import type { ExposureV2, SelectedV2, SessionOptionsV2 } from "./session-types-v2.js";
import type { CollaborationTimelineV2 } from "./timeline-v2.js";

/** One existing method slot, with the same total ceiling before user-policy composition. */
export function createCollaborationParentSlotV2(options: SessionOptionsV2, timeline: CollaborationTimelineV2) {
  const selected = new Map<number, SelectedV2>();
  let latest: ExposureV2 | undefined;

  return {
    latestExposure: () => latest,
    attach(base: LearningPortShape | undefined): LearningPortShape {
      return {
        intentOn: (turnId, beat) => base?.intentOn(turnId, beat) ?? false,
        confirmIntent: (turnId, beat) => base?.confirmIntent?.(turnId, beat) ?? base?.intentOn(turnId, beat) ?? false,
        async requestSlot(request) {
          const existing = await base?.requestSlot(request);

          if (!options.enabled() || options.signal?.aborted || request.turnId !== options.turnId) return existing;

          try {
            const available = Math.max(0, Math.min(1200, options.grant.maxPromptChars) - (existing?.message.content.length ?? 0) - 1);
            const value = await options.subsystem.prepareActions(timeline.context(), "parent", available);

            selected.delete(request.beat);

            if (!options.enabled() || options.signal?.aborted) return existing;

            if (value.kind !== "selected") return existing;

            if (selected.size >= 16) selected.delete(selected.keys().next().value ?? 0);

            selected.set(request.beat, value);

            return { message: { role: "system", content: [existing?.message.content, value.guidance].filter(Boolean).join("\n") },
              receipts: [...(existing?.receipts ?? []), { ref: "c1", versionId: value.versionId,
                proposalId: value.proposalId, nicheId: `collaboration-v2:${value.familyId}` }] };
          } catch {
            options.warn("collaboration_parent_slot_unavailable");
            return existing;
          }
        },
        async observe(report) { await base?.observe(report); },
        async recordFielding(notice) {
          const value = selected.get(notice.beat);
          const ours = value !== undefined && notice.receipts.some(receipt => receipt.ref === "c1" && receipt.versionId === value.versionId);
          const foreign = notice.receipts.filter(receipt => receipt.ref !== "c1");
          if (foreign.length > 0) await base?.recordFielding({ ...notice, receipts: foreign });
          if (ours && value !== undefined) latest = await timeline.expose(value, notice.attemptId);
        },
        async recordFeedback(notice) {
          const ownVersions = new Set([...selected.values()].map(value => value.versionId));
          await base?.recordFeedback({ ...notice, items: notice.items.filter(item => !ownVersions.has(item.versionId)) });
        },
        async endTurn(turnId) {
          selected.clear();
          latest = undefined;
          await base?.endTurn(turnId);
        },
      };
    },
  };
}
