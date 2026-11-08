import { submitDraftCommand, submitWithdrawCommand, type BoardCommandDraft } from "../shared/board-command.js";
import { ruleIdentity } from "../shared/dual-save.js";
import { scanForbiddenBody } from "../shared/forbidden-scan.js";
import { shortId } from "../shared/hash.js";
import { domainFailure, DRAFT_STATUS, type DomainFailure } from "../shared/types.js";
import { sameSkillTaskFamily } from "./conditions.js";
import { buildSkillVariants, sortedUnique } from "./variants.js";
import type { SkillDraft, SkillEpisode, SkillInduceResult, SkillVariant } from "./types.js";

export type { SkillDraft, SkillEpisode, SkillExampleRef, SkillInduceResult, SkillVariant, SkillCorrection } from "./types.js";

export const DEFAULT_SKILL_MIN_EPISODES = 3;

export function induceSkill(episodes: readonly SkillEpisode[], existingVersions: readonly number[] = []): SkillInduceResult {
  const failure = validateEpisodes(episodes);
  if (failure !== undefined) {
    return failure;
  }

  const ordered = [...episodes].sort((a, b) => a.id.localeCompare(b.id));
  const variants = buildSkillVariants(ordered);
  const preferred = variants[0];
  if (preferred === undefined) {
    return domainFailure("needs_more_evidence", "no successful path remains after scoped corrections");
  }

  const family = preferred.taskFamily;
  const positive = ordered.filter((episode) => episode.outcome === "success");
  const negative = ordered.filter((episode) => episode.outcome === "failure");
  const failureModes = sortedUnique(negative.filter((episode) => episode.correction?.scope !== "task").flatMap((episode) =>
    [episode.failureMode ?? "", episode.correction?.reason ?? ""].filter((mode) => mode.length > 0)));
  const version = Math.max(0, ...existingVersions) + 1;
  // Preserve rule identity for the existing skill/workflow dual-save contract.
  // The immutable draft id additionally covers conditions, all alternatives and evidence.
  const identity = ruleIdentity(preferred.steps);
  const id = shortId("sk", [family.id, String(version), JSON.stringify(variants), JSON.stringify(failureModes)]);

  return { kind: "draft", draft: {
    kind: "skill", status: DRAFT_STATUS, id,
    name: `${family.intentClass}-method`, version,
    trigger: `exact task conditions ${JSON.stringify(family)}`,
    taskFamily: family, variants,
    steps: preferred.steps, checks: preferred.checks, failureModes,
    positiveExamples: positive.map((episode) => ({ episodeId: episode.id, outcome: "success" })),
    negativeExamples: negative.map((episode) => ({ episodeId: episode.id, outcome: "failure" })),
    positiveRules: preferred.steps.map((step) => `do: ${step}`),
    negativeRules: failureModes.map((mode) => `avoid: ${mode}`),
    provenance: { source: "inferred_from_observations", observationRefs: ordered.map((episode) => episode.id), createdBy: "skill_inducer" },
    scope: { kind: "task_family", id: family.id }, identity, permissionClaim: false,
    command: submitDraftCommand("skill", id),
  } };
}

function validateEpisodes(episodes: readonly SkillEpisode[]): DomainFailure | undefined {
  const smuggled = scanForbiddenBody(episodes.flatMap((episode) =>
    [...episode.steps, ...episode.checks, episode.failureMode ?? "", episode.correction?.reason ?? ""]));
  if (smuggled.length > 0) {
    return domainFailure("forbidden_payload", "skill cannot carry permission, download, or tool switch", smuggled);
  }

  if (episodes.length < DEFAULT_SKILL_MIN_EPISODES) {
    return domainFailure("needs_more_evidence", "skill induction needs at least three similar multi-step episodes");
  }

  if (new Set(episodes.map((episode) => episode.id)).size !== episodes.length) {
    return domainFailure("insufficient_attribution", "each skill episode must have a distinct execution identity");
  }

  const family = episodes[0]?.taskFamily;

  for (const episode of episodes) {
    if (episode.taskFamily.id !== family?.id || episode.taskFamily.intentClass !== family.intentClass) {
      return domainFailure("insufficient_attribution", "skill episodes span incomparable task families", ["taskFamily"]);
    }

    if (episode.steps.length < 2 || !episode.trajectory.hadChecks || episode.checks.length === 0) {
      return domainFailure("needs_more_evidence", "episodes lack reusable steps and checks");
    }

    if (episode.correction !== undefined && (episode.outcome !== "failure" ||
      episode.correction.targetEpisodeIds.length === 0 ||
      episode.correction.targetEpisodeIds.some((id) => !episodes.some((target) => target.id === id && target.outcome === "success" &&
        (episode.correction?.scope !== "condition" || sameSkillTaskFamily(target.taskFamily, episode.taskFamily)))))) {
      return domainFailure("insufficient_attribution", "correction must identify prior successful evidence and cannot claim success");
    }

    if (episode.validatedAfterCorrectionIds?.some((id) => episode.outcome !== "success" ||
      !episodes.some((target) => target.id === id && target.correction !== undefined))) {
      return domainFailure("insufficient_attribution", "revalidation must identify a correction and an independently successful episode");
    }
  }

  if (!episodes.some((episode) => episode.outcome === "success") ||
    !episodes.some((episode) => episode.outcome === "failure" && (episode.failureMode !== undefined || episode.correction !== undefined))) {
    return domainFailure("needs_more_evidence", "skill drafts must keep both success and explained failure experience");
  }

  return undefined;
}

