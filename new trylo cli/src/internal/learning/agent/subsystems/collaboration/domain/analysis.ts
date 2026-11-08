import type { CollaborationEpisode, CollaborationPractice } from "./contracts.js";

export type CollaborationDiagnosis = "coordination" | "member_capability" | "unverified" | "not_applicable";

/** Sufficient skill plus an observed missing transfer is a hypothesis about cooperation, not a skill rating. */
export function diagnoseEpisode(episode: CollaborationEpisode): CollaborationDiagnosis {
  const result = episode.result;
  if (result.source === "member_report" || result.check === "unverified" || result.evidenceRefs.length === 0) return "unverified";
  if (result.capability === "insufficient") return "member_capability";
  if (result.capability !== "sufficient") return "unverified";
  if (episode.context.dependency !== "artifact" || result.reworkCount === 0 || result.missingFields.length === 0) return "not_applicable";
  return "coordination";
}

export function practiceFrom(episode: CollaborationEpisode): CollaborationPractice {
  return {
    schema: "collaboration-practice/v1", object: "handoff", problem: "handoff_missing_context", dependency: "artifact",
    requiredFields: [...episode.result.missingFields], sourceEpisodeIds: [episode.factId], sourceOutcomeIds: [],
  };
}
