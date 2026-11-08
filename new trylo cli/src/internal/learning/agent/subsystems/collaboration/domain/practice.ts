import type { BoardState } from "../../../../control/state.js";
import type { CollaborationPractice, HandoffField } from "./contracts.js";
import { diagnoseEpisode } from "./analysis.js";

/** Content alone does not establish a learning history, even if its JSON schema is valid. */
export function practiceSourcesValid(state: BoardState, practice: CollaborationPractice, scope: string): boolean {
  const facts = state.collaborationFacts ?? [];
  const supported = new Set<HandoffField>();

  for (const id of practice.sourceEpisodeIds) {
    const episode = facts.find(fact => fact.kind === "episode" && fact.factId === id && fact.scope === scope);
    if (episode?.kind !== "episode" || diagnoseEpisode(episode) !== "coordination") return false;
    for (const field of episode.result.missingFields) supported.add(field);
  }

  for (const id of practice.sourceOutcomeIds) {
    const outcome = facts.find(fact => fact.kind === "outcome" && fact.factId === id && fact.scope === scope);
    if (outcome?.kind !== "outcome" || outcome.result.source === "member_report" || outcome.result.check === "unverified"
      || outcome.result.capability !== "sufficient" || outcome.result.reworkCount === 0) return false;
    for (const field of outcome.result.missingFields) supported.add(field);
  }

  return practice.requiredFields.every(field => supported.has(field))
    && [...supported].every(field => practice.requiredFields.includes(field));
}
