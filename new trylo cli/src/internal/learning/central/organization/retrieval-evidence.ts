import { canonicalJson } from "../../control/hash.js";
import type { OrganizationFeedback, OrganizationKnowledge, OrganizationProjection, OrganizationRecallEvidenceCoverage, OrganizationStored } from "./contracts.js";
import { organizationFeedbackKey } from "./retrieval-v1.js";
import { organizationEvidenceReadRef } from "./addresses.js";

export type OrganizationEvidenceRole = "registered_support" | "registered_counterexample" | "exact_exposure_context" | "same_decision_related_not_causal";

export interface OrganizationEvidenceItem extends OrganizationStored<OrganizationFeedback> {
  readonly roles: readonly OrganizationEvidenceRole[];
  readonly citedFactIds: readonly string[];
}

export interface OrganizationEvidenceIndex {
  readonly items: readonly OrganizationEvidenceItem[];
  readonly inlineOrder: readonly OrganizationEvidenceItem[];
  readonly asOfSequence: number;
  readonly supportCount: number;
  readonly counterexampleCount: number;
  readonly relatedCount: number;
  readonly revisions: readonly { readonly citedFactId: string; readonly effectiveFactId: string }[];
}

/** Each original feedback head keeps its identity and role. Same exposure never
 * coalesces an adoption, an outcome and a registered counterexample into one. */
export function organizationEvidenceIndex(view: OrganizationProjection, knowledge: OrganizationStored<OrganizationKnowledge>): OrganizationEvidenceIndex {
  const heads = new Map(view.feedback.map(row => [organizationFeedbackKey(row.value), row]));
  const history = new Map(view.feedbackHistory.map(row => [row.factId, row]));
  const items = new Map<string, { readonly row: OrganizationStored<OrganizationFeedback>; readonly roles: Set<OrganizationEvidenceRole>; readonly cited: Set<string> }>();
  const revisions: { citedFactId: string; effectiveFactId: string }[] = [];
  const add = (row: OrganizationStored<OrganizationFeedback>, role: OrganizationEvidenceRole, cited?: string) => {
    let item = items.get(row.factId);
    if (item === undefined) {
      item = { row, roles: new Set(), cited: new Set() };
      items.set(row.factId, item);
    }
    item.roles.add(role);
    if (cited !== undefined) item.cited.add(cited);
  };
  const follow = (refs: readonly string[], role: OrganizationEvidenceRole) => {
    for (const id of refs) {
      const cited = history.get(id), current = cited === undefined ? undefined : heads.get(organizationFeedbackKey(cited.value));
      if (current === undefined) throw new Error("organization_knowledge_evidence_missing");
      add(current, role, id);
      if (current.factId !== id && !revisions.some(row => row.citedFactId === id)) revisions.push({ citedFactId: id, effectiveFactId: current.factId });
    }
  };

  follow(knowledge.value.counterexampleFactIds, "registered_counterexample");
  follow(knowledge.value.supportFactIds, "registered_support");
  const decisions = new Set([...items.values()].map(item => item.row.value.decisionRef));

  // A shared frozen decision is a navigation relation, not a verdict about this
  // knowledge. Its later exposures/observations remain pageable, never mandatory
  // copies that can evict the knowledge or establish extra independent trials.
  for (const row of view.feedback) if (decisions.has(row.value.decisionRef) && !items.has(row.factId)) add(row, "same_decision_related_not_causal");

  const outcomes = [...items.values()].filter(item => item.row.value.result.kind === "outcome"
    && (item.roles.has("registered_support") || item.roles.has("registered_counterexample")));

  for (const item of outcomes) {
    const result = item.row.value.result;
    if (result.kind !== "outcome" || result.exposureRef === null) continue;
    for (const row of view.feedback) if (row.value.decisionRef === item.row.value.decisionRef && row.value.result.kind === "adoption"
      && row.value.result.exposureRef === result.exposureRef) add(row, "exact_exposure_context");
  }

  const list: OrganizationEvidenceItem[] = [...items.values()].map(item => ({ ...item.row, roles: [...item.roles].sort(), citedFactIds: [...item.cited].sort() }));
  const priority = (item: OrganizationEvidenceItem) => item.roles.includes("registered_counterexample") ? 0
    : item.roles.includes("registered_support") ? 1 : item.value.result.kind === "correction" || item.value.result.kind === "outcome" ? 2
    : item.value.result.kind === "adoption" && item.value.result.state !== "used" ? 3 : item.roles.includes("exact_exposure_context") ? 4 : 5;

  list.sort((a, b) => priority(a) - priority(b) || b.sequence - a.sequence || a.factId.localeCompare(b.factId));

  return { items: list, inlineOrder: list.filter(item => item.roles.includes("registered_support")
    || item.roles.includes("registered_counterexample") || item.roles.includes("exact_exposure_context")),
    asOfSequence: list.reduce((latest, item) => Math.max(latest, item.sequence), knowledge.sequence),
    supportCount: new Set(knowledge.value.supportFactIds).size, counterexampleCount: new Set(knowledge.value.counterexampleFactIds).size,
    relatedCount: list.filter(item => !item.roles.includes("registered_support") && !item.roles.includes("registered_counterexample")).length,
    revisions };
}

