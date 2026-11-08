import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { readOrganizationRecords } from "../../learning/central/organization/records.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import type { CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimePrefix, readCentralRuntimePurposeHeads } from "../../learning/central/runtime/records.js";
import { centralAdvisoryKnowledgeHash, readCentralAdvisoryRecords } from "./central-advisory-records.js";
import { organizationDecisionForOperation } from "./organization-feedback-runtime.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { readAppliedCentralAdvisoryDecisions } from "./central-advisory-applied-decisions.js";

type Reconsideration = NonNullable<Awaited<ReturnType<CentralRuntimeSourcePort["snapshot"]>>["reconsider"]>[number];

interface FeedbackProjection {
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly reconsider: readonly Reconsideration[];
  readonly sourceRefs: readonly string[];
  readonly hasMore: boolean;
}

const empty = (): FeedbackProjection => ({ materials: [], reconsider: [], sourceRefs: [], hasMore: false });

/** Wake/peer addresses select original facts, not a claimed purpose identity.
 * Native active purposes also recover unseen feedback after a missed wake;
 * a caller-supplied address cannot reactivate an ended purpose.
 * The publication, actual feedback computation and archived purpose authenticate
 * the subject to recall. This projection neither resumes a purpose nor values use. */
export function readCentralAdvisoryFeedback(board: BoardState, scope: string,
  requestedSourceRefs: readonly string[], knownSourceRefs: readonly string[] = [], maximumChars = 12000,
  activePurposeRefs: readonly string[] = []): FeedbackProjection {
  if (requestedSourceRefs.length === 0 && activePurposeRefs.length === 0) return empty();

  const requested = new Set(requestedSourceRefs), known = new Set(knownSourceRefs), facts = board.rewardV2Facts ?? [];
  const purposes = new Map(readCentralRuntimePurposeHeads(facts, scope, board.sequence).map(row => [row.intent.intentId, row]));
  const activeIds = new Set(activePurposeRefs.filter(ref => {
    const head = purposes.get(ref);
    return head !== undefined && head.intent.continuation.kind !== "ended";
  }));
  const authorities = new Map(readAppliedCentralAdvisoryDecisions(facts, scope, board.sequence)
    .map(row => [row.appliedStateRef, row]));
  const publications = new Map(readCentralAdvisoryRecords(facts, scope, board.sequence)
    .flatMap(row => {
      if (row.value.kind !== "publish") return [];

      const value = row.value, authority = authorities.get(value.appliedStateRef);
      if (authority === undefined || authority.appliedSequence !== value.appliedSequence
        || authority.deliveryRef !== value.deliveryRef || authority.decisionRef !== value.decisionRef
        || authority.request.budgetId !== value.budgetId || !authority.output.knowledgeHandoffs?.some(action => action.kind === "publish"
          && action.intentId === value.intentId && action.knowledgeHash === value.knowledgeHash
          && action.whenRelevant === value.whenRelevant && action.uncertainty === value.uncertainty)) return [];

      return [[row.ref, { ...row, value }] as const];
    }));
  if (publications.size === 0) return empty();

  const organization = readOrganizationRecords(facts, scope, board.sequence);
  const decisions = new Map(organization.decisions.map(row => [row.value.decisionRef, row.value]));
  const requestedUnits = new Set(organization.feedbackHistory.filter(row => requested.has(row.factId))
    .map(row => organizationFeedbackKey(row.value)));
  const matches = organization.feedback.flatMap(feedback => feedback.value.sourceRefs.flatMap(ref => {
    const publication = publications.get(ref);
    if (publication === undefined || feedback.sequence <= publication.sequence
      || known.has(feedback.factId) || !requestedUnits.has(organizationFeedbackKey(feedback.value)) && !requested.has(ref)
        && !activeIds.has(publication.value.intentId)
      || !organizationDecisionForOperation(scope, decisions.get(feedback.value.decisionRef), publication.value.decisionRef)) return [];
    return [{ feedback, publication }];
  }));
  if (matches.length === 0) return empty();

  const snapshots = new Map(readCentralRuntimePrefix(facts, scope, board.sequence).map(row => [row.factRef, row]));
  const sequences = new Map(facts.map(fact => [fact.id, fact.sequence]));
  const verified = new Map<string, { feedback: typeof matches[number]["feedback"]; subjects: Map<string, Reconsideration["subject"]> }>();

  for (const { feedback, publication } of matches) {
    const value = publication.value, purpose = purposes.get(value.intentId);
    const original = snapshots.get(value.purposeHeadRef)?.state.intents.find(row => row.intentId === value.intentId);
    if (purpose === undefined || original === undefined
      || (sequences.get(value.purposeHeadRef) ?? Infinity) > value.appliedSequence
      || canonicalJson(original.subject) !== canonicalJson(purpose.intent.subject)
      || canonicalJson(original.conditions) !== canonicalJson(value.purposeConditions)
      || !original.knowledge.some(entry => centralAdvisoryKnowledgeHash(entry) === value.knowledgeHash)) continue;

    const row = verified.get(feedback.factId) ?? { feedback, subjects: new Map<string, Reconsideration["subject"]>() };

    row.subjects.set(canonicalJson(purpose.intent.subject), purpose.intent.subject);
    verified.set(feedback.factId, row);
  }

  const selected = [...verified.values()].slice(0, 8).map(row => {
    const material = createOrganizationFeedbackMaterial(scope, row.feedback.factId, row.feedback.value);
    // This is the original exact feedback read address, not a replacement body.
    // Navigation acknowledges existence only; the original inventory grants no
    // feedback support identity until its canonical full value is delivered.
    const text = canonicalJson({ role: "organization_feedback_not_delivered_capacity", readRef: row.feedback.factId,
      minimumCharacters: material.text.length, explanation: "No original feedback body was delivered. Read the original fact with sufficient maximumChars; this notice grants no feedback support identity." });
    const navigation: CentralRuntimeMaterial = { ref: `organization-capacity:${contentHashOf(text)}`, kind: "organization",
      text, sourceRefs: [row.feedback.factId] };

    return { ...row, material, navigation };
  });
  const materials: CentralRuntimeMaterial[] = [], reconsider: Reconsideration[] = [], sourceRefs: string[] = [];
  let remaining = Math.min(12000, Math.max(0, maximumChars));

  for (const [index, row] of selected.entries()) {
    const reservedNavigation = selected.slice(index + 1).reduce((total, other) => total + other.navigation.text.length, 0);
    const material = row.material.text.length <= remaining - reservedNavigation ? row.material : row.navigation;
    if (material.text.length > remaining) break;
    materials.push(material);
    remaining -= material.text.length;
    sourceRefs.push(row.feedback.factId);
    reconsider.push(...[...row.subjects.values()].map(subject => ({ subject, sourceRefs: [row.feedback.factId],
      reason: "original_central_advisory_feedback_changed" })));
  }

  return { materials, reconsider, sourceRefs, hasMore: verified.size > sourceRefs.length };
}
