import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix } from "../../reward/v2-facts.js";
import type { RewardV2Draft, RewardV2Fact } from "../../reward/v2-facts.js";
import { fields, sequence } from "../../../validation/json-shape.js";
import { isOrganizationRecord } from "./validation.js";
import { organizationFeedbackKey, retrieveOrganizationExperience } from "./retrieval.js";
import { retrieveOrganizationExperienceV1, retrieveLegacyOrganizationExperience } from "./retrieval-v1.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge, OrganizationProjection,
  OrganizationRecord, OrganizationStored } from "./contracts.js";

export const ORGANIZATION_ALGORITHM = "central-learning-organization-v1";

export function buildOrganizationRecord(scope: string, value: OrganizationRecord): RewardV2Draft {
  if (!isOrganizationRecord(value)) throw new Error("organization_record_invalid");

  const payloadJson = canonicalJson({ schemaVersion: 1, type: "central_learning_organization", value });
  const draft: RewardV2Draft = { id: `organization-record:${contentHashOf({ scope, payloadJson })}`, scope,
    kind: value.kind === "decision" ? "learning_decision" : value.kind === "feedback" ? "feedback" : "projection",
    algorithmVersion: ORGANIZATION_ALGORITHM, payloadJson };
  if (!isRewardV2Draft(draft)) throw new Error("organization_record_capacity");

  return draft;
}

/** Strict replay at an original Board prefix; only this algorithm is interpreted.
 * Revisions replace heads. Derived knowledge never increments an outcome count. */
export function readOrganizationRecords(facts: readonly RewardV2Fact[], scope: string, boardSequence: number): OrganizationProjection {
  if (!sequence(boardSequence) || !facts.every(isRewardV2Fact) || !validRewardV2Prefix(facts, boardSequence)) {
    throw new Error("organization_board_prefix_invalid");
  }

  const decisions = new Map<string, OrganizationStored<OrganizationDecision>>();
  const feedback = new Map<string, OrganizationStored<OrganizationFeedback>>();
  const feedbackHistory: OrganizationStored<OrganizationFeedback>[] = [];
  const knowledge = new Map<string, OrganizationStored<OrganizationKnowledge>>();
  const view = (): OrganizationProjection => ({ scope, decisions: [...decisions.values()], feedback: [...feedback.values()],
    feedbackHistory, knowledge: [...knowledge.values()] });

  for (const fact of facts) {
    if (fact.scope !== scope || fact.algorithmVersion !== ORGANIZATION_ALGORITHM) continue;

    const raw: unknown = JSON.parse(fact.payloadJson);
    if (!fields(raw, ["schemaVersion", "type", "value"]) || raw.schemaVersion !== 1
      || raw.type !== "central_learning_organization" || !isOrganizationRecord(raw.value)) throw new Error("organization_record_corrupt");

    const value = raw.value, rebuilt = buildOrganizationRecord(scope, value);
    if (rebuilt.id !== fact.id || rebuilt.kind !== fact.kind || rebuilt.payloadJson !== fact.payloadJson) throw new Error("organization_record_identity");

    if (value.kind === "decision") {
      if (decisions.has(value.decisionRef)) throw new Error("organization_decision_conflict");

      if (value.experienceUse !== null) {
        const use = value.experienceUse;
        const retrieve = use.packet.schemaVersion === 2 ? retrieveOrganizationExperience
          : use.packet.navigation === undefined ? retrieveLegacyOrganizationExperience : retrieveOrganizationExperienceV1;
        if (use.packet.scope !== scope || canonicalJson(retrieve(view(), use.packet.query)) !== canonicalJson(use.packet)) {
          throw new Error("organization_recall_stale_or_invalid");
        }

        const delivered = new Set(use.packet.entries.map(entry => entry.factId));
        if (use.changes.some(change => !delivered.has(change.knowledgeFactId)
          || change.choice !== "unchanged" && change.before === change.after)) throw new Error("organization_use_not_delivered");
      }

      decisions.set(value.decisionRef, { factId: fact.id, sequence: fact.sequence, value });
    } else if (value.kind === "feedback") {
      if (!decisions.has(value.decisionRef)) throw new Error("organization_feedback_decision_missing");

      const key = organizationFeedbackKey(value), previous = feedback.get(key);
      if ((previous?.factId ?? null) !== value.supersedes) throw new Error("organization_feedback_revision_conflict");

      if (value.result.kind === "outcome" && value.result.state === "observed") {
        const exposure = value.result.exposureRef;
        if (![...feedback.values()].some(row => row.value.decisionRef === value.decisionRef && row.value.result.kind === "adoption"
          && row.value.result.state === "used" && row.value.result.exposureRef === exposure)) throw new Error("organization_outcome_not_exposed");
      }

      const stored = { factId: fact.id, sequence: fact.sequence, value };

      feedback.set(key, stored);
      feedbackHistory.push(stored);
    } else {
      const previous = knowledge.get(value.knowledgeId);
      if ((previous?.factId ?? null) !== value.supersedes) throw new Error("organization_knowledge_revision_conflict");
      const heads = new Set([...feedback.values()].map(row => row.factId));
      if ([...value.supportFactIds, ...value.counterexampleFactIds].some(id => !heads.has(id))) throw new Error("organization_knowledge_source_not_current");
      knowledge.set(value.knowledgeId, { factId: fact.id, sequence: fact.sequence, value });
    }
  }

  return view();
}
