import { canonicalJson, contentHashOf } from "../../control/hash.js";
import type { OrganizationFeedback, OrganizationProjection, OrganizationRecallEntry, OrganizationRecallPacket,
  OrganizationRecallQuery, OrganizationStored } from "./contracts.js";
import { isOrganizationRecallQuery } from "./validation.js";
import { organizationPurposeRelevance } from "./retrieval-relevance.js";

export const organizationFeedbackKey = (row: OrganizationFeedback): string =>
  canonicalJson([row.decisionRef, row.result.kind, row.unitRef]);
const normalized = (keys: readonly string[]) => new Set(keys.map(key => key.toLowerCase()));

function evidenceFor(view: OrganizationProjection, ids: readonly string[]) {
  const heads = new Map(view.feedback.map(row => [organizationFeedbackKey(row.value), row]));
  const history = new Map(view.feedbackHistory.map(row => [row.factId, row]));
  const evidence = new Map<string, OrganizationStored<OrganizationFeedback>>();
  const revisions: OrganizationRecallEntry["evidenceRevisions"][number][] = [];

  for (const id of ids) {
    const cited = history.get(id), current = cited === undefined ? undefined : heads.get(organizationFeedbackKey(cited.value));
    if (current === undefined) throw new Error("organization_knowledge_evidence_missing");
    evidence.set(current.factId, current);
    if (current.factId !== id) revisions.push({ citedFactId: id, effectiveFactId: current.factId });
  }

  // A later withdrawal or correction matters even if the knowledge cited only the
  // earlier outcome. Include those effective source heads without inventing trials.
  const decisions = new Set([...evidence.values()].map(row => row.value.decisionRef));

  for (const row of view.feedback) {
    if (decisions.has(row.value.decisionRef) && (row.value.result.kind === "adoption" || row.value.result.kind === "correction")) {
      evidence.set(row.factId, row);
    }
  }

  return { evidence: [...evidence.values()], evidenceRevisions: revisions };
}

function candidatesFor(view: OrganizationProjection, query: OrganizationRecallQuery, mode: "legacy" | "purpose") {
  const wanted = normalized(query.conditionKeys);
  const decisions = new Map(view.decisions.map(row => [row.value.decisionRef, row.value.context]));

  return view.knowledge.filter(row => row.value.state !== "withdrawn").flatMap(row => {
    const matchedConditions = row.value.conditionKeys.filter(key => wanted.has(key.toLowerCase()));
    const matchedExceptions = row.value.exceptionKeys.filter(key => wanted.has(key.toLowerCase()));
    const effective = evidenceFor(view, [...new Set([...row.value.supportFactIds, ...row.value.counterexampleFactIds])]);
    const sources = effective.evidence.flatMap(fact => fact.value.sourceRefs);
    const sourceMatch = query.sourceRefs.some(ref => sources.includes(ref));
    const contexts = [...new Set(effective.evidence.map(row => row.value.decisionRef))]
      .flatMap(ref => {
        const context = decisions.get(ref);
        return context === undefined ? [] : [context];
      });
    const textScore = mode === "purpose" ? organizationPurposeRelevance(query.purpose, row.value, contexts) : 0;
    if (matchedConditions.length === 0 && matchedExceptions.length === 0 && !sourceMatch && textScore === 0) return [];

    const entry: OrganizationRecallEntry = { factId: row.factId, knowledge: row.value, matchedConditions,
      missingConditions: row.value.conditionKeys.filter(key => !wanted.has(key.toLowerCase())), matchedExceptions,
      ...effective };

    return entry.evidence.length > 64 ? [] : [{ entry, matches: matchedConditions.length + matchedExceptions.length,
      sourceMatch, textScore, sequence: row.sequence }];
  });
}

/** Historical packets have no navigation. Preserve their exact ranking, body
 * and identity during replay rather than applying a new policy retrospectively. */
