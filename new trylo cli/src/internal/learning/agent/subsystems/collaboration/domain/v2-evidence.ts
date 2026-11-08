import type { CollaborationV2Fact } from "./v2-contracts.js";

/** Traverse only recorded identities. Artifact paths and unrecognized prose are not new facts. */
export function collaborationEvidenceClosureV2(facts: readonly CollaborationV2Fact[], roots: readonly string[]): readonly CollaborationV2Fact[] {
  const byId = new Map(facts.map(f => [f.factId, f])), ids = new Set(roots), queue = [...ids];

  for (let index = 0; index < queue.length; index += 1) {
    const fact = byId.get(queue[index]!);
    if (fact === undefined) continue;
    const references = fact.kind === "event" ? [...fact.causedBy, ...fact.evidenceRefs.filter(ref => byId.has(ref))]
      : fact.kind === "episode" ? [...fact.eventIds, ...fact.evidenceRefs.filter(ref => byId.has(ref))]
        : fact.kind === "adoption" ? [...fact.eventIds, fact.exposureId]
          : fact.kind === "outcome" ? [...fact.adoptionIds, ...fact.episodeIds] : [];
    for (const ref of references) if (!ids.has(ref)) {
      ids.add(ref);
      queue.push(ref);
    }
  }

  return facts.filter(f => ids.has(f.factId));
}
