import { createRewardV2BoardPort, readRewardV2BoardReason, readRewardV2BoardWriteOutcome } from "../reward/v2-board-port.js";
import { isContentDataSafe } from "../learning-content/content-confidentiality.js";
import { buildOrganizationRecord, readOrganizationRecords, retrieveOrganizationExperience } from "../../learning/central/organization/index.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge, OrganizationRecord,
  OrganizationRecallQuery } from "../../learning/central/organization/index.js";
import type { OrganizationProjection, OrganizationStored } from "../../learning/central/organization/index.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import { retrieveOrganizationEvidencePage } from "../../learning/central/organization/retrieval-evidence.js";

export interface CentralOrganizationOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly enabled: () => boolean;
  readonly secrets?: readonly string[];
  /** Tests can replace the same original Board port; not an alternative store owner. */
  readonly board?: ReturnType<typeof createRewardV2BoardPort>;
}

export type OrganizationPublication = { readonly status: "saved"; readonly factId: string; readonly revision: number; readonly idempotent: boolean }
  | { readonly status: "disabled" | "stale" }
  | { readonly status: "rejected"; readonly reason: string };

export interface OrganizationPublicationPurposeEvidence {
  readonly feedbackFactId: string;
  readonly decisionRef: string;
  readonly purposeRef: string;
  readonly issueRefs: readonly string[];
}

export type OrganizationKnowledgeProposal = OrganizationPublication | {
  readonly status: "candidate_rejected";
  readonly reason: "organization_knowledge_revision_conflict" | "organization_knowledge_source_not_current";
  readonly revision: number;
  /** Address of the rejected candidate if published; this is not a committed fact. */
  readonly candidateFactId: string;
  readonly currentHead: OrganizationStored<OrganizationKnowledge> | null;
  readonly evidenceRevisions: readonly { readonly citedFactId: string; readonly effectiveFactId: string | null }[];
  readonly purposeEvidence: readonly OrganizationPublicationPurposeEvidence[];
};

const reasonOf = (error: unknown) => error instanceof Error ? error.message : "organization_operation_failed";

/** One original organization export policy, shared by publication and exact reads. */
export function isOrganizationRecordContentSafe(record: OrganizationRecord, options: Pick<CentralOrganizationOptions, "scope">,
  secrets: readonly string[]): boolean {
  if (record.kind !== "decision" || record.experienceUse === null) return isContentDataSafe(record, options, secrets);
  const use = record.experienceUse;
  return use.packet.scope === options.scope && isContentDataSafe({ ...record, experienceUse: {
    ...use, packet: { ...use.packet, scope: "[canonical_scope]" } } }, options, secrets);
}

export function organizationKnowledgeEvidenceRevisions(projection: OrganizationProjection, record: OrganizationKnowledge) {
  const history = new Map(projection.feedbackHistory.map(row => [row.factId, row]));
  const heads = new Map(projection.feedback.map(row => [organizationFeedbackKey(row.value), row]));
  return [...new Set([...record.supportFactIds, ...record.counterexampleFactIds])].map(citedFactId => {
    const cited = history.get(citedFactId);
    return { citedFactId, effectiveFactId: cited === undefined ? null : heads.get(organizationFeedbackKey(cited.value))?.factId ?? null };
  });
}

export function organizationPublicationPurposeEvidence(projection: OrganizationProjection, record: OrganizationKnowledge): readonly OrganizationPublicationPurposeEvidence[] {
  const history = new Map(projection.feedbackHistory.map(row => [row.factId, row]));
  const decisions = new Map(projection.decisions.map(row => [row.value.decisionRef, row.value]));

  return [...new Set([...record.supportFactIds, ...record.counterexampleFactIds])].flatMap(feedbackFactId => {
    const feedback = history.get(feedbackFactId), decision = feedback === undefined ? undefined : decisions.get(feedback.value.decisionRef);
    return decision === undefined ? [] : [{ feedbackFactId, decisionRef: decision.decisionRef,
      purposeRef: decision.purposeRef, issueRefs: decision.issueRefs }];
  });
}

