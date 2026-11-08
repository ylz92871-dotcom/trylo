import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { decodeLearnedSkillContent } from "../../integration/skill-learning/catalog.js";
import { createSkillExperienceFile } from "../../integration/skill-learning/experience-file.js";
import type { SkillExperience } from "../../integration/skill-learning/runtime-contract.js";
import { projectionScope } from "../../integration/content/scope.js";
import { renderSkillMarkdown } from "../../learning/domains/skill/index.js";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import type { SkillLearningCommandPort, SkillLearningCommandError, SkillLearningSummary } from "./skill-learning-command-contract.js";
import { readSkillJournalUses } from "./skill-journal-history.js";
import type { SkillJournalUse } from "./skill-journal-usage.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

/** Shared formula for daily capture, learning and explicit management. */
export function skillDailyManagementPaths(ctx: Pick<CliContext, "cwd" | "homeDir" | "env">) {
  const workspaceId = workspaceIdentity(ctx.cwd), learning = path.join(tryloHome(ctx.homeDir, ctx.env), "learning");
  return { workspaceId, boardRoot: path.join(learning, "board"),
    factsRoot: path.join(learning, "skill", sha256Hex(workspaceId).slice(0, 20), "facts") };
}

/** Reads and short, explicit Board writes only. No writer lock lives across a model call or UI session. */
export function createSkillDailyManagement(ctx: CliContext): Pick<SkillLearningCommandPort, "list" | "show" | "withdraw"> {
  const paths = skillDailyManagementPaths(ctx);
  const facts = () => createSkillExperienceFile({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled", retention: "segmented" }).read("skill-management");
  const read = async () => {
    const loaded = await createBoardReader(paths.boardRoot).load();
    if (!loaded.ok) throw new ManagementError(loaded.reason);

    const history = facts();
    if (!history.ok) throw new ManagementError(history.code);

    const journalUses = await readSkillJournalUses(ctx, loaded.state, paths.workspaceId);
    if (history.opportunity.experiences.some(fact => {
      const used = fact.usedSkill;
      return used !== undefined && !journalUses.some(use => use.runId === fact.runId && use.versionId === used.versionId
        && use.variantId === used.variantId && use.contentHash === used.contentHash);
    })) {
      throw new ManagementError("skill_usage_history_unavailable");
    }

    return { state: loaded.state, experiences: history.opportunity.experiences, journalUses };
  };

  return {
    async list() {
      try {
        const { state, experiences, journalUses } = await read(), skills: SkillLearningSummary[] = [];

        for (const asset of state.assets) {
          if (asset.kind !== "skill") continue;
          const content = decodeLearnedSkillContent(asset.content);
          if (content === undefined && typeof asset.content === "object" && asset.content !== null && "kind" in asset.content
            && asset.content.kind === "learned_skill") throw new ManagementError("invalid_skill_history");
          if (content?.workspaceId !== paths.workspaceId) continue;
          skills.push(describe(state, experiences, asset.versionId, paths.workspaceId, journalUses).summary);
        }

        skills.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version);

        return { schemaVersion: 1, ok: true, workspaceId: paths.workspaceId, skills };
      } catch (error) { return failure(error); }
    },

    async show(versionId) {
      try {
        const { state, experiences, journalUses } = await read(), selected = describe(state, experiences, versionId, paths.workspaceId, journalUses);
        return { schemaVersion: 1, ok: true, skill: selected.summary, content: renderSkillMarkdown(selected.content.draft),
          uses: [...selected.uses.map(fact => ({ runId: fact.runId, variantId: fact.usedSkill!.variantId, outcome: fact.episode.outcome, sourceRef: fact.sourceRef })),
            ...selected.unqualified.map(use => ({ runId: use.runId, variantId: use.variantId, outcome: "unknown", sourceRef: use.sourceRef }))] };
      } catch (error) { return failure(error); }
    },

    async withdraw(versionId) {
      try {
        const result = await withBoardWriter(paths.boardRoot, async store => {
          const loaded = await store.load();
          if (!loaded.ok) throw new ManagementError(loaded.reason);

          describe(loaded.state, [], versionId, paths.workspaceId);

          if (loaded.state.tombstones.some(item => item.entityType === "asset" && item.entityId === versionId)) {
            return { schemaVersion: 1 as const, ok: true as const, versionId, status: "already_withdrawn" as const };
          }

          const saved = await store.apply({ type: "tombstone", entityId: versionId, entityType: "asset",
            commandId: `skill-withdraw:${versionId}`, issuedAt: new Date(ctx.now()).toISOString(), reason: "user_explicit_skill_withdrawal" });
          if (!saved.ok) throw new ManagementError(saved.reason);

          return { schemaVersion: 1 as const, ok: true as const, versionId, status: "withdrawn" as const };
        });
        if (!("schemaVersion" in result)) return failure(new ManagementError(result.reason));

        if (result.status === "withdrawn") await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
          reason: "skill_archive_withdrawal_committed", sourceRefs: [versionId, `skill-withdraw:${versionId}`] });

        return result;
      } catch (error) { return failure(error); }
    },
  };
}

