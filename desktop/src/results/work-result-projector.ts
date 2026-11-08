// Trylo Desktop — WorkResultProjector (P2-1, spec §5.1 / §8).
//
// The Desktop-side orchestration for Work-surface results. The shared CLI
// run lifecycle captures the `.trylo/out`
// baseline before execution begins, routes accepted artifact items into the
// scoped `ArtifactStore`, and at terminal runs a recursive scan, then
// finalises the run (exactly once per runId) and maps the store snapshot into
// Desktop's `StoredWorkResult` for persistence via the injected `port`.
//
// It holds no React, no Tauri import and no raw frame parsing. The version /
// change / merge semantics live in the result owner's scoped store, which this
// projector drives and maps.

import { ArtifactStore } from './artifact-store';
import type { ArtifactRunScope, ArtifactRunOutcome, ArtifactResult } from './artifact-types';
import { workspaceKey } from '../host-adapter/conversation-history';
import {
  attachVerifications,
  hasFailedVerification,
  type ToolingOfficeArtifactValidation,
} from '../tooling/office-validation';
import { type WorkScanOutcome, scanWorkOutput } from './work-artifact-scanner';
import { artifactFromStat } from './work-artifact-scanner';
import { boundedOutputSnapshot, snapshotOutputFiles, type OutputSnapshot, type OutputSnapshotFn } from './output-files/snapshot';
import { outputFileDelta } from './output-files/delta';
import { OutputRunOwnership } from './output-files/ownership';
import { createDesktopOutputWatch, mergeOutputEvidence, type OutputWatch, type OutputWatchFactory } from './output-files/watch';
import type {
  StoredWorkArtifact,
  StoredWorkResult,
  StoredWorkRunDelta,
} from './conversation-result-types';

/** Port through which the projector writes normalised Work results. The host
 *  (App) adapts this to ConversationResultRepository.update + the per-
 *  workspace history save chain (spec §13.3). */
export interface WorkResultStorePort {
  update(
    projectKey: string,
    projectRoot: string,
    conversationId: string,
    work: StoredWorkResult | undefined,
  ): void;
}

export interface WorkScanFn {
  (projectRoot: string): Promise<WorkScanOutcome | null>;
}

/** PR-5 (§11): the deterministic Office delivery validation pipeline. Given
 *  a project root and the run's file artifacts, returns the per-artifact
 *  verdicts — or `null` when the pipeline could not answer (transport
 *  failure). A `null` is NO VERDICT, never a pass (§4.4). */
export type OfficeVerifyFn = (
  projectRoot: string,
  artifacts: readonly { readonly id: string; readonly relativePath: string }[],
) => Promise<{
  readonly budgetExceeded?: boolean;
  readonly results: readonly ToolingOfficeArtifactValidation[];
} | null>;

export interface WorkResultProjectorOptions {
  /** Injectable for tests; defaults to the real HostAdapter-backed scanner. */
  readonly scan?: WorkScanFn;
  readonly store?: ArtifactStore;
  readonly port: WorkResultStorePort;
  readonly now?: () => number;
  /** PR-5 (§11): injectable validation pipeline. Absent → no verdict is
   *  ever attached (the pre-PR-5 behaviour). */
  readonly verify?: OfficeVerifyFn;
  readonly outputSnapshot?: OutputSnapshotFn;
  readonly outputOwnership?: OutputRunOwnership;
  readonly outputWatch?: OutputWatchFactory;
}

/** Baseline budget (spec §14): a slow snapshot never blocks the run start. */
const BASELINE_BUDGET_MS = 1500;
const FINAL_BUDGET_MS = 3000;

/** C-Core: per-conversation cap on start-bookkeeping. Evicted entries only
 *  guard against duplicate baseline capture for long-dead runs — eviction
 *  can therefore never corrupt an active run. */
const MAX_TRACKED_STARTED_RUNS = 64;

function projectKeyOf(projectRoot: string): string {
  return workspaceKey(projectRoot);
}