/** Original RewardV2 Board writer/CAS only. No model, autonomous reflection,
 * scheduling notification, asset writer or second organization-memory database. */
export function createCentralOrganizationService(options: CentralOrganizationOptions) {
  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled);
  const secrets = [...(options.secrets ?? [])];
  let suspended = false;
  const safe = (record: OrganizationRecord) => isOrganizationRecordContentSafe(record, options, secrets);
  const read = async () => {
    if (!options.enabled()) return { status: "disabled" as const };
    try {
      const snapshot = await board.read();
      if (!options.enabled()) return { status: "disabled" as const };
      const projection = readOrganizationRecords(snapshot.facts, options.scope, snapshot.revision);
      if (!safeProjection(projection)) return { status: "rejected" as const, reason: "organization_sensitive_content" };
      return { status: "ready" as const, revision: snapshot.revision, projection };
    } catch (error) { return { status: "rejected" as const, reason: reasonOf(error) }; }
  };
  const safeProjection = (projection: OrganizationProjection) =>
    [...projection.decisions, ...projection.feedbackHistory, ...projection.knowledge].every(row => safe(row.value));

  async function publish(record: OrganizationRecord, expectedRevision: number): Promise<OrganizationPublication>;

  async function publish(record: OrganizationKnowledge, expectedRevision: number, candidateMode: true): Promise<OrganizationKnowledgeProposal>;

  async function publish(record: OrganizationRecord, expectedRevision: number, candidateMode = false): Promise<OrganizationKnowledgeProposal> {
    if (!options.enabled()) return { status: "disabled" };

    if (suspended) return { status: "rejected", reason: "organization_writer_suspended" };

    let draft: ReturnType<typeof buildOrganizationRecord>, snapshot: Awaited<ReturnType<typeof board.read>>;
    let projection: OrganizationProjection;

    try {
      draft = buildOrganizationRecord(options.scope, record);

      if (!safe(record)) return { status: "rejected", reason: "organization_sensitive_content" };

      snapshot = await board.read();

      if (!options.enabled()) return { status: "disabled" };

      projection = readOrganizationRecords(snapshot.facts, options.scope, snapshot.revision);

      if (!safeProjection(projection)) return { status: "rejected", reason: "organization_sensitive_content" };

      const existing = snapshot.facts.find(fact => fact.id === draft.id);
      if (existing !== undefined) {
        return { status: "saved", factId: existing.id, revision: snapshot.revision, idempotent: true };
      }

      if (snapshot.revision !== expectedRevision) return { status: "stale" };
    } catch (error) { return { status: "rejected", reason: reasonOf(error) }; }

    try {
      // Validate all causal/revision relations against this actual prefix before
      // using the same CAS at the original writer. A concurrent append returns stale.
      readOrganizationRecords([...snapshot.facts, { ...draft, sequence: snapshot.revision + 1 }], options.scope, snapshot.revision + 1);
    } catch (error) {
      const reason = reasonOf(error);

      // Only a prospective candidate may be repaired. The original prefix above
      // already passed strict replay and safety; no append has been attempted.
      if (candidateMode && record.kind === "knowledge" && (reason === "organization_knowledge_revision_conflict"
        || reason === "organization_knowledge_source_not_current")) {
        return { status: "candidate_rejected", reason, revision: snapshot.revision, candidateFactId: draft.id,
          currentHead: projection.knowledge.find(row => row.value.knowledgeId === record.knowledgeId) ?? null,
          evidenceRevisions: organizationKnowledgeEvidenceRevisions(projection, record),
          purposeEvidence: organizationPublicationPurposeEvidence(projection, record) };
      }

      return { status: "rejected", reason };
    }

    if (!options.enabled()) return { status: "disabled" };

    try {
      const saved = await board.append(expectedRevision, draft);
      return saved.status === "stale" ? { status: "stale" }
        : { status: "saved", factId: draft.id, revision: saved.revision, idempotent: saved.idempotent };
    } catch (error) {
      // Admission refused before the callback ran: no command or uncertain
      // outcome exists. Let the original CAS wait re-read after contention.
      if (readRewardV2BoardReason(error) === "multi_writer" && readRewardV2BoardWriteOutcome(error) === "not_started") {
        return { status: "stale" };
      }

      suspended = true; // Unknown append outcome: re-read via a new service, never blind retry here.
      return { status: "rejected", reason: "organization_write_unconfirmed" };
    }
  }

  return Object.freeze({
    read,

    async readRecallEvidence(input: { readonly factId: string; readonly asOfSequence: number; readonly offset: number;
      readonly maximumCharacters: number }, signal: AbortSignal) {
      if (signal.aborted) return { status: "rejected" as const, reason: "organization_recall_cancelled" };

      if (!options.enabled()) return { status: "disabled" as const };

      try {
        const snapshot = await board.read();

        if (signal.aborted) return { status: "rejected" as const, reason: "organization_recall_cancelled" };

        if (!options.enabled()) return { status: "disabled" as const };

        if (!Number.isSafeInteger(input.asOfSequence) || input.asOfSequence < 0 || input.asOfSequence > snapshot.revision) {
          return { status: "rejected" as const, reason: "organization_evidence_prefix_invalid" };
        }

        const current = readOrganizationRecords(snapshot.facts, options.scope, snapshot.revision);
        if (!safeProjection(current)) return { status: "rejected" as const, reason: "organization_sensitive_content" };

        const prefix = readOrganizationRecords(snapshot.facts.filter(row => row.sequence <= input.asOfSequence), options.scope, input.asOfSequence);
        if (!safeProjection(prefix)) return { status: "rejected" as const, reason: "organization_sensitive_content" };

        const page = retrieveOrganizationEvidencePage(prefix, input.factId, input.offset, input.maximumCharacters);
        if (page.asOfSequence !== input.asOfSequence) return { status: "rejected" as const, reason: "organization_evidence_prefix_invalid" };

        if (!isContentDataSafe(page, options, secrets)) return { status: "rejected" as const, reason: "organization_sensitive_content" };

        return { status: "ready" as const, page };
      } catch (error) { return { status: "rejected" as const, reason: reasonOf(error) }; }
    },

    async readFeedback(factId: string, signal?: AbortSignal) {
      const cancelled = () => signal?.aborted === true;
      if (cancelled()) return { status: "rejected" as const, reason: "organization_feedback_cancelled" };

      if (!/^organization-record:[a-f0-9]{64}$/.test(factId)) return { status: "rejected" as const, reason: "organization_feedback_address_invalid" };

      const loaded = await read();
      if (loaded.status !== "ready") return loaded;

      if (cancelled()) return { status: "rejected" as const, reason: "organization_feedback_cancelled" };

      // Historical superseded bodies retain their immutable source identity.
      return { status: "ready" as const, revision: loaded.revision,
        feedback: loaded.projection.feedbackHistory.find(row => row.factId === factId) ?? null };
    },

    async prepareRecall(query: OrganizationRecallQuery, signal?: AbortSignal) {
      if (signal?.aborted === true) return { status: "rejected" as const, reason: "organization_recall_cancelled" };
      const loaded = await read();
      if (loaded.status !== "ready") return loaded;
      try {
        const packet = retrieveOrganizationExperience(loaded.projection, query);
        return { status: "ready" as const, packet, revision: loaded.revision };
      } catch (error) { return { status: "rejected" as const, reason: reasonOf(error) }; }
    },

    freezeDecision: (decision: OrganizationDecision, expectedRevision: number) => publish(decision, expectedRevision),
    observe: (feedback: OrganizationFeedback, expectedRevision: number) => publish(feedback, expectedRevision),
    reviseKnowledge: (knowledge: OrganizationKnowledge, expectedRevision: number) => publish(knowledge, expectedRevision),
    proposeKnowledge: (knowledge: OrganizationKnowledge, expectedRevision: number) => publish(knowledge, expectedRevision, true),
  });
}
