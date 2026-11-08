import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { ContentIssueContextError, createContentIssueContextReader } from "../../integration/learning-content/index.js";
import { projectOrganizationNativeFeedbackChanges } from "../../integration/central-learning/organization-feedback-changes.js";
import type { ContentDomainFeedbackChange } from "../../integration/learning-content/sources/domain-feedback.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { CliContext } from "./context.js";
import { centralLearningSessionLookup, centralLearningTaskSessions, projectCentralDomainFeedback } from "./central-learning-sources.js";
import { methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./workspace-identity.js";
import type { CentralRuntimeReadWorkspaceSnapshot } from "./central-runtime-read-access.js";

type ScopePair = { readonly scope: string; readonly workspaceId: string };

type SourceReadAccess = CentralRuntimeReadWorkspaceSnapshot & { readonly pairs: readonly ScopePair[] };

type SourceOptions = { readonly maximumChars: number; readonly enabled: () => boolean;
  readonly readWorkspaceAccess?: () => CentralRuntimeReadWorkspaceSnapshot };

/** Read-only original source factories. A background learner never acquires a business session writer lease. */
export function centralRuntimeSources(ctx: CliContext, workspaceId: string, options: SourceOptions) {
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), scope = ctx.cwd;
  const roots = Object.freeze([...(ctx.workspaceIdentity?.compatibleRoots ?? [])]), pairs = scopePairs(scope, workspaceId, roots);
  const initial: SourceReadAccess = { revision: 0, roots, pairs,
    workspaceIds: Object.freeze([...new Set(pairs.map(pair => pair.workspaceId))]),
    scopes: Object.freeze([...new Set(pairs.flatMap(pair => [pair.scope, pair.workspaceId]))]) };
  const readAccess = (): SourceReadAccess => {
    const snapshot = options.readWorkspaceAccess?.();
    return snapshot === undefined ? initial : { ...snapshot, pairs: scopePairs(scope, workspaceId, snapshot.roots) };
  };
  const readCompatibleScopes = () => options.readWorkspaceAccess?.().scopes ?? initial.scopes;
  const nativeScope = (board: BoardState, issueId: string, access: SourceReadAccess) => {
    const issue = board.learningIssues?.find(row => row.issueId === issueId && access.scopes.includes(row.scope));
    if (issue === undefined) return undefined;
    return access.pairs.some(pair => pair.scope === issue.scope || pair.workspaceId === issue.scope) ? issue.scope : undefined;
  };
  const changes = new WeakMap<BoardState, { readonly revision: number; readonly rows: readonly ContentDomainFeedbackChange[] }>();
  const getChanges = (board: BoardState, access: SourceReadAccess): readonly ContentDomainFeedbackChange[] => {
    let selected = changes.get(board);
    if (selected?.revision !== access.revision) {
      const seen = new Set<string>();
      const rows = access.pairs.flatMap(pair => projectOrganizationNativeFeedbackChanges(board, pair)).filter(row => {
        const key = JSON.stringify([row.domain, row.issueId, row.factRef, row.unitRef, row.revisionRef, row.kind]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      selected = { revision: access.revision, rows };
      changes.set(board, selected);
    }

    return selected.rows;
  };
  const domainFeedback = (board: BoardState, issueId: string, access: SourceReadAccess) => {
    const original = nativeScope(board, issueId, access);
    if (original === undefined) return undefined;

    let selected: ReturnType<typeof projectCentralDomainFeedback>;

    for (const pair of access.pairs.filter(row => row.scope === original || row.workspaceId === original)) {
      const frame = projectCentralDomainFeedback(board, { ...pair, issueId, nativeChanges: getChanges(board, access) });
      if (frame === undefined) continue;
      if (selected !== undefined && canonicalJson(selected) !== canonicalJson(frame)) throw new ContentIssueContextError("central_runtime_native_source_ambiguous");
      selected = frame;
    }

    return selected;
  };
  const board = createBoardReader(boardRoot), readers = new Map<string, {
    readonly revision: number; readonly read: ReturnType<typeof createContentIssueContextReader>;
  }>();
  const contextForIssue = async (issueId: string) => {
    const access = readAccess();

    if (!options.enabled()) return undefined;

    const loaded = await board.load();
    if (!loaded.ok) throw new ContentIssueContextError(loaded.reason);

    const original = nativeScope(loaded.state, issueId, access);
    if (original === undefined) throw new ContentIssueContextError("content_issue_missing");

    let reader = readers.get(original);
    if (reader?.revision !== access.revision) {
      reader = { revision: access.revision, read: createContentIssueContextReader({ boardRoot, scope: original,
        domainFeedback: (state, id) => domainFeedback(state, id, access), maximumChars: options.maximumChars, enabled: options.enabled }) };
      readers.set(original, reader);
    }

    return reader.read(issueId);
  };
  const originalTaskLookup = centralLearningTaskSessions(ctx, workspaceId);
  const lookupSessionsForTask = options.readWorkspaceAccess === undefined ? originalTaskLookup : (taskId: string, signal: AbortSignal) => {
    const access = readAccess(), identity = ctx.workspaceIdentity;
    const operationCtx = identity === undefined ? ctx : { ...ctx, workspaceIdentity: { ...identity,
      compatibleRoots: access.roots, compatibleWorkspaceIds: access.workspaceIds } };
    return centralLearningTaskSessions(operationCtx, workspaceId)(taskId, signal);
  };

  return { boardRoot, scope, get compatibleScopes() { return readCompatibleScopes(); }, readCompatibleScopes, board,
    lookupSession: centralLearningSessionLookup(ctx), lookupSessionsForTask,
    nativeFeedbackChanges: (state: BoardState) => getChanges(state, readAccess()),
    domainFeedback: (state: BoardState, issueId: string) => domainFeedback(state, issueId, readAccess()),
    contextForIssue };
}

function scopePairs(scope: string, workspaceId: string, roots: readonly string[]): readonly ScopePair[] {
  return [{ scope, workspaceId }, ...roots.map(root => ({ scope: root, workspaceId: workspaceIdentity(root) }))]
    .filter((pair, index, all) => all.findIndex(other => other.scope === pair.scope && other.workspaceId === pair.workspaceId) === index);
}