/** Navigation metadata describes unread original heads, without assigning a
 * causal verdict or treating any address as an actually delivered body. */
export function organizationEvidenceCoverage(index: OrganizationEvidenceIndex, factId: string,
  delivered: readonly OrganizationStored<OrganizationFeedback>[]): OrganizationRecallEvidenceCoverage {
  const deliveredIds = new Set(delivered.map(row => row.factId));
  const unreadByKind = { progress: 0, cost: 0, adoption: 0, outcome: 0, correction: 0 };
  let priorityReadRef: string | null = null;

  for (let offset = 0; offset < index.items.length; offset++) {
    const item = index.items[offset]!;
    if (deliveredIds.has(item.factId)) continue;

    const result = item.value.result;
    unreadByKind[result.kind]++;

    if (priorityReadRef === null && (result.kind === "outcome" || result.kind === "correction"
      || result.kind === "adoption" && result.state !== "used")) {
      priorityReadRef = organizationEvidenceReadRef(factId, index.asOfSequence, offset);
    }
  }

  return { asOfSequence: index.asOfSequence, total: index.items.length, delivered: deliveredIds.size,
    unread: index.items.length - deliveredIds.size, unreadByKind, priorityReadRef,
    citedSupportCount: index.supportCount, citedCounterexampleCount: index.counterexampleCount, relatedCount: index.relatedCount,
    readRef: organizationEvidenceReadRef(factId, index.asOfSequence), interpretation: "unread_is_unknown_adoption_is_exposure_not_validation" };
}

export interface OrganizationEvidencePage {
  readonly schemaVersion: 1;
  readonly role: "organization_feedback_evidence_page_not_quality_verdict";
  readonly knowledgeFactId: string;
  readonly asOfSequence: number;
  readonly offset: number;
  readonly total: number;
  readonly items: readonly OrganizationEvidenceItem[];
  readonly notDelivered: readonly { readonly factId: string; readonly readRef: string; readonly originalCharacters: number;
    readonly roles: readonly OrganizationEvidenceRole[]; readonly citedFactIds: readonly string[] }[];
  readonly nextReadRef: string | null;
  readonly interpretation: "unread_is_unknown_adoption_is_exposure_not_validation";
}

/** A finite source page, at most 64 complete bodies and the actual character
 * budget. Oversized individual bodies remain explicit unread exact addresses. */
export function retrieveOrganizationEvidencePage(view: OrganizationProjection, factId: string, offset: number,
  maximumCharacters: number): OrganizationEvidencePage {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximumCharacters)
    || maximumCharacters < 512 || maximumCharacters > 24000) throw new Error("organization_evidence_query_invalid");

  const knowledge = view.knowledge.find(row => row.factId === factId);
  if (knowledge === undefined) throw new Error("organization_knowledge_head_missing");

  const index = organizationEvidenceIndex(view, knowledge), items: OrganizationEvidenceItem[] = [];
  const notDelivered: OrganizationEvidencePage["notDelivered"][number][] = [];
  let through = offset;
  const page = (): OrganizationEvidencePage => ({ schemaVersion: 1, role: "organization_feedback_evidence_page_not_quality_verdict",
    knowledgeFactId: factId, asOfSequence: index.asOfSequence, offset, total: index.items.length, items, notDelivered,
    nextReadRef: through < index.items.length ? organizationEvidenceReadRef(factId, index.asOfSequence, through) : null,
    interpretation: "unread_is_unknown_adoption_is_exposure_not_validation" });

  while (through < index.items.length && items.length + notDelivered.length < 64) {
    const item = index.items[through]!;
    items.push(item);
    through++;

    if (canonicalJson(page()).length <= maximumCharacters) continue;

    items.pop();
    through--;

    if (items.length + notDelivered.length > 0) break;

    notDelivered.push({ factId: item.factId, readRef: item.factId, originalCharacters: canonicalJson(item).length,
      roles: item.roles, citedFactIds: item.citedFactIds });
    through++;
    break;
  }

  const result = page();
  if (canonicalJson(result).length > maximumCharacters) throw new Error("organization_evidence_page_capacity");

  return result;
}
