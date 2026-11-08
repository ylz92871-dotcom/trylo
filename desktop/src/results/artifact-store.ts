// Conversation-scoped deliverable versions and observed run deltas.
// A finished run is immutable; an incomplete scan may be corrected once.
// This store owns result attribution only, never execution or permissions.

import { artifactKindFrom, orderedSources, signatureOf, targetFromInput } from "./artifact-record";
import type { WorkArtifactChange, WorkArtifactSource } from "./conversation-result-types";
import type { ArtifactRecord, ArtifactRunDelta, ArtifactRunScope, ArtifactUpsert, ArtifactScanResult, ArtifactRunOutcome, ArtifactRunTerminalState, ArtifactResult, ScannedArtifact } from "./artifact-types";
import { isOutputArtifactPath } from './output-files/eligibility';
import { alignWorkRunDelta, eligibleWorkResult } from './work-result-recovery';

const MAX_ARTIFACTS_PER_CONVERSATION = 200;

/** C-Core: per-conversation cap on terminal-run bookkeeping (markers +
 *  baselines). Oldest finalised run evicted first — its marker is
 *  diagnostic-only, never gating an active run. */
const MAX_TRACKED_TERMINAL_RUNS = 64;

function conversationKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`;
}

type ArtifactMap = Map<string, ArtifactRecord>;

export class ArtifactStore {
  /** (projectKey::conversationId) -> targetIdentity -> record */
  private readonly byConversation = new Map<string, ArtifactMap>();
  /** (conversationKey::runId) -> baseline identity -> prior signature */
  private readonly baselines = new Map<string, Map<string, string>>();
  /** (conversationKey::runId) -> terminal state (C-Core state machine).
   *  `finished` is immutable; `degraded` admits one authoritative
   *  finishRun correction. Scoped by conversation so the same runId never
   *  collides across the two conversations that legitimately share it
   *  (runIds are unique in practice, but the store must not depend on
   *  that). Bounded per conversation via `terminalOrder`. */
  private readonly terminalRuns = new Map<string, ArtifactRunTerminalState>();
  /** conversationKey -> run keys in finalisation order; the eviction FIFO
   *  that bounds `terminalRuns` and their baselines. */
  private readonly terminalOrder = new Map<string, string[]>();
  /** conversationKey -> monotonic count of distinct artifact identities
   *  ever observed. Eviction never decreases it, so `artifactCountTotal`
   *  stays honest after bounded cleanup. */
  private readonly observedCounts = new Map<string, number>();
  /** latest run delta per conversation (kept across runs for snapshot). */
  private readonly latestRun = new Map<string, ArtifactRunDelta>();

  private conversation(conversation: string): ArtifactMap {
    let m = this.byConversation.get(conversation);
    if (!m) {
      m = new Map();
      this.byConversation.set(conversation, m);
    }
    return m;
  }

  private baselineKey(conversation: string, runId: string): string {
    return `${conversation}::${runId}`;
  }

  /** Record a terminal state and enforce the per-conversation bound
   *  (C-Core). Eviction drops the oldest marker AND its baseline; a
   *  degraded→finished correction reuses its existing FIFO slot. */
  private recordTerminal(convo: string, runKey: string, state: ArtifactRunTerminalState): void {
    this.terminalRuns.set(runKey, state);
    const order = this.terminalOrder.get(convo) ?? [];
    if (!order.includes(runKey)) {
      order.push(runKey);
      while (order.length > MAX_TRACKED_TERMINAL_RUNS) {
        const oldest = order.shift();
        if (oldest === undefined) break;
        this.terminalRuns.delete(oldest);
        this.baselines.delete(oldest);
      }
      this.terminalOrder.set(convo, order);
    }
  }

  /** Count a NEWLY observed artifact identity (monotonic, survives
   *  eviction). */
  private observe(convo: string): void {
    this.observedCounts.set(convo, (this.observedCounts.get(convo) ?? 0) + 1);
  }

  /** Bound the artifact map (C-Core): evict the oldest-`updatedAt`
   *  records beyond the display cap. The UI shows exactly the newest
   *  MAX_ARTIFACTS_PER_CONVERSATION, so this never removes a currently
   *  visible artifact. */
  private trimConversation(map: ArtifactMap): void {
    if (map.size <= MAX_ARTIFACTS_PER_CONVERSATION) return;
    const overflow = map.size - MAX_ARTIFACTS_PER_CONVERSATION;
    const byOldest = [...map.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of byOldest.slice(0, overflow)) map.delete(record.id);
  }

  /** Load a previously serialised result (spec §8.2 recovery). Rebuilds the
   *  per-conversation artifact set so a fresh run can compare against it. The
   *  persisted shape is a `ArtifactResult` (neutral). */
  hydrate(conversation: string, stored: ArtifactResult | undefined): void {
    if (!stored) return;
    stored = eligibleWorkResult(stored);
    const map = this.conversation(conversation);
    let removed = 0;
    for (const [id, artifact] of map) {
      if (artifact.target.kind === 'file' && !isOutputArtifactPath(artifact.target.relativePath)) {
        map.delete(id);
        removed += 1;
      }
    }
    for (const a of stored.artifacts) {
      map.set(a.id, { ...a, sources: [...a.sources] });
    }
    // Restore the monotonic total (persisted count wins; never go below the
    // number of records actually present).
    this.observedCounts.set(
      conversation,
      Math.max(stored.artifactCountTotal, map.size, (this.observedCounts.get(conversation) ?? 0) - removed),
    );
    if (stored.latestRun) {
      this.latestRun.set(conversation, { ...stored.latestRun, createdIds: [...stored.latestRun.createdIds], updatedIds: [...stored.latestRun.updatedIds], discoveredIds: [...stored.latestRun.discoveredIds] });
    }
  }

  /** Start a run and pin its baseline (spec §8.2). A `null` baseline (scan
   *  failed or not available, e.g. recovery) is handled at finishRun as
   *  `discovered` rather than `created`. */
  beginRun(scope: ArtifactRunScope, baseline: readonly ScannedArtifact[] | null): void {
    const convo = conversationKey(scope.projectKey, scope.conversationId);
    this.conversation(convo); // ensure an empty record map exists
    if (baseline === null) {
      // Failure is unknown, not proof that every final file was newly created.
      this.baselines.delete(this.baselineKey(convo, scope.runId));
      return;
    }
    const map = new Map<string, string>();
    for (const a of baseline ?? []) {
      map.set(a.id, signatureOf(a.signature));
    }
    this.baselines.set(this.baselineKey(convo, scope.runId), map);
  }

  /** One accepted artifact item during a run (source "event", spec §8.2).
   *  Idempotent per identity within a run. */
  upsertEvent(scope: ArtifactRunScope, input: ArtifactUpsert): boolean {
    const resolved = targetFromInput(input.rawPath, scope.projectRoot);
    if (!resolved) return false;
    const convo = conversationKey(scope.projectKey, scope.conversationId);
    const map = this.conversation(convo);
    const id = resolved.target.kind === "file"
      ? resolved.target.relativePath
      : resolved.target.url;
    const existing = map.get(id);
    const artifactKind = artifactKindFrom(input.artifactKind, resolved.target.kind === "file" ? resolved.target.relativePath : undefined);
    const at = input.at || scope.startedAt;
    if (existing) {
      // Same identity seen again. Within a run the version is NOT bumped here —
      // finalisation (finishRun) computes the real cross-run change.
      const sources = orderedSources(existing.sources, "event");
      map.set(existing.id, {
        ...existing,
        sources,
        updatedAt: Math.max(existing.updatedAt, at),
        artifactKind,
        lastRunId: input.runId,
        lastTurnId: input.turnId,
      });
      return true;
    }
    this.observe(convo);
    map.set(id, {
      id,
      target: resolved.target,
      displayName: resolved.displayName,
      artifactKind,
      version: 1,
      firstSeenAt: at,
      updatedAt: at,
      firstRunId: input.runId,
      lastRunId: input.runId,
      lastTurnId: input.turnId,
      lastChange: "created",
      sources: ["event"],
    });
    // C-Core bounded lifecycle: keep the map at the display cap; the
    // newest records survive, the oldest `updatedAt` is evicted.
    this.trimConversation(map);
    return true;
  }

  /** Finalise a run against a terminal scan (spec §8.2 / §8.5; C-Core state
   *  machine). `finished` is immutable — a duplicate terminal is a
   *  deterministic no-op returning the current snapshot. A `degraded` run
   *  admits this call as an authoritative correction: the real cross-run
   *  delta replaces the degraded latestRun. Bumps versions only for a real
   *  cross-run change. */
  finishRun(scope: ArtifactRunScope, scan: ArtifactScanResult | null, outcome: ArtifactRunOutcome = "completed"): ArtifactResult {
    const convo = conversationKey(scope.projectKey, scope.conversationId);
    const runKey = this.baselineKey(convo, scope.runId);
    if (this.terminalRuns.get(runKey) === "finished") {
      // IMMUTABLE terminal: no double bump, no delta churn — the snapshot is
      // returned exactly as it stands.
      return this.snapshot(scope.projectKey, scope.conversationId);
    }
    // First finish, or the degraded → finished authoritative correction.
    this.recordTerminal(convo, runKey, "finished");
    const map = this.conversation(convo);
    const baseline = this.baselines.get(runKey);
    const hasBaseline = baseline !== undefined;
    const scanSource: WorkArtifactSource = hasBaseline ? "scan" : "recovery";

    const createdIds: string[] = [];
    const updatedIds: string[] = [];
    const discoveredIds: string[] = [];
    const seenId = new Set<string>();
    const now = Date.now();

    for (const a of scan?.artifacts ?? []) {
      if (a.target.kind === 'file' && !isOutputArtifactPath(a.target.relativePath)) continue;
      seenId.add(a.id);
      const existing = map.get(a.id);
      if (!existing) this.observe(convo);
      const priorSig = baseline?.get(a.id);
      const finalSig = signatureOf(a.signature);

      // §8.5 change / version decision, single source of truth.
      let change: WorkArtifactChange;
      let version: number;
      const observedChange = scan?.observedChanges?.get(a.id);
      if (observedChange) {
        change = observedChange;
        version = observedChange === 'created' && existing?.lastRunId === scope.runId
          ? existing.version : (existing?.version ?? 0) + 1;
        if (observedChange === 'created') createdIds.push(a.id); else updatedIds.push(a.id);
      } else if (hasBaseline) {
        if (priorSig === undefined) {
          // Not present at run start → created during the run. An event that
          // already created it THIS run counts once, not twice.
          change = "created";
          version = existing && existing.lastRunId === scope.runId
            ? existing.version
            : (existing?.version ?? 0) + 1;
          createdIds.push(a.id);
        } else if (finalSig !== priorSig) {
          change = "updated";
          version = (existing?.version ?? 1) + 1;
          updatedIds.push(a.id);
        } else {
          change = "unchanged";
          version = existing?.version ?? 1;
        }
      } else {
        // Recovery: no baseline. Any signature drift vs the persisted record
        // counts as an update; first-seen files are honestly `discovered`.
        const recoveredSig = existing?.signature ? signatureOf(existing.signature) : undefined;
        if (recoveredSig !== undefined && recoveredSig !== finalSig) {
          change = "updated";
          version = (existing?.version ?? 1) + 1;
          updatedIds.push(a.id);
        } else {
          change = "discovered";
          version = existing?.version ?? 1;
          discoveredIds.push(a.id);
        }
      }

      map.set(a.id, {
        id: a.id,
        target: existing?.target ?? a.target,
        displayName: existing?.displayName ?? a.displayName,
        artifactKind: existing?.artifactKind ?? a.artifactKind,
        version,
        firstSeenAt: existing?.firstSeenAt ?? now,
        updatedAt: now,
        firstRunId: existing?.firstRunId ?? scope.runId,
        lastRunId: scope.runId,
        lastTurnId: scope.turnId,
        lastChange: change === "unchanged" ? (existing?.lastChange ?? "discovered") : change,
        sources: orderedSources(existing?.sources, scanSource),
        signature: a.signature,
      });
    }

    // Event records the terminal scan missed (e.g. scan failed or the file was
    // cleaned up). Keep them; never infer an update without a signature.
    for (const [id, record] of map) {
      if (seenId.has(id)) continue;
      if (record.lastRunId !== scope.runId || !record.sources.includes("event")) continue;
      const priorSig = baseline?.get(id);
      if (hasBaseline) {
        if (priorSig === undefined) createdIds.push(id);
        // The record keeps `created`: the baseline proves the file did not
        // exist at run start, so the event evidence is consistent.
      } else if (!record.sources.includes("scan") && !record.sources.includes("recovery")) {
        discoveredIds.push(id);
        // C-Core event-only semantics: without a terminal scan we cannot
        // corroborate creation — the record's lastChange must agree with
        // the delta it is counted in (`discovered`, not `created`).
        map.set(id, { ...record, lastChange: "discovered", updatedAt: now });
      }
    }

    this.baselines.delete(runKey);
    this.trimConversation(map);
    const latest = this.latestRun.get(convo);
    if (!latest || dateNum(latest.startedAt) <= dateNum(scope.startedAt)) {
      this.latestRun.set(convo, {
        runId: scope.runId,
        turnId: scope.turnId,
        startedAt: scope.startedAt,
        finishedAt: now,
        status: outcome,
        createdIds,
        updatedIds,
        discoveredIds,
      });
    }
    return this.snapshot(scope.projectKey, scope.conversationId);
  }

  /** Mark the terminal scan incomplete for a run (spec §8.2 / §8.4; C-Core
   *  state machine): keep event records, record a degraded latest run, and
   *  allow ONE later finishRun as the authoritative correction. The baseline
   *  is KEPT so that correction can still compare against it. Immutable
   *  `finished` runs reject this call outright; repeated failRun is a no-op. */
  failRun(scope: ArtifactRunScope, warning: string): ArtifactResult {
    const convo = conversationKey(scope.projectKey, scope.conversationId);
    this.conversation(convo);
    const runKey = this.baselineKey(convo, scope.runId);
    const state = this.terminalRuns.get(runKey);
    if (state === "finished" || state === "degraded") {
      // Immutability wins over degradation; degradation is idempotent.
      return this.snapshot(scope.projectKey, scope.conversationId);
    }
    this.recordTerminal(convo, runKey, "degraded");
    const latest = this.latestRun.get(convo);
    const isNewer = !latest || dateNum(latest.startedAt) <= dateNum(scope.startedAt);
    if (isNewer) {
      this.latestRun.set(convo, {
        runId: scope.runId,
        turnId: scope.turnId,
        startedAt: scope.startedAt,
        finishedAt: Date.now(),
        status: "degraded",
        warning,
        createdIds: [],
        updatedIds: [],
        discoveredIds: [],
      });
    }
    return this.snapshot(scope.projectKey, scope.conversationId);
  }

  /** Current per-conversation result (snapshot). Bounded (§6.6: 200). */
  snapshot(projectKey: string, conversationId: string): ArtifactResult {
    const convo = conversationKey(projectKey, conversationId);
    const map = this.byConversation.get(convo);
    if (!map) {
      return { artifacts: [], artifactCountTotal: 0, truncated: false };
    }
    const all = [...map.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const kept = all.slice(0, MAX_ARTIFACTS_PER_CONVERSATION);
    // C-Core: the total is the monotonic observed count — eviction keeps the
    // map bounded without lying about how many identities ever existed.
    const observed = Math.max(this.observedCounts.get(convo) ?? 0, map.size);
    return {
      ...(this.latestRun.get(convo) ? { latestRun: alignWorkRunDelta(this.latestRun.get(convo)!, kept) } : {}),
      artifacts: kept,
      artifactCountTotal: observed,
      truncated: observed > kept.length,
    };
  }

  /** C-Core state query: a run's terminal state (`finished` is immutable,
   *  `degraded` admits one authoritative finishRun correction). Undefined
   *  for running / unknown / evicted runs. */
  runTerminalState(
    projectKey: string,
    conversationId: string,
    runId: string,
  ): ArtifactRunTerminalState | undefined {
    return this.terminalRuns.get(
      this.baselineKey(conversationKey(projectKey, conversationId), runId),
    );
  }

  /** C-Core observability: how many terminal-run markers are tracked for
   *  the conversation (bounded by MAX_TRACKED_TERMINAL_RUNS). */
  trackedTerminalRunCount(projectKey: string, conversationId: string): number {
    return this.terminalOrder.get(conversationKey(projectKey, conversationId))?.length ?? 0;
  }

  /** Drop everything for one conversation (conversation deletion, C-Core).
   *  Sibling conversations of the same project are untouched. */
  clearConversation(projectKey: string, conversationId: string): void {
    const convo = conversationKey(projectKey, conversationId);
    this.byConversation.delete(convo);
    this.latestRun.delete(convo);
    this.observedCounts.delete(convo);
    this.terminalOrder.delete(convo);
    const prefix = `${convo}::`;
    for (const key of [...this.baselines.keys()]) {
      if (key.startsWith(prefix)) this.baselines.delete(key);
    }
    for (const key of [...this.terminalRuns.keys()]) {
      if (key.startsWith(prefix)) this.terminalRuns.delete(key);
    }
  }

  /** Drop everything for one project (project switch / close, §8.1). */
  clearProject(projectKey: string): void {
    const prefix = `${projectKey}::`;
    for (const key of [...this.byConversation.keys()]) {
      if (key.startsWith(prefix)) this.byConversation.delete(key);
    }
    for (const key of [...this.latestRun.keys()]) {
      if (key.startsWith(prefix)) this.latestRun.delete(key);
    }
    for (const key of [...this.baselines.keys()]) {
      if (key.startsWith(prefix)) this.baselines.delete(key);
    }
    for (const key of [...this.terminalRuns.keys()]) {
      if (key.startsWith(prefix)) this.terminalRuns.delete(key);
    }
    for (const key of [...this.terminalOrder.keys()]) {
      if (key.startsWith(prefix)) this.terminalOrder.delete(key);
    }
    for (const key of [...this.observedCounts.keys()]) {
      if (key.startsWith(prefix)) this.observedCounts.delete(key);
    }
  }
}

/** Compare run start times for "which run is newer" (§13.2). Ordering uses
 *  number — missing/zero start times rank oldest. */
function dateNum(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
