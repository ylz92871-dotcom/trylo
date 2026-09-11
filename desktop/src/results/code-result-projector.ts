// Trylo Desktop — CodeResultProjector (P2-1, spec §5.1 / §7).
//
// Implements the Code run lifecycle observer. It captures a Git baseline at
// run start, accumulates structured tool events during the run, and at the
// terminal outcome captures a final snapshot, computes the run-observed
// change delta, classifies the checks, and writes an immutable code result
// into the ConversationResultRepository (via the injected `store` port).
//
// It never parses assistant text, never searches stdout, never blocks the
// Agent run, and finalizes exactly once per runId.

import { hostAdapter, type GitService, type GitWorkspaceSnapshot, type GitSnapshotEntry, type GitDiffStat } from '../host-adapter';
import type { LoopEvent } from '../host-adapter/loop-events';
import { classifyCodeChecks } from './code-check-classifier';
import { resultScopeKey } from './result-scope';
import type { RuntimeResultScope } from './result-scope';
import type {
  CodeAttribution,
  CodeFileChangeKind,
  StoredCodeChange,
  StoredCodeRunResult,
} from './conversation-result-types';
import type { CodeRunLifecycleObserver, CodeRunOutcome } from '../runtime/code-run-lifecycle';
import { BOUNDS } from './conversation-result-normalizer';

/** Baseline budget (spec §14): a slow snapshot never waits forever. */
const BASELINE_BUDGET_MS = 3000;
const FINAL_BUDGET_MS = 5000;
/** WP-4: headroom for the batched diff-stats fetch at terminal time. Bounded
 *  so a slow Git host never delays finalize past its budget; a failure here
 *  only degrades `statsComplete`, never the projection or the run. */
const STATS_BUDGET_MS = 2000;

/** Port through which the projector writes normalized code results. The host
 *  (App) adapts this to ConversationResultRepository.update, and uses
 *  `projectRoot` to persist into the right workspace history. */
export interface CodeResultStore {
  update(
    projectKey: string,
    projectRoot: string,
    conversationId: string,
    code: StoredCodeRunResult | undefined,
  ): void;
}

export interface CodeResultProjectorOptions {
  readonly git?: GitService;
  readonly store: CodeResultStore;
  readonly now?: () => number;
  /** Test seams: bounded snapshot budgets (spec §14 defaults apply). */
  readonly baselineBudgetMs?: number;
  readonly finalBudgetMs?: number;
  /** WP-4: bounded budget for the terminal diff-stats fetch. */
  readonly statsBudgetMs?: number;
}

/** Per-run projection lifecycle state (audit P1-1). Created SYNCHRONOUSLY by
 *  `onRunStarted` so the event buffer exists from the first moment; the
 *  baseline snapshot runs asynchronously behind `baselinePromise`, which the
 *  terminal shares — so a terminal can never finalize against a baseline the
 *  start never captured, and a snapshot reject/timeout degrades the
 *  projection instead of blocking finalize. Once finalized, nothing may
 *  resurrect this state. */
interface RunProjectionState {
  readonly baselinePromise: Promise<GitWorkspaceSnapshot | null>;
  readonly bufferedEvents: LoopEvent[];
  finalized: boolean;
}

interface ObservedChangeAccumulator {
  path: string;
  kind: CodeFileChangeKind;
  additions: number;
  deletions: number;
  statsKnown: boolean;
}

function countTextLines(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const newlines = value.match(/\n/g)?.length ?? 0;
  return newlines + (value.endsWith('\n') ? 0 : 1);
}

