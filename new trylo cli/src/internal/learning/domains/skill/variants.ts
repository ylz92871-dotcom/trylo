import { shortId } from "../shared/hash.js";
import { sameSkillTaskFamily, skillTaskFamilyKey } from "./conditions.js";
import type { SkillEpisode, SkillVariant } from "./types.js";

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function sequenceKey(steps: readonly string[]): string {
  return JSON.stringify(steps);
}

export function buildSkillVariants(episodes: readonly SkillEpisode[]): SkillVariant[] {
  const groups = new Map<string, SkillEpisode[]>();

  for (const episode of episodes) {
    if (episode.outcome !== "success" || episode.correction !== undefined) {
      continue;
    }

    const key = JSON.stringify([skillTaskFamilyKey(episode.taskFamily), episode.steps]);
    const group = groups.get(key) ?? [];

    group.push(episode);
    groups.set(key, group);
  }

  const variants: SkillVariant[] = [];

  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }

    const corrections = episodes.filter((episode) => correctsPath(episode, first, episodes));
    const support = group.filter((episode) => corrections.every((correction) =>
      episode.validatedAfterCorrectionIds?.includes(correction.id) === true));
    if (support.length === 0) {
      continue;
    }

    const checks = sortedUnique(support.flatMap((episode) => episode.checks));
    const failures = episodes.filter((episode) => episode.outcome === "failure" && episode.correction?.scope !== "task" &&
      sameSkillTaskFamily(episode.taskFamily, first.taskFamily));
    const failureModes = sortedUnique(failures.flatMap((episode) =>
      [episode.failureMode ?? "", episode.correction?.reason ?? ""].filter((mode) => mode.length > 0)));

    variants.push({
      id: shortId("skv", [skillTaskFamilyKey(first.taskFamily), sequenceKey(first.steps)]),
      taskFamily: first.taskFamily,
      steps: [...first.steps], checks,
      supportEpisodeIds: sortedUnique(support.map((episode) => episode.id)),
      stepEvidence: first.steps.map((step) => ({ step, episodeIds: sortedUnique(support.map((episode) => episode.id)) })),
      checkEvidence: checks.map((check) => ({ check, episodeIds: sortedUnique(support.filter((episode) => episode.checks.includes(check)).map((episode) => episode.id)) })),
      failureLessons: failureModes.map((failureMode) => ({ failureMode, episodeIds: sortedUnique(failures.filter((episode) => episode.failureMode === failureMode || episode.correction?.reason === failureMode).map((episode) => episode.id)) })),
      correctionRefs: sortedUnique(corrections.map((episode) => episode.id)),
    });
  }

  // Repeated independent success is the selection pressure. Ties preserve alternatives
  // and use content identity, never caller array order, for the compatibility projection.
  return variants.sort((a, b) => b.supportEpisodeIds.length - a.supportEpisodeIds.length || a.id.localeCompare(b.id));
}

function correctsPath(correctionEpisode: SkillEpisode, candidate: SkillEpisode, episodes: readonly SkillEpisode[]): boolean {
  const correction = correctionEpisode.correction;
  if (correction === undefined || correction.scope === "task") {
    return false;
  }

  const inScope = correction.scope === "condition"
    ? sameSkillTaskFamily(correctionEpisode.taskFamily, candidate.taskFamily)
    : correctionEpisode.taskFamily.id === candidate.taskFamily.id;

  return inScope && episodes.some((episode) => correction.targetEpisodeIds.includes(episode.id) &&
    episode.outcome === "success" && sequenceKey(episode.steps) === sequenceKey(candidate.steps));
}