function describe(state: BoardState, experiences: readonly SkillExperience[], versionId: string, workspaceId: string, journalUses: readonly SkillJournalUse[] = []) {
  const asset = state.assets.find(item => item.versionId === versionId), content = decodeLearnedSkillContent(asset?.content);
  const proposal = state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);

  if (!asset || asset.kind !== "skill" || !content || content.workspaceId !== workspaceId) throw new ManagementError("skill_version_not_found");

  if (asset.schemaVersion !== 1 || asset.contentHash !== contentHashOf(asset.content) || !proposal || proposal.proposalId !== content.draft.id
    || proposal.assetKind !== "skill" || proposal.scope !== asset.scope || asset.scope !== projectionScope(content.draft.scope)) throw new ManagementError("invalid_skill_history");

  const loads = journalUses.filter(use => use.versionId === versionId && use.contentHash === asset.contentHash);
  const uses = experiences.filter(fact => fact.usedSkill?.versionId === versionId && fact.usedSkill.contentHash === asset.contentHash
    && loads.some(use => use.runId === fact.runId && use.variantId === fact.usedSkill?.variantId));
  const qualified = new Set(uses.map(fact => fact.runId));
  const unqualified = loads.filter((use, index) => !qualified.has(use.runId) && loads.findIndex(other => other.runId === use.runId) === index);
  const pointer = state.activations.find(item => item.versionId === versionId)?.pointer;
  const withdrawn = state.tombstones.some(item => item.entityId === versionId || item.entityId === proposal.proposalId);
  const summary: SkillLearningSummary = { versionId, proposalId: proposal.proposalId, name: content.draft.name,
    version: content.draft.version, status: withdrawn ? "retired" : ["rejected", "suspended", "retired", "rolled_back"].includes(proposal.lifecycle)
      ? proposal.lifecycle : pointer ?? (proposal.lifecycle === "shadow" || proposal.lifecycle === "active" ? "superseded" : proposal.lifecycle), createdAt: asset.createdAt,
    taskFamily: content.draft.taskFamily, sourceOpportunityId: content.sourceOpportunityId,
    observationRefs: content.draft.provenance.observationRefs, contentHash: asset.contentHash,
    ...(asset.parentVersionId === undefined ? {} : { parentVersionId: asset.parentVersionId }),
    usage: { loads: new Set(loads.map(use => use.runId)).size, qualifiedRuns: qualified.size, unknownOutcomes: unqualified.length,
      successes: new Set(uses.filter(fact => fact.episode.outcome === "success").map(fact => fact.runId)).size,
      failures: new Set(uses.filter(fact => fact.episode.outcome === "failure").map(fact => fact.runId)).size } };

  return { summary, content, uses, unqualified };
}

class ManagementError extends Error { constructor(readonly code: string) { super(code); } }

function failure(error: unknown): SkillLearningCommandError {
  return { schemaVersion: 1, ok: false, code: error instanceof ManagementError ? error.code : "skill_management_unavailable", message: "技能记录暂不可用，请核对当前工作区或稍后重试。" };
}
