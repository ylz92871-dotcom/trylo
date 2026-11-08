import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { BoardState } from "../../learning/control/state.js";
import { projectOrganizationDomainFeedback } from "../../integration/central-learning/organization-feedback-sources.js";
import type { ContentDomainFeedbackChange } from "../../integration/learning-content/sources/domain-feedback.js";
import type { CliContext } from "./context.js";
import { isValidSessionId, listSessions, sessionsDir } from "./session-paths.js";
import { isRuntimeFingerprint } from "../../ports/session.js";
import { readRuntimeSessionHeader } from "../../adapters/central-learning-runtime/session-header.js";
import { validateSessionContentJournal } from "../../integration/learning-content/sources/session-decode.js";
import { createRuntimeSessionWorkspaceAccess } from "./central-runtime-materials-scope.js";

/** Their canonical issue/state sources are read separately. Raw management
 * responses are not business experience and must stay out of source paging. */
export const CENTRAL_LEARNING_CONTROL_TOOLS = ["central_learning", "collaboration_report", "collaboration_inspect",
  "collaboration_decide", "collaboration_resume", "method_context", "tool_learning_report",
  "skill_proposals", "workflow_learning"] as const;

/** Read through the original session registry. The content producer additionally
 * validates the source journal's workspace before exposing original material. */
export function centralLearningSessionLookup(ctx: CliContext) {
  return async (sessionId: string, signal: AbortSignal) => {
    if (signal.aborted || !isValidSessionId(sessionId)) return undefined;
    const entry = listSessions(ctx, sessionsDir(ctx.homeDir, ctx.env)).find(row => row.id === sessionId);
    return entry === undefined ? undefined : createNdjsonSessionStore({ path: entry.path });
  };
}

/** Exact historical turn lookup, without a second persistent session index.
 * The source adapter still validates each returned journal and rejects an
 * ambiguous task. Unreadable registry members cannot prove uniqueness. */
export function centralLearningTaskSessions(ctx: CliContext, workspaceId: string) {
  const workspace = createRuntimeSessionWorkspaceAccess({ ctx, workspaceId });
  return async (taskId: string, signal: AbortSignal): Promise<readonly string[]> => {
    const matches: string[] = [];

    for (const entry of listSessions(ctx, sessionsDir(ctx.homeDir, ctx.env))) {
      if (signal.aborted) throw new Error("central_source_lookup_cancelled");

      const header = await readRuntimeSessionHeader(entry.path, entry.id, signal);

      if (signal.aborted) throw new Error("central_source_lookup_cancelled");

      if (!header.ok) {
        if (header.reason === "session_header_missing") continue;
        throw new Error(`central_source_registry_unavailable:${header.reason}`);
      }

      if (!workspace.accepts(header.value)) continue;

      const loaded = await createNdjsonSessionStore({ path: entry.path }).readRecords();

      if (signal.aborted) throw new Error("central_source_lookup_cancelled");

      if (!loaded.ok) throw new Error(`central_source_registry_unavailable:${loaded.code}`);

      const checked = validateSessionContentJournal(loaded.view, entry.id);
      if (!checked.ok) throw new Error(checked.reason);

      const fingerprint = loaded.view.records[0]?.payload.fingerprint;
      if (!isRuntimeFingerprint(fingerprint)) throw new Error("central_source_registry_fingerprint_invalid");

      if (!workspace.matchesHeader(header.value, fingerprint)) throw new Error("content_material_scope");

      if (loaded.view.records.some(record => record.turnId === taskId)) matches.push(entry.id);
    }

    return matches;
  };
}

/** Host composition only: each domain selects and interprets its own immutable
 * approval/use/feedback sources. This bridge assigns no numeric utility. */
export function projectCentralDomainFeedback(board: BoardState, input: {
  readonly scope: string; readonly workspaceId: string; readonly issueId: string;
  readonly nativeChanges?: readonly ContentDomainFeedbackChange[];
}) {
  return projectOrganizationDomainFeedback(board, input);
}
