import { canonicalJson, contentHashOf } from "../../control/hash.js";
import type { OrganizationKnowledgeBodyRequired, OrganizationProjection, OrganizationRecallEntry, OrganizationRecallPacket,
  OrganizationRecallQuery } from "./contracts.js";
import { isOrganizationRecallQuery } from "./validation.js";
import { organizationPurposeRelevance } from "./retrieval-relevance.js";
import { organizationEvidenceCoverage, organizationEvidenceIndex, type OrganizationEvidenceIndex } from "./retrieval-evidence.js";
import { organizationKnowledgeHeadReadRef } from "./addresses.js";

export { organizationFeedbackKey, retrieveLegacyOrganizationExperience, retrieveOrganizationExperienceV1 } from "./retrieval-v1.js";

const POLICY = "bounded_current_source_heads_v2" as const;
const INTERPRETATION = "organization_hypotheses_not_business_evidence" as const;
const normalized = (keys: readonly string[]) => new Set(keys.map(key => key.toLowerCase()));

function candidatesFor(view: OrganizationProjection, query: OrganizationRecallQuery) {
  const wanted = normalized(query.conditionKeys), sources = new Set(query.sourceRefs);
  const decisions = new Map(view.decisions.map(row => [row.value.decisionRef, row.value.context]));

  return view.knowledge.filter(row => row.value.state !== "withdrawn").flatMap(row => {
    const matchedConditions = row.value.conditionKeys.filter(key => wanted.has(key.toLowerCase()));
    const matchedExceptions = row.value.exceptionKeys.filter(key => wanted.has(key.toLowerCase()));
    const index = organizationEvidenceIndex(view, row);
    const sourceMatch = index.items.some(item => item.value.sourceRefs.some(ref => sources.has(ref)));
    const contexts = [...new Set(index.items.map(item => item.value.decisionRef))]
      .flatMap(ref => {
        const context = decisions.get(ref);
        return context === undefined ? [] : [context];
      });
    const textScore = organizationPurposeRelevance(query.purpose, row.value, contexts);
    if (matchedConditions.length === 0 && matchedExceptions.length === 0 && !sourceMatch && textScore === 0) return [];

    const entry: OrganizationRecallEntry = { factId: row.factId, knowledge: row.value, matchedConditions,
      missingConditions: row.value.conditionKeys.filter(key => !wanted.has(key.toLowerCase())), matchedExceptions,
      evidence: [], evidenceRevisions: [], evidenceCoverage: organizationEvidenceCoverage(index, row.factId, []) };

    // Observation history is pageable; its size never rejects the knowledge.
    return [{ entry, index, matches: matchedConditions.length + matchedExceptions.length, sourceMatch, textScore, sequence: row.sequence }];
  }).sort((a, b) => Number(b.sourceMatch) - Number(a.sourceMatch) || b.textScore - a.textScore
    || b.matches - a.matches || b.sequence - a.sequence || a.entry.factId.localeCompare(b.entry.factId));
}

/** V1 identities remain frozen separately. V2 commits exactly the complete heads,
 * actual feedback bodies and unread disclosures delivered by this bounded page. */
export function retrieveOrganizationExperience(view: OrganizationProjection, query: OrganizationRecallQuery): OrganizationRecallPacket {
  if (!isOrganizationRecallQuery(query)) throw new Error("organization_recall_query_invalid");

  const candidates = candidatesFor(view, query), entries: OrganizationRecallEntry[] = [];
  const required: OrganizationKnowledgeBodyRequired[] = [], indexes = new Map<string, OrganizationEvidenceIndex>();
  let scannedThrough = query.offset ?? 0, omittedForCapacity = 0;
  const render = () => {
    const remainingEntries = Math.max(0, candidates.length - scannedThrough);
    const navigation = { remainingEntries, nextQuery: remainingEntries > 0 && scannedThrough > (query.offset ?? 0) && scannedThrough <= 4096
      ? { ...query, offset: scannedThrough } : null };
    const material = () => canonicalJson({ schemaVersion: 2, role: INTERPRETATION, entries, navigation, omittedForCapacity,
      knowledgeBodyRequired: required, evidencePolicy: POLICY,
      costInterpretation: "Count the same original cost unitRef once across decisions; allocation unknown.",
      retrievalGuidance: "Refine purpose or read exact references. Related is not counterevidence or independent trials; unread unknown; adoption is exposure." });

    return { navigation, materialJson: material() };
  };

  for (let position = scannedThrough; position < candidates.length; position++) {
    if (entries.length >= query.maximumEntries || required.length >= 8) break;

    const candidate = candidates[position]!;
    scannedThrough = position + 1;
    entries.push(candidate.entry);

    if (render().materialJson.length <= query.maximumCharacters) {
      indexes.set(candidate.entry.factId, candidate.index);
      continue;
    }

    entries.pop();
    const previousOmitted = omittedForCapacity;
    omittedForCapacity++;
    required.push({ factId: candidate.entry.factId, knowledgeId: candidate.entry.knowledge.knowledgeId,
      readRef: organizationKnowledgeHeadReadRef(candidate.entry.factId), originalCharacters: canonicalJson(candidate.entry.knowledge).length,
      reason: "knowledge_body_required_not_delivered" });

    if (render().materialJson.length > query.maximumCharacters) {
      required.pop();
      scannedThrough = position;
      omittedForCapacity = previousOmitted;
      break;
    }
  }

  // Complete knowledge gets its budget before any potentially unbounded exposure
  // history. No partial feedback body is ever assigned a delivered fact identity.
  for (let position = 0; position < entries.length; position++) {
    let current = entries[position]!;
    const index = indexes.get(current.factId)!;

    for (const item of index.inlineOrder) {
      if (current.evidence.length >= 64) break;

      const revisions = [...current.evidenceRevisions, ...index.revisions.filter(row => row.effectiveFactId === item.factId
        && !current.evidenceRevisions.some(prior => prior.citedFactId === row.citedFactId))];
      if (revisions.length > 64) continue;

      const evidence = [...current.evidence, { factId: item.factId, sequence: item.sequence, value: item.value }];
      const candidate: OrganizationRecallEntry = { ...current, evidence, evidenceRevisions: revisions,
        evidenceCoverage: organizationEvidenceCoverage(index, current.factId, evidence) };

      entries[position] = candidate;

      if (render().materialJson.length <= query.maximumCharacters) current = candidate;
      else entries[position] = current;
    }
  }

  const { navigation, materialJson } = render();

  if (materialJson.length > query.maximumCharacters) throw new Error("organization_recall_capacity");

  return { schemaVersion: 2, scope: view.scope,
    recallRef: `organization-recall:${contentHashOf({ scope: view.scope, query, materialJson })}`, query, entries,
    materialJson, interpretation: INTERPRETATION, navigation, evidencePolicy: POLICY, knowledgeBodyRequired: required };
}
