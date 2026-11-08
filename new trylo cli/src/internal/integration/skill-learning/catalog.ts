import { createSkillCatalog } from "../../adapters/skills/catalog.js";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { parseSkillDraft, renderSkillVariantMarkdown, sameSkillTaskFamily, type SkillVariant } from "../../learning/domains/skill/index.js";
import type { SkillCatalogPort, SkillDescriptor } from "../../ports/skills.js";
import type { LearnedSkillContent, LearnedSkillContext, LearnedSkillLoad } from "./contracts.js";
import { projectionScope } from "../content/scope.js";

export type LearnedSkillCatalogInput = {
  readonly state: BoardState;
  readonly context: LearnedSkillContext;
  /** Existing context directory; content stays in Board, without a fabricated SKILL.md. */
  readonly contentRoot: string;
  readonly onLoaded?: (load: LearnedSkillLoad) => void;
};

export type LearnedSkillCatalogResult = {
  readonly catalog: SkillCatalogPort | undefined;
  readonly problems: readonly string[];
};

/** Old generic skill blobs lack conditions and are intentionally not executable via this bridge. */
export function decodeLearnedSkillContent(value: unknown): LearnedSkillContent | undefined {
  if (!isRecord(value) || value.kind !== "learned_skill" || value.schemaVersion !== 1 ||
      !nonEmpty(value.workspaceId) || !nonEmpty(value.experienceDigest) || !nonEmpty(value.sourceOpportunityId)) return undefined;

  const draft = parseSkillDraft(value.draft);
  if (!draft.ok) return undefined;

  const sourceWindow = value.sourceWindow;
  if (sourceWindow !== undefined && (!isRecord(sourceWindow) || !nonEmpty(sourceWindow.inputDigest)
    || !stringList(sourceWindow.selectedEpisodeIds) || !stringList(sourceWindow.sourceRefs)
    || typeof sourceWindow.omittedCount !== "number" || !Number.isSafeInteger(sourceWindow.omittedCount) || sourceWindow.omittedCount < 0
    || sourceWindow.inputDigest !== value.experienceDigest || sourceWindow.sourceRefs.length !== sourceWindow.selectedEpisodeIds.length
    || sourceWindow.selectedEpisodeIds.length !== draft.value.provenance.observationRefs.length
    || new Set(sourceWindow.selectedEpisodeIds).size !== sourceWindow.selectedEpisodeIds.length
    || sourceWindow.selectedEpisodeIds.some(id => !draft.value.provenance.observationRefs.includes(id)))) return undefined;

  return { kind: "learned_skill", schemaVersion: 1, workspaceId: value.workspaceId,
    experienceDigest: value.experienceDigest, sourceOpportunityId: value.sourceOpportunityId, draft: draft.value,
    ...(isRecord(sourceWindow) && nonEmpty(sourceWindow.inputDigest) && stringList(sourceWindow.selectedEpisodeIds)
      && stringList(sourceWindow.sourceRefs) && typeof sourceWindow.omittedCount === "number" ? { sourceWindow: {
        inputDigest: sourceWindow.inputDigest, selectedEpisodeIds: sourceWindow.selectedEpisodeIds,
        omittedCount: sourceWindow.omittedCount, sourceRefs: sourceWindow.sourceRefs,
      } } : {}) };
}

function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(nonEmpty); }

/** Freeze a task's eligible versions. Listing is not usage; only a successful load emits an exposure. */
export function learnedSkillCatalog(input: LearnedSkillCatalogInput): LearnedSkillCatalogResult {
  const descriptors: SkillDescriptor[] = [];
  const loads = new Map<string, LearnedSkillLoad>();
  const problems: string[] = [];

  for (const activation of input.state.activations) {
    if (activation.assetKind !== "skill" || (activation.pointer !== "shadow" && activation.pointer !== "active") || activation.breaker?.open) continue;

    const asset = input.state.assets.find(item => item.versionId === activation.versionId);
    const proposal = input.state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);

    // Rejecting a shadow trial leaves its historical activation record intact.
    // A withdrawn proposal is unavailable, not evidence of storage corruption.
    if (proposal !== undefined && ["rejected", "suspended", "retired"].includes(proposal.lifecycle)) continue;

    if (asset === undefined || proposal === undefined || asset.kind !== "skill" || asset.schemaVersion !== 1 ||
        asset.scope !== activation.scope || proposal.scope !== asset.scope || proposal.assetKind !== "skill" ||
        proposal.lifecycle !== activation.pointer || contentHashOf(asset.content) !== asset.contentHash ||
        input.state.tombstones.some(item => item.entityId === asset.versionId || item.entityId === proposal.proposalId)) {
      problems.push(`learned skill ${activation.versionId}: inconsistent Board version`);
      continue;
    }

    const content = decodeLearnedSkillContent(asset.content);
    if (content === undefined || content.draft.id !== proposal.proposalId || projectionScope(content.draft.scope) !== asset.scope) {
      problems.push(`learned skill ${activation.versionId}: unsupported or invalid content`);
      continue;
    }

    if (content.workspaceId !== input.context.workspaceId) continue;

    const variant = content.draft.variants.find(item => sameSkillTaskFamily(input.context.taskFamily, item.taskFamily));
    if (variant === undefined) continue;

    const name = `learned-${sha256Hex(asset.scope).slice(0, 16)}`;
    const load: LearnedSkillLoad = { versionId: asset.versionId, proposalId: proposal.proposalId,
      variantId: variant.id, contentHash: asset.contentHash };

    descriptors.push({ name, description: `${content.draft.name} v${content.draft.version} (${activation.pointer})`,
      whenToUse: content.draft.trigger, source: "project", skillRoot: input.contentRoot, path: input.contentRoot,
      contentHash: asset.contentHash, body: renderSelected(content, variant, load),
      userInvocable: true, disableModelInvocation: false, forkExecution: false });
    loads.set(name, load);
  }

  if (descriptors.length === 0) return { catalog: undefined, problems };

  const catalog = createSkillCatalog(descriptors);

  return { problems, catalog: {
    list: catalog.list,

    load(name, args) {
      const result = catalog.load(name, args);
      const exposure = loads.get(name);
      if (result.kind === "loaded" && exposure !== undefined) input.onLoaded?.(exposure);
      return result;
    },
  } };
}

export function renderSelected(content: LearnedSkillContent, variant: SkillVariant, load: LearnedSkillLoad): string {
  // Global failure summaries can describe another condition. Keep only this
  // variant's evidence, just as we omit other variants' positive instructions.
  const failureModes = variant.failureLessons.map(lesson => lesson.failureMode);
  const projection = { ...content.draft, failureModes, negativeRules: failureModes.map(mode => `avoid: ${mode}`) };

  return [
    "Source: immutable Board content; this skill has no installed SKILL.md file.",
    `Version: ${load.versionId}; content hash: ${load.contentHash}; proposal: ${load.proposalId}; variant: ${load.variantId}`,
    "Use this method only while these conditions still hold. A failed check requires revisiting the approach; loading is not verification.",
    renderSkillVariantMarkdown(projection, variant),
    "This skill does not grant permissions or alter the task's acceptance criteria.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
