import { resolve } from "node:path";
import type { BoardState } from "../../learning/control/state.js";
import { collaborationUsageTotalsV2 } from "../../learning/domains/collaboration/v2-retention.js";
import { liveCollaborationVersionsV2, effectiveCollaborationCorrectionsV2 } from "../../learning/domains/collaboration/v2-policy.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createFileCollaborationBoard } from "../../integration/collaboration-learning/board-port.js";
import type { CollaborationCorrectionV2, CollaborationCycleV2 } from "../../learning/domains/collaboration/v2-contracts.js";
import { isCollaborationPracticeV2 } from "../../learning/domains/collaboration/v2-parse.js";
import { createCollaborationSubsystemV2 } from "../../learning/domains/collaboration/v2-service.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CollaborationGovernanceOptions } from "./args-collaboration-governance.js";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

/** Read and explicit user correction share the Board writer; no provider, task or tool composition. */
export async function handleCollaborationGovernance(ctx: CliContext, options: CollaborationGovernanceOptions): Promise<ExitCode> {
  const scope = resolve(ctx.cwd, options.workspace ?? ctx.cwd);
  const write = (result: object, ok: boolean): ExitCode => {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 2, ...result })}\n`);
    return ok ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE;
  };

  if (!ctx.isDirectory(scope)) return write({ ok: false, reason: "workspace_unavailable" }, false);

  const board = createFileCollaborationBoard(`${tryloHome(ctx.homeDir, ctx.env)}/learning/board`);
  const loaded = await board.load();
  if (!loaded.ok) return write({ ok: false, reason: loaded.reason }, false);

  const state = loaded.state;
  const facts = state.collaborationV2Facts ?? [];
  const corrections = facts.filter((f): f is CollaborationCorrectionV2 => f.kind === "correction" && f.scope === scope);
  const assets = state.assets.filter(asset => asset.scope === scope && isCollaborationPracticeV2(asset.content));

  if (options.operation === "status") return write(statusOf(state, scope), true);

  if (!assets.some(asset => isCollaborationPracticeV2(asset.content) && asset.content.familyId === options.familyId)) {
    return write({ ok: false, reason: "unknown_practice_family" }, false);
  }

  if (options.action === "restore") {
    const prior = corrections.find(c => c.factId === options.replacesCorrectionId && c.action === "suspend"
      && c.familyId === options.familyId && contentHashOf(c.appliesTo) === contentHashOf(options.appliesTo));
    if (prior === undefined) return write({ ok: false, reason: "correction_restore_scope_mismatch" }, false);
  }

  const correction: CollaborationCorrectionV2 = { schemaVersion: 2, kind: "correction", scope,
    factId: ctx.newId("collaboration-correction"), recordedAt: new Date(ctx.now()).toISOString(),
    familyId: options.familyId, action: options.action, appliesTo: options.appliesTo, evidenceRef: options.evidenceRef,
    ...(options.replacesCorrectionId === undefined ? {} : { replacesCorrectionId: options.replacesCorrectionId }) };
  const service = createCollaborationSubsystemV2({ board, now: () => new Date(ctx.now()).toISOString(),
    analyzer: { analyze: async () => ({ status: "failed", reason: "governance_has_no_model", tokenCost: 0 }) } });
  const result = await service.correct(correction);
  if (result.ok) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: correction.scope,
    reason: "collaboration_user_correction_committed", sourceRefs: [correction.factId] });

  return result.ok ? write({ ok: true, correctionId: correction.factId }, true) : write(result, false);
}

function statusOf(state: BoardState, scope: string) {
  const facts = state.collaborationV2Facts ?? [];
  const cycles = new Map<string, CollaborationCycleV2>();

  for (const fact of facts) if (fact.kind === "cycle" && fact.scope === scope) cycles.set(fact.cycleId, fact);

  const practices = liveCollaborationVersionsV2(state, scope).flatMap(asset => {
    if (!isCollaborationPracticeV2(asset.content)) return [];

    const practice = asset.content;
    const related = facts.filter((f): f is CollaborationCorrectionV2 => f.kind === "correction" && f.scope === scope && f.familyId === practice.familyId);
    const suspended = effectiveCollaborationCorrectionsV2(facts, scope, practice.familyId).some(c => c.appliesTo.kind === "workspace");

    return [{ familyId: practice.familyId, versionId: asset.versionId, title: practice.title, hypothesis: practice.hypothesis,
      status: suspended ? "suspended" : "trial", conditions: practice.conditions, actions: practice.actions,
      evidenceRefs: [...practice.sourceEventIds, ...practice.sourceEpisodeIds, ...practice.sourceOutcomeIds], corrections: related }];
  });

  return { ok: true, scope, boardSequence: state.sequence, cycles: [...cycles.values()], practices, usageTotals: collaborationUsageTotalsV2(state, scope),
    archives: (state.collaborationV2Archives ?? []).filter(a => a.scope === scope) };
}