async function boundedScan(
  scan: WorkScanFn,
  projectRoot: string,
  budgetMs: number,
): Promise<WorkScanOutcome | null> {
  try {
    return await Promise.race([
      scan(projectRoot),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
  } catch {
    return null;
  }
}

// The existing persisted format represents absent turn IDs with empty strings;
// the in-memory result owner keeps those identities absent until serialization.

function mapWorkToStored(work: ArtifactResult): StoredWorkResult {
  return {
    ...(work.latestRun ? { latestRun: mapRunDelta(work.latestRun) } : {}),
    artifacts: work.artifacts.map((a): StoredWorkArtifact => ({
      id: a.id,
      target: a.target,
      displayName: a.displayName,
      artifactKind: a.artifactKind,
      version: a.version,
      firstSeenAt: a.firstSeenAt,
      updatedAt: a.updatedAt,
      firstRunId: a.firstRunId,
      lastRunId: a.lastRunId,
      lastTurnId: a.lastTurnId ?? '',
      lastChange: a.lastChange,
      sources: a.sources,
      ...(a.signature ? { signature: a.signature } : {}),
    })),
    artifactCountTotal: work.artifactCountTotal,
    truncated: work.truncated,
  };
}

function mapRunDelta(delta: ArtifactResult['latestRun']): StoredWorkRunDelta {
  if (!delta) return undefined as unknown as StoredWorkRunDelta;
  return {
    runId: delta.runId,
    turnId: delta.turnId ?? '',
    startedAt: delta.startedAt,
    ...(delta.finishedAt !== undefined ? { finishedAt: delta.finishedAt } : {}),
    status: delta.status,
    ...(delta.warning ? { warning: delta.warning } : {}),
    createdIds: delta.createdIds,
    updatedIds: delta.updatedIds,
    discoveredIds: delta.discoveredIds,
  };
}

function mapStoredToWork(stored: StoredWorkResult): ArtifactResult {
  return {
    ...(stored.latestRun ? { latestRun: stored.latestRun } : {}),
    artifacts: stored.artifacts,
    artifactCountTotal: stored.artifactCountTotal,
    truncated: stored.truncated,
  };
}

export class WorkResultProjector {
  /** The scoped store owned by this app instance (spec §8.1). */
  readonly artifactStore: ArtifactStore;
  private readonly scanImpl: WorkScanFn;
  private readonly port: WorkResultStorePort;
  /** PR-5 (§11): the validation pipeline, when one is wired in. */
  private readonly verifyImpl: OfficeVerifyFn | null;
  /** C-Core generation guard: bumped by clearConversation / clearProject so
   *  a background verification can never write a verdict back into a deleted
   *  conversation (the repository would silently resurrect the entry). */
  private readonly projectGenerations = new Map<string, number>();
  private readonly conversationGenerations = new Map<string, number>();
  /** conversationKey -> runIds whose baseline was captured; a bounded FIFO
   *  (C-Core) so long-lived projects do not grow this set without limit.
   *  Exactly-once TERMINAL ownership lives in the store itself — the
   *  projector consults `runTerminalState` instead of keeping a parallel
   *  finalized set. */
  private readonly startedRuns = new Map<string, string[]>();
  private readonly outputSnapshot: OutputSnapshotFn;
  private readonly outputOwnership: OutputRunOwnership;
  private readonly outputBaselines = new Map<string, { output: OutputSnapshot | null; out: WorkScanOutcome | null; exclusive?: boolean; endedAt?: number }>();
  private readonly outputWatch: OutputWatchFactory;
  private readonly watches = new Map<string, OutputWatch>();
  private readonly clearedConversations = new Set<string>();
  private readonly startingRuns = new Map<string, Promise<void>>();
  private readonly finalizingRuns = new Map<string, Promise<void>>();

  private epoch(scope: Pick<ArtifactRunScope, 'projectKey' | 'conversationId'>): string {
    return `${this.projectGenerations.get(scope.projectKey) ?? 0}/${this.conversationGenerations.get(`${scope.projectKey}/${scope.conversationId}`) ?? 0}`;
  }

  constructor(options: WorkResultProjectorOptions) {
    this.artifactStore = options.store ?? new ArtifactStore();
    this.scanImpl = options.scan ?? ((root) => scanWorkOutput(root));
    this.port = options.port;
    this.verifyImpl = options.verify ?? null;
    this.outputSnapshot = options.outputSnapshot ?? snapshotOutputFiles;
    this.outputOwnership = options.outputOwnership ?? new OutputRunOwnership();
    this.outputWatch = options.outputWatch ?? createDesktopOutputWatch;
  }

  /** Returns true the first time this run's start is seen (marks it). */
  private markStarted(scope: ArtifactRunScope): boolean {
    const convo = `${scope.projectKey}::${scope.conversationId}`;
    const list = this.startedRuns.get(convo) ?? [];
    if (list.includes(scope.runId)) return false;
    list.push(scope.runId);
    while (list.length > MAX_TRACKED_STARTED_RUNS) list.shift();
    this.startedRuns.set(convo, list);
    return true;
  }

  private pruneStarted(projectPrefix: string, exact?: string): void {
    for (const key of [...this.startedRuns.keys()]) {
      if (exact !== undefined ? key === exact : key.startsWith(projectPrefix)) {
        this.startedRuns.delete(key);
      }
    }
  }

  /**
   * Scope a whole-project `.trylo/out` scan down to the CURRENT conversation's
   * artifacts (spec §8.3 isolation fix, 2026-09-03).
   *
   * The terminal scan covers every file in `.trylo/out`, which is a shared
   * per-project directory — all conversations dump deliverables there. Ingestion
   * of every scanned file into one conversation's store is exactly the
   * cross-conversation "串台" the user hit: conversation A's dock shows files
   * created by B. The EVENT path is conversation-scoped and authoritative; the
   * scan only corroborates signature / change semantics. So a scanned artifact
   * is attributed to this conversation only when the conversation's OWN store
   * already knows it (put there by its own evented runs / hydrated history).
   * Foreign scan-only files are dropped here, before they can enter the store.
   */
  private scopeScan(
    projectKey: string,
    conversationId: string,
    scan: WorkScanOutcome | null,
    observed: ReadonlySet<string> = new Set(),
  ): WorkScanOutcome | null {
    if (!scan || scan.artifacts.length === 0) return scan;
    const known = new Set(
      this.artifactStore
        .snapshot(projectKey, conversationId)
        .artifacts.map((a) => a.id),
    );
    const kept = scan.artifacts.filter((a) => known.has(a.id) || observed.has(a.id));
    if (kept.length === scan.artifacts.length) return scan;
    return { artifacts: kept, truncated: scan.truncated, ...(scan.warning ? { warning: scan.warning } : {}) };
  }

  /** Load persisted results for a conversation so a fresh run can compare
   *  against them (spec §8.2 recovery). */
  hydrate(
    projectKey: string,
    conversationId: string,
    stored: StoredWorkResult | undefined,
  ): void {
    this.artifactStore.hydrate(
      `${projectKey}::${conversationId}`,
      stored ? mapStoredToWork(stored) : undefined,
    );
  }

  /** Run-start baseline (spec §8.2). Awaited before the daemon begins, but
   *  bounded: null baseline degrades to `discovered`, never blocks the run. */
  onRunStarted(scope: ArtifactRunScope): Promise<void> {
    if (this.artifactStore.runTerminalState(scope.projectKey, scope.conversationId, scope.runId) === 'finished') return Promise.resolve();
    const key = outputScopeKey(scope);
    const existing = this.startingRuns.get(key);
    if (existing) return existing;
    const pending = this.captureStart(scope);
    this.startingRuns.set(key, pending);
    return pending;
  }

  private async captureStart(scope: ArtifactRunScope): Promise<void> {
    if (!this.markStarted(scope)) return;
    this.clearedConversations.delete(`${scope.projectKey}/${scope.conversationId}`);
    const key = outputScopeKey(scope);
    const generation = this.epoch(scope);
    this.outputOwnership.begin(key, scope);
    let watch: OutputWatch | undefined;
    try { watch = this.outputWatch(scope.projectRoot); } catch { /* Keep bounded snapshots as fallback. */ }
    if (watch) this.watches.set(key, watch);
    const [baseline, output] = await Promise.all([
      boundedScan(this.scanImpl, scope.projectRoot, BASELINE_BUDGET_MS),
      boundedOutputSnapshot(this.outputSnapshot, scope.projectRoot, BASELINE_BUDGET_MS),
      watch?.ready,
    ]);
    if (generation !== this.epoch(scope)) return;
    this.outputBaselines.set(key, { output, out: baseline });
    const combined = combineScan(baseline, output, scope.projectRoot);
    this.artifactStore.beginRun(scope, combined && !combined.truncated && !combined.warning ? combined.artifacts : null);
  }

  /** One accepted artifact item during a run (spec §8.2). */
  onArtifact(
    scope: ArtifactRunScope,
    rawPath: string,
    artifactKind?: string,
    at?: number,
  ): void {
    if (this.clearedConversations.has(`${scope.projectKey}/${scope.conversationId}`)) return;
    this.artifactStore.upsertEvent(scope, {
      rawPath,
      artifactKind,
      at: at ?? scope.startedAt,
      runId: scope.runId,
      turnId: scope.turnId,
    });
  }

  /** Terminal finalise. Exactly-once semantics live in the store's state
   *  machine (C-Core): an IMMUTABLE `finished` run is skipped without
   *  re-scanning or re-writing; a `degraded` run falls through as the
   *  authoritative correction (re-scan, recompute, re-persist).
   *
   *  PR-5 (§11): the scan result is persisted FIRST (the dock appears with
   *  the run), then the delivery validation runs as a bounded background
   *  step and updates the verdicts in place. A failed verdict degrades the
   *  run to `degraded` (§11) — it never rewrites the agent's answer. */
  onRunTerminal(scope: ArtifactRunScope, outcome: ArtifactRunOutcome): Promise<void> {
    const key = outputScopeKey(scope);
    const existing = this.finalizingRuns.get(key);
    if (existing) return existing;
    const pending = this.finalizeRun(scope, outcome);
    this.finalizingRuns.set(key, pending);
    const clear = (): void => { if (this.finalizingRuns.get(key) === pending) this.finalizingRuns.delete(key); };
    void pending.then(clear, clear);
    return pending;
  }

  private async finalizeRun(scope: ArtifactRunScope, outcome: ArtifactRunOutcome): Promise<void> {
    if (this.clearedConversations.has(`${scope.projectKey}/${scope.conversationId}`)) return;
    const generation = this.epoch(scope);
    const key = outputScopeKey(scope);
    await this.startingRuns.get(key);
    if (generation !== this.epoch(scope)) return;
    const storeState = this.artifactStore.runTerminalState(
      scope.projectKey,
      scope.conversationId,
      scope.runId,
    );
    if (storeState === 'finished') return;
    const baseline = this.outputBaselines.get(key);
    const [scan, output, watched] = await Promise.all([
      boundedScan(this.scanImpl, scope.projectRoot, FINAL_BUDGET_MS),
      boundedOutputSnapshot(this.outputSnapshot, scope.projectRoot, FINAL_BUDGET_MS),
      this.watches.get(key)?.finish(),
    ]);
    this.watches.delete(key);
    if (generation !== this.epoch(scope)) return;
    const exclusive = baseline?.exclusive ?? this.outputOwnership.finish(key);
    if (baseline) { baseline.exclusive = exclusive; baseline.endedAt ??= Date.now(); }
    const observed = mergeOutputEvidence(outputFileDelta(scanAsSnapshot(combineScan(baseline?.out ?? null, baseline?.output ?? null, scope.projectRoot)), scanAsSnapshot(combineScan(scan, output, scope.projectRoot))), watched);
    const observedIds = new Set(exclusive ? observed.files.filter((file) => !baseline?.endedAt || file.signature.modifiedMs <= baseline.endedAt).map((file) => file.path) : []);
    const combined = combineScan(combineScan(scan, output, scope.projectRoot), watched ? { files: watched.files.map((file) => ({ path: file.path, signature: file.signature })), incomplete: watched.incomplete } : null, scope.projectRoot);
    let scopedScan = this.scopeScan(scope.projectKey, scope.conversationId, combined, observedIds);
    if (baseline && scopedScan) {
      const known = new Set(this.artifactStore.snapshot(scope.projectKey, scope.conversationId).artifacts.map((a) => a.id));
      scopedScan = { ...scopedScan, artifacts: scopedScan.artifacts.filter((a) => known.has(a.id) || observedIds.has(a.id)) };
    }
    const workResult: ArtifactResult = scopedScan
      ? this.artifactStore.finishRun(scope, {
        artifacts: scopedScan.artifacts, truncated: watched ? observed.incomplete : scopedScan.truncated,
        ...(exclusive && watched ? { observedChanges: new Map(watched.files.map((file) => [file.path, file.change])) } : {}),
      }, outcome)
      : this.artifactStore.failRun(scope, 'Artifact scan was incomplete.');

    const stored = mapWorkToStored(workResult);
    const projectKey = scope.projectKey || projectKeyOf(scope.projectRoot);
    this.port.update(projectKey, scope.projectRoot, scope.conversationId, stored);
    if (scopedScan) this.outputBaselines.delete(key);
    this.startingRuns.delete(key);

    if (this.verifyImpl) {
      // The generation is captured HERE, on the terminal path — not inside
      // the async verification, which resumes later (after any user-driven
      // deletion could have already bumped it).
      void this.verifyRunArtifacts(scope, projectKey, stored, this.epoch(scope));
    }
  }

  /** PR-5 (§11): validate the run's file deliverables and fold the verdicts
   *  back into the persisted snapshot. Fire-and-forget with a generation
   *  guard: a deleted conversation or a closed project must never receive a
   *  late write (the repository update would resurrect the entry). */
  private async verifyRunArtifacts(
    scope: ArtifactRunScope,
    projectKey: string,
    stored: StoredWorkResult,
    generation: string,
  ): Promise<void> {
    const verify = this.verifyImpl;
    if (!verify) return;
    const latestRun = stored.latestRun;
    if (!latestRun) return;

    // §11: 「对 .trylo/out 新增/变更文件执行格式相关验证」 — the run's delta
    // (created + updated + discovered) is the validation set; untouched
    // historical files were not re-verified this run and keep no verdict.
    const deltaIds = new Set<string>([
      ...latestRun.createdIds,
      ...latestRun.updatedIds,
      ...latestRun.discoveredIds,
    ]);
    const candidates = stored.artifacts
      .filter((artifact) => deltaIds.has(artifact.id) && artifact.target.kind === 'file')
      .map((artifact) => ({
        id: artifact.id,
        relativePath: (artifact.target as { readonly relativePath: string }).relativePath,
      }));
    if (candidates.length === 0) return;

    let verdict;
    try {
      verdict = await verify(scope.projectRoot, candidates);
    } catch {
      verdict = null;
    }
    if (!verdict) return;
    // Liveness guards — a late verdict must never land in a conversation
    // that was deleted or re-run while verification was in flight:
    //   1. the generation counter bumped by clearConversation / clearProject;
    //   2. the store itself is the ground truth — the current snapshot must
    //      still own THIS run (deletion empties it, a newer run replaces it).
    if (this.epoch(scope) !== generation) return;
    const current = this.artifactStore.snapshot(scope.projectKey, scope.conversationId);
    if (!current?.latestRun || current.latestRun.runId !== scope.runId) return;

    const withVerdicts = attachVerifications(stored.artifacts, verdict.results);
    if (withVerdicts === stored.artifacts) return;

    // §11: 验证失败 → run 标记为 degraded（但不改写 Agent 回答；模型可在
    // 同一会话继续修复）。Only a COMPLETED run is demoted — an already
    // failed/cancelled run keeps its own outcome.
    const failed = hasFailedVerification(withVerdicts);
    const latestRunNext: StoredWorkRunDelta | undefined =
      failed && latestRun.status === 'completed'
        ? {
            ...latestRun,
            status: 'degraded',
            warning: VERIFICATION_FAILED_WARNING,
          }
        : latestRun;

    const next: StoredWorkResult = {
      ...(latestRunNext ? { latestRun: latestRunNext } : {}),
      artifacts: withVerdicts,
      artifactCountTotal: stored.artifactCountTotal,
      truncated: stored.truncated || (verdict.budgetExceeded === true),
    };
    this.port.update(projectKey, scope.projectRoot, scope.conversationId, next);
  }

  /** Drop one conversation's projection (conversation deletion, C-Core). */
  clearConversation(projectKey: string, conversationId: string): void {
    const conversationKey = `${projectKey}/${conversationId}`;
    this.conversationGenerations.set(conversationKey, (this.conversationGenerations.get(conversationKey) ?? 0) + 1);
    this.clearedConversations.add(`${projectKey}/${conversationId}`);
    this.artifactStore.clearConversation(projectKey, conversationId);
    this.pruneStarted('', `${projectKey}::${conversationId}`);
    for (const key of this.startingRuns.keys()) if (key.startsWith(`${projectKey}/${conversationId}/`)) this.startingRuns.delete(key);
    this.outputOwnership.clear(projectKey, conversationId);
    for (const [key, watch] of this.watches) if (key.startsWith(`${projectKey}/${conversationId}/`)) { watch.close(); this.watches.delete(key); }
    for (const key of this.outputBaselines.keys()) if (key.startsWith(`${projectKey}/${conversationId}/`)) this.outputBaselines.delete(key);
  }

  /** Drop a project's projection on workspace close / switch (spec §8.1). */
  clearProject(projectKey: string): void {
    this.projectGenerations.set(projectKey, (this.projectGenerations.get(projectKey) ?? 0) + 1);
    for (const key of this.startedRuns.keys()) if (key.startsWith(`${projectKey}::`)) this.clearedConversations.add(`${projectKey}/${key.slice(projectKey.length + 2)}`);
    this.artifactStore.clearProject(projectKey);
    this.pruneStarted(`${projectKey}::`);
    for (const key of this.startingRuns.keys()) if (key.startsWith(`${projectKey}/`)) this.startingRuns.delete(key);
    this.outputOwnership.clear(projectKey);
    for (const [key, watch] of this.watches) if (key.startsWith(`${projectKey}/`)) { watch.close(); this.watches.delete(key); }
    for (const key of this.outputBaselines.keys()) if (key.startsWith(`${projectKey}/`)) this.outputBaselines.delete(key);
  }
}

/** §11: a bounded, non-sensitive degradation reason (no paths, no content). */
const VERIFICATION_FAILED_WARNING = '交付物验证未通过：请检查 ResultDock 中的验证状态。';

function outputScopeKey(scope: ArtifactRunScope): string { return `${scope.projectKey}/${scope.conversationId}/work/${scope.runId}`; }
function combineScan(scan: WorkScanOutcome | null, output: OutputSnapshot | null, root: string): WorkScanOutcome | null {
  if (!scan && !output) return null;
  const files = output?.files.flatMap((file) => {
    const artifact = artifactFromStat({ path: `${root.replace(/[\\/]+$/, '')}/${file.path}`, ...file.signature }, root);
    return artifact ? [artifact] : [];
  }) ?? [];
  return { artifacts: [...new Map([...(scan?.artifacts ?? []), ...files].map((a) => [a.id, a])).values()], truncated: !!scan?.truncated || !!output?.incomplete, ...(scan?.warning ? { warning: scan.warning } : {}) };
}
function scanAsSnapshot(scan: WorkScanOutcome | null): OutputSnapshot | null {
  return scan ? { files: scan.artifacts.flatMap((a) => a.target.kind === 'file' && a.signature ? [{ path: a.id, signature: a.signature }] : []), incomplete: scan.truncated || !!scan.warning } : null;
}

export type { StoredWorkResult };
export { mapStoredToWork };
