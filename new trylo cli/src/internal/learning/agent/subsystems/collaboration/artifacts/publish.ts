import type { BoardStore } from "../../../../control/store-port.js";
import type { BoardCommand } from "../../../../control/commands.js";
import { contentHashOf } from "../../../../control/hash.js";

export type CollaborationArtifactOptions = {
  readonly board: Pick<BoardStore, "load" | "apply">;
  readonly scope: string;
  readonly now: () => string;
  readonly enabled?: () => boolean;
  readonly canPublish?: () => Promise<boolean>;
};

export type CollaborationArtifactDraft = {
  readonly issueId: string; readonly familyId: string; readonly title: string;
  readonly hypothesis: string; readonly sourceRefs: readonly string[];
  readonly content: unknown; readonly schemaVersion: number;
  readonly parentVersionId?: string; readonly kind: "experience" | "plan";
};

export type CollaborationArtifactResult = { readonly ok: true; readonly versionId: string; readonly proposalId: string }
  | { readonly ok: false; readonly reason: string };

/** Trial content is immutable Board data. Publishing confers neither activation nor execution authority. */
export async function publishCollaborationArtifact(options: CollaborationArtifactOptions,
  draft: CollaborationArtifactDraft): Promise<CollaborationArtifactResult> {
  if (!draft.title.trim() || !draft.familyId.trim() || draft.sourceRefs.length < 1 || draft.sourceRefs.length > 64) {
    return { ok: false, reason: "artifact_input_invalid" };
  }

  const identity = contentHashOf({ scope: options.scope, content: draft.content });
  const versionId = `collaboration-${draft.kind}-version:${identity}`;
  const proposalId = `collaboration-${draft.kind}-proposal:${identity}`;
  const commands: BoardCommand[] = [
    { type: "submit_proposal", commandId: `${proposalId}:submit`, issuedAt: options.now(), proposal: {
      proposalId, domain: "collaboration", scope: options.scope, assetKind: "workflow", candidateRef: versionId,
      hypothesis: draft.hypothesis, observationRefs: draft.sourceRefs, risk: "low", requiredVerifiers: [],
      requestedAuthorities: [], source: "inferred" } },
    { type: "quarantine", commandId: `${proposalId}:quarantine`, issuedAt: options.now(), proposalId },
    { type: "commit_asset", commandId: `${versionId}:commit`, issuedAt: options.now(), proposalId, versionId,
      content: draft.content, schemaVersion: draft.schemaVersion,
      ...(draft.parentVersionId === undefined ? {} : { parentVersionId: draft.parentVersionId }) },
    { type: "start_evaluation", commandId: `${proposalId}:evaluate`, issuedAt: options.now(), proposalId },
  ];

  try {
    for (const command of commands) {
      if (options.enabled?.() === false || options.canPublish !== undefined && !await options.canPublish()) {
        return { ok: false, reason: "learning_inactive" };
      }

      if (options.enabled?.() === false) return { ok: false, reason: "learning_inactive" };

      const latest = await options.board.load();
      if (!latest.ok) return { ok: false, reason: latest.reason };

      if (options.enabled?.() === false) return { ok: false, reason: "learning_inactive" };

      const issue = latest.state.learningIssues?.find(item => item.issueId === draft.issueId && item.scope === options.scope);
      if (issue?.decision.kind !== "focused_learning") return { ok: false, reason: "issue_no_longer_focused" };

      const applied = await options.board.apply(command);
      if (!applied.ok) return { ok: false, reason: applied.reason };
    }
    return { ok: true, versionId, proposalId };
  } catch {
    return { ok: false, reason: "board_unavailable" };
  }
}
