// Trylo Desktop — WorkResultProjector (P2-1, spec §5.1 / §8).
//
// The Desktop-side orchestration for the Work result pipeline. It is driven
// by the Work runtime lifecycle (spec §8.2): it captures the `.trylo/out`
// baseline before the daemon begins, routes accepted artifact items into the
// scoped `WorkArtifactStore`, and at terminal runs a recursive scan, then
// finalises the run (exactly once per runId) and maps the store snapshot into
// Desktop's `StoredWorkResult` for persistence via the injected `port`.
//
// It holds no React, no Tauri import and no raw frame parsing. The version /
// change / merge semantics live in the Work-side scoped store, which this
// projector drives and maps.

import {
  WorkArtifactStore,
  type WorkArtifactScope,
  type WorkRunOutcome,
  type WorkResult,
} from '@trylo/work';
import { workspaceKey } from '../host-adapter/conversation-history';
import {
  attachVerifications,
  hasFailedVerification,
  type ToolingOfficeArtifactValidation,
} from '../tooling/office-validation';
import { type WorkScanOutcome, scanWorkOutput } from './work-artifact-scanner';
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
  readonly store?: WorkArtifactStore;
  readonly port: WorkResultStorePort;
  readonly now?: () => number;
  /** PR-5 (§11): injectable validation pipeline. Absent → no verdict is
   *  ever attached (the pre-PR-5 behaviour). */
  readonly verify?: OfficeVerifyFn;
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

// ── Desktop ⇄ Work-domain mapping (spec §8.1: lossless, no work → desktop
//    dependency). The shapes are structurally identical; the mappers exist so
//    the two sides never have to agree on every field by accident. ──────────

function mapWorkToStored(work: WorkResult): StoredWorkResult {
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

function mapRunDelta(delta: WorkResult['latestRun']): StoredWorkRunDelta {
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

function mapStoredToWork(stored: StoredWorkResult): WorkResult {
  return {
    ...(stored.latestRun ? { latestRun: stored.latestRun } : {}),
    artifacts: stored.artifacts,
    artifactCountTotal: stored.artifactCountTotal,
    truncated: stored.truncated,
  };
}

export class WorkResultProjector {
  /** The scoped store owned by this app instance (spec §8.1). */
  readonly artifactStore: WorkArtifactStore;
  private readonly scanImpl: WorkScanFn;
  private readonly port: WorkResultStorePort;
  /** PR-5 (§11): the validation pipeline, when one is wired in. */
  private readonly verifyImpl: OfficeVerifyFn | null;
  /** C-Core generation guard: bumped by clearConversation / clearProject so
   *  a background verification can never write a verdict back into a deleted
   *  conversation (the repository would silently resurrect the entry). */
  private generation = 0;
  /** conversationKey -> runIds whose baseline was captured; a bounded FIFO
   *  (C-Core) so long-lived projects do not grow this set without limit.
   *  Exactly-once TERMINAL ownership lives in the store itself — the
   *  projector consults `runTerminalState` instead of keeping a parallel
   *  finalized set. */
  private readonly startedRuns = new Map<string, string[]>();

  constructor(options: WorkResultProjectorOptions) {
    this.artifactStore = options.store ?? new WorkArtifactStore();
    this.scanImpl = options.scan ?? ((root) => scanWorkOutput(root));
    this.port = options.port;
    this.verifyImpl = options.verify ?? null;
  }

  /** Returns true the first time this run's start is seen (marks it). */
  private markStarted(scope: WorkArtifactScope): boolean {
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
  ): WorkScanOutcome | null {
    if (!scan || scan.artifacts.length === 0) return scan;
    const known = new Set(
      this.artifactStore
        .snapshot(projectKey, conversationId)
        .artifacts.map((a) => a.id),
    );
    if (known.size === 0) {
      // No ownership evidence yet: a crash-recovered run or a first scan-less
      // run cannot prove which shared `.trylo/out` files are its own. Prefer
      // recovery (let the scan corroborate) rather than dropping everything —
      // a hard drop here would silently lose products after an app crash.
      return scan;
    }
    const kept = scan.artifacts.filter((a) => known.has(a.id));
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
  async onRunStarted(scope: WorkArtifactScope): Promise<void> {
    if (!this.markStarted(scope)) return;
    const baseline = await boundedScan(this.scanImpl, scope.projectRoot, BASELINE_BUDGET_MS);
    this.artifactStore.beginRun(scope, this.scopeScan(scope.projectKey, scope.conversationId, baseline)?.artifacts ?? null);
  }

  /** One accepted artifact item during a run (spec §8.2). */
  onArtifact(
    scope: WorkArtifactScope,
    rawPath: string,
    artifactKind?: string,
    at?: number,
  ): void {
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
  async onRunTerminal(scope: WorkArtifactScope, outcome: WorkRunOutcome): Promise<void> {
    const storeState = this.artifactStore.runTerminalState(
      scope.projectKey,
      scope.conversationId,
      scope.runId,
    );
    if (storeState === 'finished') return;

    const scan = await boundedScan(this.scanImpl, scope.projectRoot, FINAL_BUDGET_MS);
    const scopedScan = this.scopeScan(scope.projectKey, scope.conversationId, scan);
    const workResult: WorkResult = scopedScan
      ? this.artifactStore.finishRun(scope, { artifacts: scopedScan.artifacts, truncated: scopedScan.truncated }, outcome)
      : this.artifactStore.failRun(scope, 'Artifact scan was incomplete.');

    const stored = mapWorkToStored(workResult);
    const projectKey = scope.projectKey || projectKeyOf(scope.projectRoot);
    this.port.update(projectKey, scope.projectRoot, scope.conversationId, stored);

    if (this.verifyImpl) {
      // The generation is captured HERE, on the terminal path — not inside
      // the async verification, which resumes later (after any user-driven
      // deletion could have already bumped it).
      void this.verifyRunArtifacts(scope, projectKey, stored, this.generation);
    }
  }

  /** PR-5 (§11): validate the run's file deliverables and fold the verdicts
   *  back into the persisted snapshot. Fire-and-forget with a generation
   *  guard: a deleted conversation or a closed project must never receive a
   *  late write (the repository update would resurrect the entry). */
  private async verifyRunArtifacts(
    scope: WorkArtifactScope,
    projectKey: string,
    stored: StoredWorkResult,
    generation: number,
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
    if (this.generation !== generation) return;
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
    this.generation += 1;
    this.artifactStore.clearConversation(projectKey, conversationId);
    this.pruneStarted('', `${projectKey}::${conversationId}`);
  }

  /** Drop a project's projection on workspace close / switch (spec §8.1). */
  clearProject(projectKey: string): void {
    this.generation += 1;
    this.artifactStore.clearProject(projectKey);
    this.pruneStarted(`${projectKey}::`);
  }
}

/** §11: a bounded, non-sensitive degradation reason (no paths, no content). */
const VERIFICATION_FAILED_WARNING = '交付物验证未通过：请检查 ResultDock 中的验证状态。';

export type { StoredWorkResult };
export { mapStoredToWork };