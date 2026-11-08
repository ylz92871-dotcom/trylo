import type { AgentLearningDomain, AgentLearningDocument, AgentLearningEntry } from "../../protocol/agent-learning-read.js";
import type { BoardState } from "../../learning/control/state.js";
import { variantsOf } from "../../learning/agent/subsystems/method/adapters/board-writer.js";
import { workflowFromBoard } from "../../learning/agent/subsystems/workflow/runtime/archive.js";
import { workflowImprovementsFromBoard } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { collaborationArchiveFromBoard } from "../../learning/agent/subsystems/collaboration/experience/archive.js";
import { isCollaborationExperienceContent } from "../../learning/agent/subsystems/collaboration/experience/parse.js";
import { isCollaborationPracticeV2 } from "../../learning/domains/collaboration/v2-parse.js";
import { effectiveCollaborationCorrectionsV2 } from "../../learning/domains/collaboration/v2-policy.js";
import { contentHashOf } from "../../learning/control/hash.js";

type ReadResult = { readonly ok: true; readonly entries: readonly AgentLearningDocument[] } | { readonly ok: false; readonly reason: string };

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function fenced(value: unknown): string {
  const body = json(value), ticks = Math.max(3, ...[...body.matchAll(/`+/g)].map(item => item[0].length + 1));
  const fence = "`".repeat(ticks);
  return `${fence}json\n${body}\n${fence}`;
}

function document(entry: AgentLearningEntry, sections: readonly [string, string][]): AgentLearningDocument {
  const raw = json(entry.content);
  return { ...entry, raw, markdown: `# ${entry.title}\n\n${sections.map(([name, body]) => `## ${name}\n\n${body}`).join("\n\n")}\n\n## 完整存储对象\n\n${fenced(entry.content)}` };
}

/** Presentation follows the domain's existing records, never turns inferred assets into approvals. */
export function readAgentLearningDocuments(state: BoardState, domain: AgentLearningDomain, scope: string, workspaceId: string): ReadResult {
  if (domain === "method") return methods(state);
  if (domain === "workflow") return workflows(state, workspaceId, scope);
  return collaboration(state, scope);
}

function methods(state: BoardState): ReadResult {
  const variants = variantsOf(state).filter(variant => !state.tombstones.some(item => item.entityId === variant.versionId || item.entityId === variant.proposalId));

  for (const variant of variants) {
    const asset = state.assets.find(item => item.versionId === variant.versionId)!;
    if (asset.contentHash !== contentHashOf(asset.content)) return { ok: false, reason: "method_archive_corrupt" };
  }

  const entries = variants.map(variant => {
    const asset = state.assets.find(item => item.versionId === variant.versionId)!;
    const related = [
      ...state.fieldings.filter(item => item.versionId === variant.versionId),
      ...state.feedbacks.filter(item => item.versionId === variant.versionId),
    ];

    return document({ domain: "method", id: variant.versionId, versionId: variant.versionId,
      title: variant.card.hint, summary: variant.card.hint, status: variant.retention === "evicted" ? "evicted" : variant.ledger.state,
      source: asset.source, scope: asset.scope, createdAt: asset.createdAt, content: { ...variant }, related }, [
      ["当前做法", variant.card.hint], ["适用条件", fenced(variant.card.appliesWhen)],
      ["形成依据", fenced(variant.card.lineage)], ["采用与反馈", fenced(related)], ["留存与状态", fenced({ layer: variant.layer ?? "working", retention: variant.retention ?? "retained", ledger: variant.ledger })],
    ]);
  });

  return { ok: true, entries };
}

function workflows(state: BoardState, workspaceId: string, pathScope: string): ReadResult {
  const entries: AgentLearningDocument[] = [];
  const scopes = new Set([workspaceId, pathScope]);

  for (const asset of state.assets) {
    if (state.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId)) continue;

    if (!scopes.has(asset.scope) || typeof asset.content !== "object" || asset.content === null || !("type" in asset.content)
      || asset.content.type !== "workflow_learning") continue;

    const read = workflowFromBoard(state, asset.versionId);
    if (!read.ok) return { ok: false, reason: read.code };

    const artifact = read.value;

    entries.push(document({ domain: "workflow", id: asset.versionId, versionId: asset.versionId,
      title: artifact.taskFamily.intentClass, summary: artifact.nodes.map(node => node.check).join("；"), status: artifact.mode,
      source: asset.source, scope: asset.scope, createdAt: asset.createdAt, content: { ...artifact }, related: artifact.traces }, [
      ["适用条件", fenced(artifact.conditions ?? {})], ["步骤与产物", fenced(artifact.nodes)],
      ["恢复与经验", fenced(artifact.recovery)], ["分支", fenced(artifact.branches ?? [])], ["采用依据", fenced(artifact.traces)],
    ]));
  }

  for (const scope of scopes) {
    const read = workflowImprovementsFromBoard(state, scope, pathScope);
    if (!read.ok) return { ok: false, reason: read.code };

    for (const item of read.value.versions) {
      const asset = state.assets.find(asset => asset.versionId === item.versionId)!;
      const related = read.value.uses.filter(use => use.use.versionId === item.versionId);
      const feedback = read.value.feedback.filter(fact => fact.versionId === item.versionId);

      entries.push(document({ domain: "workflow", id: item.versionId, versionId: item.versionId,
        title: item.artifact.proposal.procedure.name, summary: item.artifact.opportunity.problem, status: item.status,
        source: asset.source, scope, createdAt: asset.createdAt, content: { ...item.artifact }, related }, [
        ["要改善的问题", item.artifact.opportunity.problem], ["步骤与产物", fenced(item.artifact.proposal.procedure)],
        ["这次改变", fenced(item.artifact.proposal.changes)], ["采用记录", fenced(related)], ["反馈", fenced(feedback)],
      ]));
    }

    for (const item of read.value.opportunities) {
      const asset = state.assets.find(asset => asset.versionId === item.versionId)!;
      entries.push(document({ domain: "workflow", id: item.versionId, versionId: item.versionId,
        title: item.record.opportunity.problem, summary: item.record.opportunity.desiredOutcome, status: "opportunity",
        source: asset.source, scope, createdAt: asset.createdAt, content: { ...item.record } }, [
        ["发现的问题", item.record.opportunity.problem], ["期望结果", item.record.opportunity.desiredOutcome],
        ["依据", fenced(item.record.opportunity.evidenceRefs)],
      ]));
    }
  }

  return { ok: true, entries };
}

function collaboration(state: BoardState, scope: string): ReadResult {
  const read = collaborationArchiveFromBoard(state, scope);
  if (!read.ok) return read;

  const entries: AgentLearningDocument[] = read.assets.map(asset => {
    const content = asset.content;
    const trial = isCollaborationExperienceContent(content);
    const title = trial ? content.situation : content.title;
    const related = (state.collaborationRuntimeReceipts ?? []).filter(item => item.scope === scope && "versionIds" in item && item.versionIds.includes(asset.versionId));

    return document({ domain: "collaboration", id: asset.versionId, versionId: asset.versionId, title,
      summary: trial ? content.practice : content.summary, status: trial ? content.status : "proposed",
      source: asset.source, scope, createdAt: asset.createdAt, content: { ...content }, related }, trial ? [
        ["情境", content.situation], ["职责", content.responsibilities.map(item => `- ${item}`).join("\n")],
        ["形成的做法", content.practice], ["适用条件", fenced(content.conditions)], ["采用与反馈", fenced(related)],
      ] : [["调整方案", fenced(content.adjustments)], ["依赖能力", fenced(content.needs)], ["来源", fenced(content.sourceRefs)]]);
  });

  for (const asset of state.assets) {
    if (asset.scope !== scope || !isCollaborationPracticeV2(asset.content)) continue;

    if (state.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId)) continue;

    if (asset.contentHash !== contentHashOf(asset.content)) return { ok: false, reason: "collaboration_archive_corrupt" };

    const content = asset.content;
    const related = (state.collaborationV2Facts ?? []).filter(item => item.scope === scope && "familyId" in item && item.familyId === content.familyId);
    const suspended = effectiveCollaborationCorrectionsV2(state.collaborationV2Facts ?? [], scope, content.familyId)
      .some(correction => correction.appliesTo.kind === "workspace");

    entries.push(document({ domain: "collaboration", id: asset.versionId, versionId: asset.versionId,
      title: content.title, summary: content.hypothesis, status: suspended ? "legacy_suspended" : "legacy_trial", source: asset.source, scope,
      createdAt: asset.createdAt, content: { ...content }, related }, [
      ["形成的约定", fenced(content.actions)], ["适用条件", fenced(content.conditions)], ["历史采用与纠正", fenced(related)],
    ]));
  }

  return { ok: true, entries };
}
