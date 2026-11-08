import type { BoardCommand } from "../../../../control/commands.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { CollaborationBoardPort } from "./contracts.js";
import type { CollaborationAnalysisWindowV2, CollaborationPracticeDraftV2, CollaborationPracticeV2 } from "./v2-contracts.js";
import { practiceV2SourcesValid } from "./v2-policy.js";
import { lineageFailureV2 } from "./v2-admissibility.js";
import { isCollaborationPracticeV2 } from "./v2-parse.js";

export async function admitCollaborationV2(input: { readonly board: CollaborationBoardPort; readonly state: BoardState;
  readonly scope: string; readonly cycleId: string; readonly window: CollaborationAnalysisWindowV2; readonly windowHash: string;
  readonly draft: CollaborationPracticeDraftV2; readonly now: () => string; readonly canContinue: () => boolean }) {
  const { draft, window, scope } = input;

  if (!draft.sourceEventIds.every(id => window.events.some(e => e.factId === id))
    || !draft.sourceEpisodeIds.every(id => window.episodes.some(e => e.factId === id))
    || !draft.sourceOutcomeIds.every(id => window.outcomes.some(e => e.factId === id))) return { ok: false as const, reason: "analysis_citation_outside_window" };

  const content: CollaborationPracticeV2 = { ...draft, schema: "collaboration-practice/v2", status: "trial",
    sourceWindowHash: input.windowHash, cycleId: input.cycleId };
  if (!practiceV2SourcesValid(input.state, scope, content)) return { ok: false as const, reason: "analysis_evidence_not_grounded" };

  const identity = contentHashOf({ scope, content });
  const versionId = `collaboration-v2-version:${identity}`, proposalId = `collaboration-v2-proposal:${identity}`, issuedAt = input.now();
  const own = input.state.assets.find(a => a.versionId === versionId && a.scope === scope && a.createdFromProposalId === proposalId
    && a.contentHash === contentHashOf(content));
  const latest = input.state.assets.filter(a => a.scope === scope && isCollaborationPracticeV2(a.content) && a.content.familyId === draft.familyId).at(-1);
  if (own === undefined || latest?.versionId !== versionId) {
    const lineage = lineageFailureV2(input.state, scope, draft);
    if (lineage !== undefined) return { ok: false as const, reason: lineage };
  }

  const commands: BoardCommand[] = [
    { type: "submit_proposal", commandId: `${proposalId}:submit`, issuedAt, proposal: { proposalId, domain: "collaboration", scope,
      assetKind: "workflow", candidateRef: versionId, hypothesis: draft.hypothesis,
      observationRefs: [...draft.sourceEventIds, ...draft.sourceEpisodeIds, ...draft.sourceOutcomeIds], risk: "low", requiredVerifiers: [],
      requestedAuthorities: [], source: "inferred", ...(draft.parentVersionId === undefined ? {} : { baseVersionId: draft.parentVersionId }) } },
    { type: "quarantine", commandId: `${proposalId}:quarantine`, issuedAt, proposalId },
    { type: "commit_asset", commandId: `${proposalId}:commit`, issuedAt, proposalId, versionId, content, schemaVersion: 2,
      ...(draft.parentVersionId === undefined ? {} : { parentVersionId: draft.parentVersionId }) },
    { type: "start_evaluation", commandId: `${proposalId}:evaluate`, issuedAt, proposalId },
  ];
  let state = input.state;

  for (const command of commands) {
    if (!input.canContinue()) return { ok: false as const, reason: "learning_aborted" };
    const applied = await input.board.apply(command);
    if (!applied.ok) return { ok: false as const, reason: applied.reason };
    state = applied.state;
  }

  return { ok: true as const, versionId, state };
}
