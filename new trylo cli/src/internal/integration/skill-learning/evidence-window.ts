import { canonicalJson } from "../../learning/control/hash.js";
import { skillTaskFamilyKey } from "../../learning/domains/skill/index.js";
import type { SkillDraft } from "../../learning/domains/skill/index.js";
import type { SkillExperience, SkillLearningGrant } from "./runtime-contract.js";

type Window = { readonly ok: true; readonly experiences: readonly SkillExperience[]; readonly inputBytes: number }
  | { readonly ok: false; readonly reason: string };

/** Sampling never discards an unresolved correction or its original demonstration.
 * Previous full provenance remains immutable in the parent Board version and raw archives.
 */
export function skillEvidenceWindow(facts: readonly SkillExperience[], allowance: SkillLearningGrant["allowance"], previous?: SkillDraft): Window {
  const all = [...facts].sort((a, b) => a.episode.id.localeCompare(b.episode.id));
  const bytes = (selected: readonly SkillExperience[]) => Buffer.byteLength(canonicalJson(selected), "utf8");
  if (all.length <= allowance.maxEpisodes && bytes(all) <= allowance.maxInputBytes) return { ok: true, experiences: all, inputBytes: bytes(all) };

  const byId = new Map(all.map(fact => [fact.episode.id, fact]));
  const selected = new Map<string, SkillExperience>();
  const retain = (id: string): boolean => {
    if (selected.has(id)) return true;
    const fact = byId.get(id);
    if (fact === undefined) return false;
    selected.set(id, fact);
    return [...(fact.episode.correction?.targetEpisodeIds ?? []), ...(fact.episode.validatedAfterCorrectionIds ?? [])].every(retain);
  };

  for (const fact of all) {
    const safetyFeedback = fact.episode.outcome === "failure" && fact.episode.correction?.scope !== "task"
      && (fact.episode.correction !== undefined || fact.usedSkill !== undefined);
    if (safetyFeedback && !retain(fact.episode.id)) return { ok: false, reason: "source_evidence_unavailable" };
  }

  for (const variant of previous?.variants ?? []) {
    // Two independent representatives preserve a path, while its earlier complete
    // support set remains addressable through the immutable parent version.
    for (const id of variant.supportEpisodeIds.slice(0, 2)) if (!retain(id)) return { ok: false, reason: "source_evidence_unavailable" };
  }

  const ordinaryFailure = all.find(fact => fact.episode.outcome === "failure" && fact.episode.correction === undefined);
  if (ordinaryFailure !== undefined) retain(ordinaryFailure.episode.id);

  const fits = () => selected.size <= allowance.maxEpisodes && bytes([...selected.values()]) <= allowance.maxInputBytes;
  if (!fits()) return { ok: false, reason: "family_exceeds_allowance" };

  const groups = new Map<string, SkillExperience[]>();

  for (const fact of all) {
    if (fact.episode.outcome !== "success") continue;
    const key = canonicalJson([skillTaskFamilyKey(fact.episode.taskFamily), fact.episode.steps]);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const tryRetain = (fact: SkillExperience) => {
    const before = new Map(selected);
    if (!retain(fact.episode.id) || !fits()) {
      selected.clear();
      for (const [id, original] of before) selected.set(id, original);
    }
  };

  for (const group of [...groups.values()].sort((a, b) => b.length - a.length || a[0]!.episode.id.localeCompare(b[0]!.episode.id))) {
    for (const fact of group.slice(0, 2)) tryRetain(fact);
  }

  for (const fact of all) tryRetain(fact);

  const experiences = [...selected.values()].sort((a, b) => a.episode.id.localeCompare(b.episode.id));

  return { ok: true, experiences, inputBytes: bytes(experiences) };
}