export function retrieveLegacyOrganizationExperience(view: OrganizationProjection, query: OrganizationRecallQuery): OrganizationRecallPacket {
  if (!isOrganizationRecallQuery(query)) throw new Error("organization_recall_query_invalid");

  const candidates = candidatesFor(view, query, "legacy")
    .sort((a, b) => b.matches - a.matches || a.entry.factId.localeCompare(b.entry.factId));
  const interpretation = "organization_hypotheses_not_business_evidence" as const;
  const entries: OrganizationRecallEntry[] = [];
  const material = () => canonicalJson({ role: interpretation, entries });

  for (const { entry } of candidates) {
    if (entries.length >= query.maximumEntries) break;
    entries.push(entry);
    if (material().length > query.maximumCharacters) entries.pop();
  }

  return { schemaVersion: 1, scope: view.scope, recallRef: `organization-recall:${contentHashOf({ scope: view.scope, query, entries })}`,
    query, entries, materialJson: material(), interpretation };
}

function recallPage(view: OrganizationProjection, query: OrganizationRecallQuery, entries: readonly OrganizationRecallEntry[],
  count: number, scannedThrough: number, omittedForCapacity: number) {
  const remainingEntries = Math.max(0, count - scannedThrough);
  let navigation = { remainingEntries, nextQuery: remainingEntries > 0 && scannedThrough > (query.offset ?? 0) && scannedThrough <= 4096
    ? { ...query, offset: scannedThrough } : null };
  const interpretation = "organization_hypotheses_not_business_evidence" as const;
  const material = () => canonicalJson({ role: interpretation, entries, navigation, omittedForCapacity,
    costInterpretation: "Count the same original cost unitRef once across decisions. Allocated share remains unknown unless identified by the original source.",
    retrievalGuidance: omittedForCapacity > 0 || navigation.remainingEntries > 0 && navigation.nextQuery === null
      ? "Refine purpose/conditions, or increase maximumCharacters to read complete remaining entries; no partial evidence was delivered." : null });

  // The repeated continuation query also consumes the model's material budget.
  // A null continuation is explicit; an empty page never points back to itself.
  if (material().length > query.maximumCharacters) navigation = { remainingEntries, nextQuery: null };

  return { schemaVersion: 1 as const, scope: view.scope,
    recallRef: `organization-recall:${contentHashOf({ scope: view.scope, query, entries, navigation })}`,
    query, entries, materialJson: material(), interpretation, navigation };
}

/** Exact sources, purpose text and original decision context provide navigation
 * only. Missing predicates, exceptions and current contrary evidence stay visible. */
export function retrieveOrganizationExperienceV1(view: OrganizationProjection, query: OrganizationRecallQuery): OrganizationRecallPacket {
  if (!isOrganizationRecallQuery(query)) throw new Error("organization_recall_query_invalid");

  const candidates = candidatesFor(view, query, "purpose").sort((a, b) => Number(b.sourceMatch) - Number(a.sourceMatch)
    || b.textScore - a.textScore || b.matches - a.matches || b.sequence - a.sequence || a.entry.factId.localeCompare(b.entry.factId));
  const entries: OrganizationRecallEntry[] = [];
  let scannedThrough = query.offset ?? 0, omittedForCapacity = 0;

  for (let index = scannedThrough; index < candidates.length; index++) {
    if (entries.length >= query.maximumEntries) break;

    const { entry } = candidates[index]!;

    scannedThrough = index + 1;
    entries.push(entry);

    if (recallPage(view, query, entries, candidates.length, scannedThrough, omittedForCapacity).materialJson.length > query.maximumCharacters) {
      entries.pop();
      omittedForCapacity++;
    }
  }

  let packet = recallPage(view, query, entries, candidates.length, scannedThrough, omittedForCapacity);

  // A later capacity omission may add a navigation explanation to an earlier
  // near-full page. Recheck the complete final body rather than clipping evidence.
  while (packet.materialJson.length > query.maximumCharacters && entries.length > 0) {
    entries.pop();
    omittedForCapacity++;
    packet = recallPage(view, query, entries, candidates.length, scannedThrough, omittedForCapacity);
  }

  return packet;
}
