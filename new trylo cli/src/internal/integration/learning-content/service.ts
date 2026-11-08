import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createPersistentTopicIntake } from "../learning-topics/intake.js";
import { isContentDataSafe } from "./content-confidentiality.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import type { ContentFeedbackProjection } from "../../learning/central/content/feedback-contracts.js";
import type { ContentMaterialBatch, ContentMaterialSource, ContentPacket } from "../../learning/central/content/material-contract.js";
import { mergeContentBatches } from "../../learning/central/content/material.js";
import { retrieveContentPacket } from "../../learning/central/content/material-source.js";
import type { ContentProcessOutput } from "../../learning/central/content/process.js";
import { buildContentTopicHandoff } from "../../learning/central/content/topic-handoff.js";
import { buildContentRecord, readContentRecords, CONTENT_ALGORITHM } from "./records.js";
import { contentFeedbackMaterialBatch, createBoardContentSource } from "./source.js";
import { canReadNativeContentRecord, type NativeKnowledgeAccess } from "./sources/native-knowledge.js";
import { contentRecallMaterialBatch } from "./sources/content-recall.js";

export interface ContentPreparationInput extends ContentMaterialBatch {
  readonly issueId?: string;
  readonly requestedRefs?: readonly string[];
  readonly feedback?: ContentFeedbackProjection;
}

export type ContentPublication = { readonly status: "disabled" | "stale" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "content_saved"; readonly factId: string; readonly revision: number;
      readonly handoff: "no_new_topic" | "existing_question" }
  | { readonly status: "published"; readonly factId: string; readonly revision: number; readonly topicId: string }
  | { readonly status: "topic_pending"; readonly factId: string; readonly revision: number; readonly reason: string };