function observedRelativePath(root: string, rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return null;
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = rawPath.trim().replace(/\\/g, '/');
  let relative = normalizedPath;
  const rootPrefix = `${normalizedRoot}/`;
  if (normalizedPath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    relative = normalizedPath.slice(rootPrefix.length);
  } else if (/^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('/')) {
    return null;
  }
  relative = relative.replace(/^\.\//, '');
  if (!relative || relative === '..' || relative.startsWith('../') || relative.includes('/../')) {
    return null;
  }
  return relative;
}

/** Tool observations keep Code's review surface alive in ordinary folders
 * and unborn repositories. Git remains authoritative whenever it can supply
 * a real baseline/final delta. */
function collectObservedChanges(
  events: readonly LoopEvent[],
  projectRoot: string,
): readonly StoredCodeChange[] {
  const byPath = new Map<string, ObservedChangeAccumulator>();
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const tool = event.tool.toLowerCase();
    if (tool !== 'edit' && tool !== 'write' && tool !== 'notebookedit') continue;
    const path = observedRelativePath(
      projectRoot,
      event.input['file_path'] ?? event.input['path'] ?? event.input['notebook_path'],
    );
    if (!path) continue;
    const existing = byPath.get(path) ?? {
      path,
      kind: tool === 'write' ? 'added' : 'modified',
      additions: 0,
      deletions: 0,
      statsKnown: false,
    };
    if (tool === 'edit') {
      existing.additions += countTextLines(event.input['new_string']);
      existing.deletions += countTextLines(event.input['old_string']);
      existing.statsKnown = typeof event.input['new_string'] === 'string'
        || typeof event.input['old_string'] === 'string';
    } else if (tool === 'write') {
      existing.additions = Math.max(existing.additions, countTextLines(event.input['content']));
      existing.statsKnown = typeof event.input['content'] === 'string';
    }
    byPath.set(path, existing);
  }
  return [...byPath.values()].slice(0, BOUNDS.codeChanges).map((change) => ({
    path: change.path,
    kind: change.kind,
    staged: false,
    unstaged: true,
    untracked: change.kind === 'added',
    ...(change.statsKnown ? { additions: change.additions, deletions: change.deletions } : {}),
  }));
}

function snapshotKey(scope: RuntimeResultScope): string {
  return resultScopeKey(scope);
}

/** Run a git snapshot with a bounded budget. Resolves null on failure /
 *  timeout so result collection can degrade without throwing. */