export function renderSkillMarkdown(draft: SkillDraft): string {
  return renderVariants(draft, draft.variants);
}

/** Selection has already checked the exact task conditions; no other branch is exposed. */
export function renderSkillVariantMarkdown(draft: SkillDraft, variant: SkillVariant): string {
  return renderVariants(draft, [variant]);
}

function renderVariants(draft: SkillDraft, variants: readonly SkillVariant[]): string {
  const failureModes = sortedUnique(variants.flatMap((variant) => variant.failureLessons.map((lesson) => lesson.failureMode)));
  return [
    `# ${draft.name} v${draft.version}`, `Conditions: ${variants.map((variant) => JSON.stringify(variant.taskFamily)).join(" OR ")}`,
    "Status: draft; independent validation is required before activation.",
    "Selection: independently repeated successful sequences first; ties use stable content identity. Alternatives retain exact conditions.",
    "Evidence supports the complete observed sequence. Failure lessons are counterevidence under these conditions, not proof of a step's causal effect.",
    ...variants.flatMap((variant) => [
      `## Variant ${variant.id}`, `Conditions: ${JSON.stringify(variant.taskFamily)}`,
      `Successful evidence: ${variant.supportEpisodeIds.join(", ")}`,
      "### Steps", ...variant.stepEvidence.map((evidence, index) => `${index + 1}. ${evidence.step} [${evidence.episodeIds.join(", ")}]`),
      "### Checks", ...variant.checkEvidence.map((evidence) => `- ${evidence.check} [${evidence.episodeIds.join(", ")}]`),
      "### Failure lessons", ...variant.failureLessons.map((lesson) => `- ${lesson.failureMode} [${lesson.episodeIds.join(", ")}]`),
      `Revalidated corrections: ${variant.correctionRefs.join(", ") || "none"}`,
    ]),
    "## Failure modes", ...failureModes.map((mode) => `- ${mode}`),
    "## Positive rules", ...variants.flatMap((variant) => variant.steps.map((step) => `- do: ${step}`)),
    "## Negative rules", ...failureModes.map((mode) => `- avoid: ${mode}`),
  ].join("\n");
}

export function withdrawSkill(id: string): BoardCommandDraft {
  return submitWithdrawCommand("skill", id);
}

/** Manual edits remain unvalidated drafts. Unsupported edited steps have no inferred evidence. */
export function editSkill(draft: SkillDraft, patch: { readonly steps?: readonly string[]; readonly checks?: readonly string[] }): SkillDraft {
  const version = draft.version + 1;
  const steps = patch.steps ?? draft.steps;
  const checks = patch.checks ?? draft.checks;
  const identity = ruleIdentity(steps);
  const preferred = draft.variants[0];
  const variants = preferred === undefined ? [] : [{
    ...preferred, id: shortId("skv", [JSON.stringify(preferred.taskFamily), JSON.stringify(steps)]), steps, checks,
    supportEpisodeIds: [], correctionRefs: [],
    stepEvidence: steps.map((step) => ({ step, episodeIds: [] })),
    checkEvidence: checks.map((check) => ({ check, episodeIds: [] })),
  }, ...draft.variants.slice(1)];
  const id = shortId("sk", [draft.scope.id, String(version), JSON.stringify(variants)]);

  return { ...draft, id, version, identity, steps, checks, variants,
    positiveRules: steps.map((step) => `do: ${step}`), command: submitDraftCommand("skill", id) };
}
