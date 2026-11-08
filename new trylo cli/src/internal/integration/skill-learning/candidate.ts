import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { induceSkill } from "../../learning/domains/skill/inducer.js";
import { parseSkillExperience } from "./experience-file.js";
import { projectionScope } from "../content/scope.js";
import { shortId } from "../../learning/domains/shared/hash.js";
import { submitDraftCommand } from "../../learning/domains/shared/board-command.js";
import { ruleIdentity } from "../../learning/domains/shared/dual-save.js";
import { skillEvidenceWindow } from "./evidence-window.js";
import { skillTrialJobId } from "./trial-job.js";
import type { LearnedSkillContent } from "./contracts.js";
import { decodeLearnedSkillContent } from "./catalog.js";
import type { SkillCandidate, SkillExperience, SkillLearningGrant, SkillOpportunity } from "./runtime-contract.js";

export type CandidateSelection =
  | { readonly kind: "candidate"; readonly candidate: SkillCandidate; readonly experiences: readonly SkillExperience[]; readonly inputBytes: number }
  | { readonly kind: "waiting" | "unchanged" | "failed"; readonly reason: string; readonly experiences?: readonly SkillExperience[]; readonly inputBytes?: number };

/** Select whole comparable families: a budget must never drop a late correction. */
export function selectSkillCandidate(opportunity: SkillOpportunity, state: BoardState, grant: SkillLearningGrant, excludedFamilies: ReadonlySet<string> = new Set()): CandidateSelection {
  const groups = new Map<string, SkillExperience[]>();
  const identities = new Map<string, string>();

  if (!validSkillHistory(state)) return { kind: "failed", reason: "invalid_skill_history" };

  for (const fact of opportunity.experiences) {
    if (fact.workspaceId !== opportunity.workspaceId) continue;

    const parsed = parseSkillExperience(fact, opportunity.workspaceId);
    if (!parsed.ok) return { kind: "failed", reason: parsed.code };

    const identity = canonicalJson(fact);
    const previous = identities.get(fact.episode.id);
    if (previous !== undefined && previous !== identity) return { kind: "failed", reason: "conflicting_episode_identity" };

    if (previous !== undefined) continue;

    identities.set(fact.episode.id, identity);
    const key = canonicalJson([fact.episode.taskFamily.id, fact.episode.taskFamily.intentClass]);
    if (excludedFamilies.has(key)) continue;

    const group = groups.get(key) ?? [];

    group.push(fact);
    groups.set(key, group);
  }

  let reason = "needs_more_evidence";
  let changed = false;
  let waiting: CandidateSelection | undefined;

  for (const [key, facts] of [...groups].sort(([a, left], [b, right]) =>
    Number(hasPendingWithdrawal(right, state)) - Number(hasPendingWithdrawal(left, state)) || a.localeCompare(b))) {
    const full = [...facts].sort((a, b) => a.episode.id.localeCompare(b.episode.id));
    const latest = latestSkill(state, opportunity.workspaceId, key);
    const digest = contentHashOf(full);
    const window = skillEvidenceWindow(full, grant.allowance, latest?.content.draft);
    if (!window.ok) {
      reason = window.reason;
      changed = true;
      continue;
    }

    const sorted = window.experiences, inputBytes = window.inputBytes;

    if (latest?.content.experienceDigest === digest) {
      const proposal = state.proposals.find(item => item.proposalId === latest.content.draft.id);
      if (proposal !== undefined && ["draft", "quarantined", "evaluating"].includes(proposal.lifecycle)) {
        return { kind: "candidate", candidate: { content: latest.content, draft: latest.content.draft, versionId: latest.versionId,
          ...(latest.parentVersionId === undefined ? {} : { baselineVersionId: latest.parentVersionId }) }, experiences: sorted, inputBytes };
      }

      if (proposal?.lifecycle !== "rejected") continue;

      const attempts = state.assets.filter(asset => {
        const content = decodeLearnedSkillContent(asset.content);
        return content?.workspaceId === opportunity.workspaceId && content.experienceDigest === digest;
      });
      const sameOpportunity = latest.content.sourceOpportunityId === opportunity.opportunityId
        && (opportunity.trialRevision === undefined || state.jobs.some(job => job.jobId === skillTrialJobId(latest.versionId, opportunity)));
      if (sameOpportunity || attempts.length >= 3) {
        waiting ??= { kind: "waiting", reason: "rejected_waiting_new_evidence" };
        continue;
      }
    }

    changed = true;
    // One run is one successful demonstration. Late feedback may refer to that
    // same run, but duplicate success summaries cannot manufacture support.
    const successes = sorted.filter(fact => fact.episode.outcome === "success");
    if (new Set(successes.map(fact => fact.runId)).size !== successes.length) return { kind: "failed", reason: "duplicate_run_evidence" };

    const induced = induceSkill(sorted.map(fact => fact.episode), latest === undefined ? [] : [latest.content.draft.version]);
    if (induced.kind !== "draft") {
      reason = induced.code;
      if (hasPendingWithdrawal(sorted, state)) return { kind: "waiting", reason, experiences: sorted, inputBytes };
      waiting ??= { kind: "waiting", reason, experiences: sorted, inputBytes };
      continue;
    }

    const rejectedVariants = new Set(state.assets.flatMap(asset => {
      const content = decodeLearnedSkillContent(asset.content);
      const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
      return content?.workspaceId === opportunity.workspaceId && content.experienceDigest === digest && proposal?.lifecycle === "rejected"
        ? [content.draft.variants[0]?.id ?? ""] : [];
    }));
    const preferred = induced.draft.variants.find(variant => !rejectedVariants.has(variant.id)) ?? induced.draft.variants[0]!;
    const alternatives = { ...induced.draft, taskFamily: preferred.taskFamily, steps: preferred.steps, checks: preferred.checks,
      positiveRules: preferred.steps.map(step => `do: ${step}`), identity: ruleIdentity(preferred.steps),
      variants: [preferred, ...induced.draft.variants.filter(variant => variant.id !== preferred.id)] };
    const scopedId = `${shortId("workspace", [opportunity.workspaceId])}/${induced.draft.scope.id}`;
    const id = shortId("skill", [scopedId, induced.draft.id, digest, preferred.id]);
    const draft = { ...alternatives, id, scope: { ...induced.draft.scope, id: scopedId }, command: submitDraftCommand("skill", id) };
    const content: LearnedSkillContent = { kind: "learned_skill", schemaVersion: 1, workspaceId: opportunity.workspaceId,
      sourceOpportunityId: opportunity.opportunityId, experienceDigest: digest, draft,
      sourceWindow: { inputDigest: digest, selectedEpisodeIds: sorted.map(fact => fact.episode.id),
        omittedCount: full.length - sorted.length, sourceRefs: sorted.map(fact => fact.sourceRef) } };

    return { kind: "candidate", candidate: { content, draft, versionId: `skill-version:${id}`,
      ...(latest === undefined ? {} : { baselineVersionId: latest.versionId }) }, experiences: sorted, inputBytes };
  }

  return waiting ?? { kind: changed ? "waiting" : "unchanged", reason: changed ? reason : "no_new_qualified_experience" };
}