async function boundedSnapshot(
  git: GitService,
  root: string,
  budgetMs: number,
): Promise<GitWorkspaceSnapshot | null> {
  try {
    return await Promise.race([
      git.snapshot(root),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/** WP-4: fetch batched diff stats within a bounded budget. Resolves `null`
 *  on failure/timeout so stats can simply be omitted; per-path unknowns are
 *  handled by the caller against `statsComplete`. */
async function boundedDiffStats(
  git: GitService,
  root: string,
  paths: readonly string[],
  budgetMs: number,
): Promise<readonly GitDiffStat[] | null> {
  if (!git.diffStats || paths.length === 0) return null;
  try {
    return await Promise.race([
      git.diffStats(root, paths),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/** Map porcelain X/Y status characters to a StoredCodeChange kind. */
function changeKind(
  indexStatus: string,
  worktreeStatus: string,
  untracked: boolean,
): CodeFileChangeKind {
  if (untracked) return 'added';
  const x = indexStatus.trim();
  const y = worktreeStatus.trim();
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'T' || y === 'T') return 'type_changed';
  if (x === 'U' || y === 'U') return 'unmerged';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'M' || y === 'M') return 'modified';
  return 'unknown';
}

function toStoredChange(entry: GitSnapshotEntry): StoredCodeChange {
  const untracked = entry.indexStatus === '?' && entry.worktreeStatus === '?';
  return {
    path: entry.path,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    kind: changeKind(entry.indexStatus, entry.worktreeStatus, untracked),
    staged: entry.indexStatus.trim() !== '' && entry.indexStatus !== '?',
    unstaged: entry.worktreeStatus.trim() !== '' && entry.worktreeStatus !== '?',
    untracked,
  };
}

function fingerprint(entry: GitSnapshotEntry): string {
  return [
    entry.path,
    entry.oldPath ?? '',
    entry.indexStatus,
    entry.worktreeStatus,
    entry.worktreeOid ?? '',
    entry.indexOid ?? '',
    entry.missing ? '1' : '0',
  ].join('\u0000');
}

/** The run-observed delta (spec §7.4). A pre-dirty file whose fingerprint is
 *  unchanged is NOT a run change; one whose fingerprint differs IS. */
export function computeRunDelta(
  baseline: GitWorkspaceSnapshot | null,
  final: GitWorkspaceSnapshot,
): { changes: readonly StoredCodeChange[]; attribution: CodeAttribution; headChanged: boolean } {
  if (final.repository === false) {
    return { changes: [], attribution: 'unavailable', headChanged: false };
  }
  if (!baseline || baseline.repository === false) {
    // No reliable start state — show the current workspace state, not a
    // run attribution (spec §3.3 wording).
    return {
      changes: final.entries.map(toStoredChange),
      attribution: 'workspace_only',
      headChanged: false,
    };
  }
  const headChanged = baseline.head !== undefined
    && final.head !== undefined
    && baseline.head !== final.head;
  const baselineByPath = new Map<string, string>();
  for (const e of baseline.entries) baselineByPath.set(e.path, fingerprint(e));

  const changes: StoredCodeChange[] = [];
  for (const e of final.entries) {
    const prior = baselineByPath.get(e.path);
    const fp = fingerprint(e);
    if (prior === undefined || prior !== fp) {
      changes.push(toStoredChange(e));
    }
  }
  return {
    changes,
    // Spec §7.5: a moved HEAD means the baseline is no longer comparable, so
    // never label an incomplete cross-baseline diff as "this run's changes".
    attribution: headChanged ? 'workspace_only' : 'run_delta',
    headChanged,
  };
}

export class CodeResultProjector implements CodeRunLifecycleObserver {
  private readonly git: GitService;
  private readonly store: CodeResultStore;
  private readonly now: () => number;
  private readonly baselineBudgetMs: number;
  private readonly finalBudgetMs: number;
  private readonly statsBudgetMs: number;
  /** Live per-run projection lifecycle states, keyed by resultScopeKey. */
  private readonly runs = new Map<string, RunProjectionState>();
  /** Run keys already finalized. Outlives the run state itself so a
   *  duplicate terminal or a late `onRunStarted` for the SAME runId can
   *  never resurrect a baseline/buffer. Keys always contain the runId, so
   *  one run's entry can never shadow another run. */
  private readonly finalized = new Set<string>();

  constructor(options: CodeResultProjectorOptions) {
    this.git = options.git ?? hostAdapter.git;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.baselineBudgetMs = options.baselineBudgetMs ?? BASELINE_BUDGET_MS;
    this.finalBudgetMs = options.finalBudgetMs ?? FINAL_BUDGET_MS;
    this.statsBudgetMs = options.statsBudgetMs ?? STATS_BUDGET_MS;
  }

  /** Reset per-conversation state (e.g. on workspace teardown). */
  clearConversation(projectKey: string, conversationId: string): void {
    const prefix = `${projectKey}/${conversationId}/`;
    for (const key of [...this.runs.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const state = this.runs.get(key);
      if (state) state.finalized = true; // an in-flight baseline must not resurrect it
      this.runs.delete(key);
    }
    for (const key of [...this.finalized]) {
      if (key.startsWith(prefix)) this.finalized.delete(key);
    }
  }

  /** Establishes the run state SYNCHRONOUSLY (audit P1-1): the event buffer
   *  exists before the first real event can arrive, while the Git baseline
   *  snapshot runs asynchronously behind the state's shared baselinePromise.
   *  Idempotent; a late start for an already-finalized run is a no-op. */
  onRunStarted(scope: RuntimeResultScope): void {
    const key = snapshotKey(scope);
    if (this.runs.has(key) || this.finalized.has(key)) return;
    const state: RunProjectionState = {
      // Bounded and never-rejecting: the terminal awaits this SAME promise,
      // so a slow/failed snapshot degrades the projection, never finalize.
      baselinePromise: boundedSnapshot(this.git, scope.projectRoot, this.baselineBudgetMs),
      bufferedEvents: [],
      finalized: false,
    };
    this.runs.set(key, state);
  }

  onEvents(scope: RuntimeResultScope, events: readonly LoopEvent[]): void {
    const state = this.runs.get(snapshotKey(scope));
    // Only onRunStarted creates a buffer: events for a run that never
    // started (or already finalized) are dropped, never resurrecting state.
    if (!state || state.finalized) return;
    state.bufferedEvents.push(...events);
  }

  async onRunTerminal(scope: RuntimeResultScope, outcome: CodeRunOutcome): Promise<void> {
    const key = snapshotKey(scope);
    // Exactly-once per runId: duplicate terminals are side-effect-free.
    if (this.finalized.has(key)) return;
    this.finalized.add(key);

    const state = this.runs.get(key);
    // Cleanup happens BEFORE any await: a late baseline resolve or late
    // event can no longer resurrect state, and a successive run of the same
    // conversation can never read a stale baseline / event buffer.
    this.runs.delete(key);
    if (state) state.finalized = true;

    // Terminal shares the start's baseline promise — bounded and
    // never-rejecting, so terminal-before-baseline waits (within budget)
    // for the real baseline instead of finalizing against an empty one, and
    // a snapshot reject/timeout never blocks finalize (audit P1-1).
    const baseline = state ? await state.baselinePromise : null;
    const events = state ? state.bufferedEvents : [];

    const final = await boundedSnapshot(this.git, scope.projectRoot, this.finalBudgetMs);

    const checks = classifyCodeChecks(events, { runId: scope.runId });
    const observedChanges = collectObservedChanges(events, scope.projectRoot);
    let changes: readonly StoredCodeChange[] = [];
    let attribution: CodeAttribution = 'unavailable';
    let headChanged = false;
    let truncated = false;
    let warning: string | undefined;

    if (final) {
      const delta = computeRunDelta(baseline, final);
      changes = delta.changes;
      attribution = delta.attribution;
      headChanged = delta.headChanged;
      truncated = final.truncated;
      if (final.timedOut) {
        // C-Core (audit P1-5): a budget-exhausted snapshot is explicitly
        // partial — treat it like truncation, never claim a complete delta.
        truncated = true;
        warning = 'The Git snapshot exceeded its operation budget; change attribution is partial.';
      }
      if (headChanged) {
        warning = 'The repository baseline changed during this run.';
      }
    } else if (baseline !== null) {
      // We have a baseline but the terminal snapshot failed.
      attribution = 'workspace_only';
      warning = 'The terminal Git snapshot failed; showing last observed state.';
    }

    if ((final === null || final.repository === false || changes.length === 0)
      && observedChanges.length > 0) {
      changes = observedChanges;
      attribution = 'workspace_only';
      warning = final?.repository === false
        ? 'This folder is not a Git repository; showing changes observed from Code operations.'
        : warning ?? 'Git attribution was unavailable; showing changes observed from Code operations.';
    }

    const projectionIncomplete =
      final === null
      || final.repository === false
      || baseline === null
      || baseline.repository === false
      || truncated
      || headChanged;

    // M1 (spec §7.5): a truncated snapshot (dirty records > 2000) cannot
    // guarantee a complete baseline↔final comparison — never claim an
    // incomplete diff is "this run's changes". A timed-out snapshot (C-Core)
    // is folded into `truncated` above and degrades the same way.
    if (truncated) attribution = 'workspace_only';

    // status reflects the runtime outcome unless the projection degraded a
    // completed run (spec §6.1).
    const status: StoredCodeRunResult['meta']['status'] =
      outcome === 'completed' && projectionIncomplete
        ? 'degraded'
        : mapOutcomeStatus(outcome);

    // WP-4: fetch batched HEAD -> worktree line stats for the retained
    // changed paths. Bounded and best-effort — a timeout / failure here only
    // leaves `statsComplete` false (the UI then shows `—`), never blocks or
    // fails finalize.
    const stats = await boundedDiffStats(
      this.git,
      scope.projectRoot,
      changes.map((c) => c.path),
      this.statsBudgetMs,
    );
    const statByPath = new Map<string, GitDiffStat>();
    for (const stat of stats ?? []) statByPath.set(stat.path, stat);
    let statsComplete = true;
    const stattedChanges: StoredCodeChange[] = changes.map((c) => {
      const stat = statByPath.get(c.path);
      if (!stat) {
        if (c.additions === undefined || c.deletions === undefined) statsComplete = false;
        return c;
      }
      if (stat.binary) return { ...c, binary: true };
      if (stat.additions !== undefined && stat.deletions !== undefined) {
        return { ...c, additions: stat.additions, deletions: stat.deletions };
      }
      if (c.additions === undefined || c.deletions === undefined) statsComplete = false;
      return c;
    });
    const additionsTotal = statsComplete && stattedChanges.length > 0
      ? stattedChanges.reduce((sum, c) => sum + (c.additions ?? 0), 0)
      : undefined;
    const deletionsTotal = statsComplete && stattedChanges.length > 0
      ? stattedChanges.reduce((sum, c) => sum + (c.deletions ?? 0), 0)
      : undefined;

    const result: StoredCodeRunResult = {
      meta: {
        runId: scope.runId,
        turnId: scope.turnId,
        startedAt: scope.startedAt,
        finishedAt: this.now(),
        status,
        ...(warning ? { warning } : {}),
      },
      attribution,
      changes: stattedChanges,
      checks,
      changeCountTotal: changes.length,
      checkCountTotal: checks.length,
      truncated: truncated || changes.length > BOUNDS.codeChanges || checks.length > BOUNDS.codeChecks,
      ...(additionsTotal !== undefined ? { additionsTotal } : {}),
      ...(deletionsTotal !== undefined ? { deletionsTotal } : {}),
      ...(changes.length > 0 ? { statsComplete } : {}),
    };

    this.store.update(scope.projectKey, scope.projectRoot, scope.conversationId, result);
  }

  /** Reset per-run state when a conversation's controller is disposed. */
  disposeConversation(projectKey: string, conversationId: string): void {
    this.clearConversation(projectKey, conversationId);
  }
}

function mapOutcomeStatus(outcome: CodeRunOutcome): StoredCodeRunResult['meta']['status'] {
  switch (outcome) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'exited': return 'failed';
    default: return 'degraded';
  }
}
