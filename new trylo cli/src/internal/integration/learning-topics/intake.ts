import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import type { GroundedLearningTopic, TopicFailureReason } from "../../learning/domains/shared/topics/contracts.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { isActiveTopicDomain } from "./active-domain.js";
import { isRedactedTopicData, isRedactedCanonicalTopicWindow } from "./confidentiality.js";
import { parseTopicWindow } from "../../learning/domains/shared/topics/parse.js";

type IntakeOptions = {
  readonly boardRoot: string;
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly algorithmVersion: string;
  readonly enabled?: () => boolean;
  /** Known host credentials are compared in memory, never persisted in the topic record. */
  readonly secrets?: readonly string[];
  /** Explicit canonical workspace metadata; evidence prose retains the original path/secret policy. */
  readonly identityPolicy?: "canonical_scope";
};

type IntakeFailure = TopicFailureReason | "topic_owner_mismatch" | "topic_board_write_unconfirmed" | "topic_writer_suspended" | "topic_write_revision_invalid" | "topic_domain_retired" | "topic_sensitive_content";

export type TopicIntakeResult =
  | { readonly status: "disabled" }
  | { readonly status: "no_topic"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: IntakeFailure }
  | { readonly status: "stale" }
  | { readonly status: "persisted"; readonly topic: GroundedLearningTopic; readonly revision: number; readonly idempotent: boolean };

/** Explicit host composition. Topics share Board's existing writer; this port grants no execution rights. */
export function createPersistentTopicIntake(options: IntakeOptions) {
  const enabled = options.enabled ?? (() => false);
  const secrets = Object.freeze([...(options.secrets ?? [])]);

  if (!options.scope || options.scope.length > 256 || !options.algorithmVersion || options.algorithmVersion.length > 256) {
    throw new Error("topic_owner_identity_required");
  }

  const board = createRewardV2BoardPort(options.boardRoot, enabled);
  let suspended = false;

  return Object.freeze({
    inspect: () => ({ suspended }),

    async ingest(proposalJson: string, windowJson: string, expectedWriteRevision?: number): Promise<TopicIntakeResult> {
      if (!enabled()) return { status: "disabled" };

      if (!isActiveTopicDomain(options.domain)) return { status: "rejected", reason: "topic_domain_retired" };

      if (suspended) return { status: "rejected", reason: "topic_writer_suspended" };

      const submission = readTopicSubmission(proposalJson, windowJson);
      if (!submission.ok) return { status: "rejected", reason: submission.reason };

      const owner = submission.value.kind === "topic" ? submission.value.topic : submission.value;
      if (owner.scope !== options.scope || owner.domain !== options.domain) return { status: "rejected", reason: "topic_owner_mismatch" };

      const proposal = JSON.parse(proposalJson) as unknown, evidenceWindow = JSON.parse(windowJson) as unknown;
      const window = options.identityPolicy === undefined ? undefined : parseTopicWindow(windowJson);
      const safe = window === undefined ? isRedactedTopicData([proposal, evidenceWindow], secrets)
        : window.ok && isRedactedTopicData(proposal, secrets) && isRedactedCanonicalTopicWindow(window.value, options.scope, secrets);
      if (!safe) return { status: "rejected", reason: "topic_sensitive_content" };

      if (submission.value.kind === "no_topic") return { status: "no_topic", reason: submission.value.reason };

      const topic = submission.value.topic;
      const writeRevision = expectedWriteRevision ?? topic.basis.boardSequence;
      if (!Number.isSafeInteger(writeRevision) || writeRevision < topic.basis.boardSequence) {
        return { status: "rejected", reason: "topic_write_revision_invalid" };
      }

      // Keep the admitted, host-redacted evidence window and draft together so replay can recheck grounding.
      // Canonical JSON makes whitespace/key ordering changes idempotent without losing actual source text.
      const payloadJson = canonicalJson({ schemaVersion: 1, type: "ws1_topic_candidate",
        proposal, evidenceWindow });
      const id = `ws1:${contentHashOf({ scope: options.scope, algorithmVersion: options.algorithmVersion, payloadJson })}`;

      try {
        // The model's knowledge prefix stays immutable; only the host's commit precondition may advance.
        const write = await board.append(writeRevision, {
          id, scope: options.scope, algorithmVersion: options.algorithmVersion, kind: "opportunity", payloadJson,
        });
        if (write.status === "stale") return { status: "stale" };
        return { status: "persisted", topic, revision: write.revision, idempotent: write.idempotent };
      } catch {
        // A thrown Board append may have committed: stop writes, never retry or invent a known rejection.
        suspended = true;
        return { status: "rejected", reason: "topic_board_write_unconfirmed" };
      }
    },
  });
}