/** Host composition only. Existing Board and WS1 writers own persistence/CAS; this owns no issue lifecycle. */
export function createLearningContentService(options: { readonly boardRoot: string; readonly scope: string; readonly domain: LearningDomain;
  readonly enabled: () => boolean; readonly secrets?: readonly string[]; readonly nativeAccess?: NativeKnowledgeAccess }) {
  const board = createRewardV2BoardPort(options.boardRoot, options.enabled);
  const topics = createPersistentTopicIntake({ ...options, algorithmVersion: `${CONTENT_ALGORITHM}:topic`, identityPolicy: "canonical_scope" });
  const secrets = [...(options.secrets ?? [])];
  let suspended = false;

  return Object.freeze({
    inspect: () => ({ suspended }),

    /** Reads the canonical issue itself. The caller supplies domain-owned requirements and source adapters,
     * not a guessed question reconstructed from issueId/sourceRefs. Prior results are actually retrieved. */
    async prepare(input: ContentPreparationInput, signal: AbortSignal, source?: ContentMaterialSource) {
      if (!options.enabled()) return { ok: false as const, reason: "collect_disabled" };

      if (signal.aborted) return { ok: false as const, reason: "content_material_cancelled" };

      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) return { ok: false as const, reason: loaded.reason };

      const focus = input.issueId === undefined ? undefined : loaded.state.learningIssues?.find(row => row.issueId === input.issueId);
      if (input.issueId !== undefined && focus === undefined) return { ok: false as const, reason: "content_issue_missing" };

      const feedback = input.feedback === undefined ? [] : [contentFeedbackMaterialBatch(input.feedback, options.scope)];
      const batch = mergeContentBatches([input, ...feedback]);
      if (!batch.ok) return batch;

      if (!options.enabled()) return { ok: false as const, reason: "collect_disabled" };

      const packetInput = { ...batch.value, scope: options.scope, domain: options.domain, boardSequence: loaded.state.sequence,
        ...(focus === undefined ? {} : { focus }), ...(input.requestedRefs === undefined ? {} : { requestedRefs: input.requestedRefs }) };
      if (!isContentDataSafe(packetInput, options, secrets)) return { ok: false as const, reason: "topic_sensitive_content" };

      // Read old public applications from their original immutable facts before the new semantic steps.
      const previous = await retrieveContentPacket(packetInput,
        createBoardContentSource(loaded.state.rewardV2Facts ?? [], options.scope, loaded.state.sequence,
          record => canReadNativeContentRecord(loaded.state, options.scope, record, { ...options.nativeAccess,
            inspectionIssueIds: [...(options.nativeAccess?.inspectionIssueIds ?? []), ...(focus === undefined ? [] : [focus.issueId])] }),
          contentRecallMaterialBatch), signal);
      if (!previous.ok) return previous;

      if (!isContentDataSafe(previous.value, options, secrets)) return { ok: false as const, reason: "topic_sensitive_content" };

      if (source === undefined) return previous;

      const { schemaVersion: _version, packetId: _id, retrieval, ...priorInput } = previous.value;
      const retrieved = await retrieveContentPacket({ ...priorInput, requestedRefs: retrieval.requestedRefs }, source, signal);
      if (retrieved.ok && !isContentDataSafe(retrieved.value, options, secrets)) return { ok: false as const, reason: "topic_sensitive_content" };

      return retrieved;
    },

    /** Save every public result, including no-new-topic/Preparation, then feed only the selected residual to WS1.
     * A stale second append can be resumed with these same immutable inputs, without another model call. */
    async publish(packet: ContentPacket, output: ContentProcessOutput, expectedWriteRevision: number): Promise<ContentPublication> {
      if (!options.enabled()) return { status: "disabled" };

      if (suspended) return { status: "rejected", reason: "content_writer_suspended" };

      if (packet.scope !== options.scope || packet.domain !== options.domain) return { status: "rejected", reason: "content_owner_mismatch" };

      if (!Number.isSafeInteger(expectedWriteRevision) || expectedWriteRevision < packet.boardSequence) return { status: "rejected", reason: "content_write_revision_invalid" };

      if (!isContentDataSafe([packet, output], options, secrets)) return { status: "rejected", reason: "topic_sensitive_content" };

      let fact;

      try { fact = buildContentRecord(packet, output); }
      catch (error) { return { status: "rejected", reason: error instanceof Error ? error.message : "content_record_invalid" }; }

      const handoff = buildContentTopicHandoff(packet, output);
      let saved;

      try { saved = await board.append(expectedWriteRevision, fact); }
      catch {
        suspended = true; // Append may have committed. Never repeat an unknown write within this writer instance.
        return { status: "rejected", reason: "content_board_write_unconfirmed" };
      }

      if (saved.status === "stale") return { status: "stale" };

      if (!handoff.ok) return { status: "topic_pending", factId: fact.id, revision: saved.revision, reason: handoff.reason };

      if (handoff.value.kind !== "new_topic") return { status: "content_saved", factId: fact.id, revision: saved.revision, handoff: handoff.value.kind };

      const topic = await topics.ingest(handoff.value.proposalJson, handoff.value.windowJson, saved.revision);

      return topic.status === "persisted" ? { status: "published", factId: fact.id, revision: topic.revision, topicId: topic.topic.topicId }
        : { status: "topic_pending", factId: fact.id, revision: saved.revision,
          reason: topic.status === "rejected" ? topic.reason : topic.status };
    },

    async read() {
      if (!options.enabled()) throw new Error("collect_disabled");
      const snapshot = await createBoardReader(options.boardRoot).load();
      if (!snapshot.ok) throw new Error(snapshot.reason);
      if (!options.enabled()) throw new Error("collect_disabled");
      return { revision: snapshot.state.sequence, records: readContentRecords(snapshot.state.rewardV2Facts ?? [], options.scope, snapshot.state.sequence)
        .filter(record => canReadNativeContentRecord(snapshot.state, options.scope, record, options.nativeAccess)) };
    },
  });
}

/** Stable semantic inputs for an owner already handling budget reservations, without exposing a mutable object. */
export const serializeContentPacket = (packet: ContentPacket): string => canonicalJson(packet);