/** Safety feedback takes precedence over unrelated new candidates inside this domain. */
function hasPendingWithdrawal(facts: readonly SkillExperience[], state: BoardState): boolean {
  return facts.some(fact => fact.episode.outcome === "failure" && fact.episode.correction?.scope !== "task"
    && state.activations.some(activation => {
      if (activation.pointer !== "shadow" && activation.pointer !== "active") return false;

      const asset = state.assets.find(item => item.versionId === activation.versionId);
      const proposal = state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);
      if (proposal?.lifecycle !== activation.pointer) return false;

      if (fact.usedSkill?.versionId === activation.versionId) return true;

      const content = decodeLearnedSkillContent(asset?.content);

      return content !== undefined && fact.episode.correction !== undefined
        && content.draft.positiveExamples.some(example => fact.episode.correction?.targetEpisodeIds.includes(example.episodeId));
    }));
}

function validSkillHistory(state: BoardState): boolean {
  return state.assets.every(asset => {
    if (asset.kind !== "skill" || typeof asset.content !== "object" || asset.content === null || !("kind" in asset.content)
      || asset.content.kind !== "learned_skill") return true;

    const content = decodeLearnedSkillContent(asset.content);
    const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);

    return content !== undefined && contentHashOf(asset.content) === asset.contentHash && asset.schemaVersion === 1
      && proposal?.proposalId === content.draft.id && proposal.assetKind === "skill"
      && proposal.scope === asset.scope && asset.scope === projectionScope(content.draft.scope);
  });
}

function latestSkill(state: BoardState, workspaceId: string, key: string): { content: LearnedSkillContent; versionId: string; parentVersionId?: string } | undefined {
  let latest: { content: LearnedSkillContent; versionId: string; parentVersionId?: string } | undefined;

  for (const asset of state.assets) {
    if (asset.kind !== "skill") continue;
    const content = decodeLearnedSkillContent(asset.content);
    if (content === undefined || content.workspaceId !== workspaceId
      || canonicalJson([content.draft.taskFamily.id, content.draft.taskFamily.intentClass]) !== key) continue;
    if (latest === undefined || content.draft.version > latest.content.draft.version) latest = { content, versionId: asset.versionId,
      ...(asset.parentVersionId === undefined ? {} : { parentVersionId: asset.parentVersionId }) };
  }

  return latest;
}
