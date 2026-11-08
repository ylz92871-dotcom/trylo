import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import type { CollaborationCheckReceiptV2, CollaborationCheckSubjectV2, CollaborationCheckerReaderV2 } from "../domain/v2-checker.js";
import type { CollaborationEpisodeV2, CollaborationV2Fact } from "../domain/v2-contracts.js";
import { hydrateCollaborationArchiveV2 } from "../domain/v2-hydration.js";

type Options = { readonly board: CollaborationBoardPort; readonly checker?: CollaborationCheckerReaderV2;
  readonly enabled?: () => boolean; readonly onRecorded?: () => void };

const digest = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const text = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 512;
const failure = (reason: string) => ({ ok: false as const, reason });

function subjectValid(subject: CollaborationCheckSubjectV2): boolean {
  return subject !== null && typeof subject === "object" && [subject.scope, subject.teamRunId, subject.taskId, subject.memberId,
    subject.episodeId, subject.artifactRef, subject.generatorId].every(text) && Number.isSafeInteger(subject.round) && subject.round >= 1
    && digest(subject.contentHash) && digest(subject.requirementsDigest);
}

function receiptValid(receipt: CollaborationCheckReceiptV2, runRef: string, subject: CollaborationCheckSubjectV2): boolean {
  return receipt !== null && typeof receipt === "object" && receipt.schemaVersion === 2 && receipt.runRef === runRef
    && contentHashOf(receipt.subject) === contentHashOf(subject) && text(receipt.checkerId) && text(receipt.checkerVersion)
    && receipt.checkerId !== subject.generatorId && digest(receipt.checksDigest) && ["passed", "failed", "partial"].includes(receipt.verdict)
    && typeof receipt.recordedAt === "string" && Number.isFinite(Date.parse(receipt.recordedAt));
}

/** Trusted host adapter: reread actual checker records, derive links from Board, retain failed/partial results too. */
export function createCollaborationCheckerFeedbackV2(options: Options) {
  const enabled = options.enabled ?? (() => true);
  return { async record(input: { readonly runRef: string; readonly subject: CollaborationCheckSubjectV2 }) {
    if (!enabled()) return failure("collect_disabled");

    if (!text(input?.runRef) || !subjectValid(input?.subject)) return failure("invalid_checker_binding");

    if (options.checker === undefined) return failure("independent_checker_unavailable");

    const subject = Object.freeze({ ...input.subject }), runRef = input.runRef;

    try {
      const checked = await options.checker.read(runRef, subject);
      if (!checked.ok) return failure("checker_receipt_unavailable");

      const receipt = Object.freeze({ ...checked.receipt, subject: Object.freeze({ ...checked.receipt.subject }) });
      if (!receiptValid(receipt, runRef, subject)) return failure("checker_receipt_binding_mismatch");

      if (!enabled()) return failure("collect_disabled");

      const loaded = await hydrateCollaborationArchiveV2({ board: options.board, now: () => receipt.recordedAt, canContinue: enabled,
        query: { scope: subject.scope, factIds: [subject.episodeId] } });
      if (!loaded.ok) return failure(loaded.reason);

      if (!enabled()) return failure("collect_disabled");

      const facts = loaded.state.collaborationV2Facts ?? [];
      const original = facts.find((f): f is CollaborationEpisodeV2 => f.kind === "episode" && f.factId === subject.episodeId
        && f.source === "runtime" && f.scope === subject.scope && f.context.teamRunId === subject.teamRunId
        && f.context.taskId === subject.taskId && f.context.memberId === subject.memberId && f.context.round === subject.round);
      if (original === undefined) return failure("checker_execution_subject_missing");

      const exposures = new Set(facts.filter(f => f.kind === "exposure" && f.scope === subject.scope
        && f.context.teamRunId === subject.teamRunId && f.context.taskId === subject.taskId
        && f.context.memberId === subject.memberId && f.context.round === subject.round).map(f => f.factId));
      const linked = new Set(facts.flatMap(f => f.kind === "outcome" && f.source === "runtime" && f.scope === subject.scope
        && f.episodeIds.includes(original.factId) ? f.adoptionIds : []));
      const adoptionIds = facts.filter(f => f.kind === "adoption" && linked.has(f.factId) && exposures.has(f.exposureId)).map(f => f.factId).slice(-32);
      const identity = contentHashOf([runRef, subject]);
      const base = { schemaVersion: 2 as const, scope: subject.scope, recordedAt: receipt.recordedAt, source: "external_checker" as const };
      const evidenceRefs = [`checker-run:${runRef}`, `checker:${receipt.checkerId}@${receipt.checkerVersion}`,
        `source-sha256:${subject.contentHash}`, `requirements-sha256:${subject.requirementsDigest}`, `checks-sha256:${receipt.checksDigest}`];
      if (evidenceRefs.some(ref => ref.length > 512)) return failure("invalid_checker_binding");

      const eventId = `cv2-checked:${identity}`, episodeId = `cv2-checked-episode:${identity}`;
      const metrics = { ...original.metrics, delivery: receipt.verdict === "partial" ? "unverified" as const : receipt.verdict };
      const records: readonly CollaborationV2Fact[] = [
        { ...base, kind: "event", factId: eventId, context: original.context, dimension: "review", action: "independent_result",
          summary: `Independent checker ${receipt.checkerId.slice(0, 150)} returned ${receipt.verdict} for a frozen artifact and requirement digest.`,
          causedBy: original.eventIds.slice(-32), evidenceRefs, metrics: {} },
        { ...base, kind: "episode", factId: episodeId, context: original.context, eventIds: [...original.eventIds.slice(-31), eventId],
          evidenceRefs: [...evidenceRefs, original.factId], metrics },
        { ...base, kind: "outcome", factId: `cv2-checked-outcome:${identity}`, adoptionIds, episodeIds: [original.factId, episodeId], evidenceRefs, metrics },
      ];

      for (const fact of records) {
        if (!enabled()) return failure("collect_disabled");
        const result = await options.board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${fact.factId}`, issuedAt: fact.recordedAt, fact });
        if (!result.ok) return failure(result.reason);
      }

      try { options.onRecorded?.(); } catch { /* A wake observer cannot alter persisted checker truth. */ }

      return { ok: true as const, episodeId, outcomeId: `cv2-checked-outcome:${identity}`, adoptionCount: adoptionIds.length };
    } catch { return failure("checker_feedback_unavailable"); }
  } };
}
