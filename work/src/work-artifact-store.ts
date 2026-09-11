// Trylo Work — scoped artifact projection store (P2-1, spec §8).
//
// Replaces the single-`Map` store whose key was just the canonical absolute
// path. That design cross-contaminated artifacts between Work conversations
// of the same project, and after a project switch late background events of
// the old project could be written into the new store. The scoped store keys
// every record by `(projectKey, conversationId, targetIdentity)` (spec §8.1)
// and keeps a per-run baseline so `run_delta` change semantics (created /
// updated / discovered / unchanged) come from a real cross-run signature
// comparison, never from "how many sources saw it" (spec §8.5 / §2.1).
//
// This module is Work-domain and pure (no React, no Tauri, no Desktop types).
// The Desktop `WorkResultProjector` drives it from the Work runtime lifecycle
// and maps its snapshot into Desktop's `StoredWorkResult` for persistence.
//
// ── Run lifecycle state machine (C-Core, audit P2-2) ────────────────────────
//
// Each run (keyed `conversationKey::runId`) moves through:
//
//   running ──finishRun──▶ finished   (IMMUTABLE terminal)
//   running ──failRun────▶ degraded   (correctable terminal)
//   degraded ─finishRun──▶ finished   (authoritative correction)
//
// Contracts:
//   * IMMUTABLE TERMINAL — once `finished`, no finishRun/failRun can change
//     the run again. A duplicate terminal is a deterministic no-op that
//     returns the current snapshot (no double version bump, no delta churn).
//   * AUTHORITATIVE CORRECTION — a `degraded` run (terminal scan failed) is
//     finalisable: a later finishRun recomputes the real cross-run delta and
//     replaces the degraded latestRun. The baseline is therefore KEPT on
//     failRun so the correction compares against it.
//   * failRun after failRun is idempotent; any terminal after `finished` is
//     a no-op (immutability wins).
//   * EVENT-ONLY ARTIFACTS — records the terminal scan missed keep their
//     event evidence. With a baseline they stay `created` only when the
//     baseline proves absence; in recovery (no baseline) their lastChange is
//     honestly downgraded to `discovered` — a missing scan cannot
//     corroborate creation.
//
// Ownership & bounded lifecycle:
//   * This store is the SOLE owner of run finalisation state. The Desktop
//     projector consults `runTerminalState` instead of keeping a parallel
//     exactly-once set.
//   * Terminal bookkeeping is a per-conversation FIFO bounded by
//     MAX_TRACKED_TERMINAL_RUNS; the oldest marker (and its baseline) is
//     evicted first. Evicted markers are diagnostic-only bookkeeping — late
//     events of stale runs are already dropped by upstream scope validation.
//   * The per-conversation artifact map is bounded by
//     MAX_ARTIFACTS_PER_CONVERSATION; overflow evicts the oldest `updatedAt`
//     records. The UI renders exactly the newest 200, so eviction never
//     removes a currently displayed artifact. `artifactCountTotal` is a
//     monotonic counter — eviction never decreases it.
//   * `clearConversation` / `clearProject` are the explicit teardown paths
//     (conversation deletion / workspace close).

import {
  artifactDisplayName,
  canonicalAbsolutePath,
  isHttpArtifact,
  relativeArtifactPath,
} from "./artifact-paths.js";

// ── Neutral Work-domain types (§6.3 mirrored; Desktop maps losslessly) ──────

export type WorkArtifactTarget =
  | { readonly kind: "file"; readonly relativePath: string }
  | { readonly kind: "url"; readonly url: string };

export type WorkArtifactChange =
  | "created"
  | "updated"
  | "discovered"
  | "unchanged";

export type WorkArtifactSource = "event" | "scan" | "recovery";

export type WorkProjectionStatus =
  | "collecting"
  | "completed"
  | "failed"
  | "cancelled"
  | "degraded";

/** The runtime's real terminal outcome for a Work run (spec §6.1: the
 *  projection status must never overwrite it; `degraded` is reserved for a
 *  projection that itself failed). */
export type WorkRunOutcome = "completed" | "failed" | "cancelled";

/** C-Core lifecycle: a run's terminal state inside the store. `finished` is
 *  immutable; `degraded` admits exactly one authoritative finishRun
 *  correction (see module header state machine). */
export type WorkRunTerminalState = "finished" | "degraded";

export interface WorkFileSignature {
  readonly size: number;
  readonly modifiedMs: number;
  readonly contentHash?: string;
}

/** Display-level artifact kind (includes the generic `file` fallback). */
export type WorkArtifactKind =
  | "document"
  | "presentation"
  | "spreadsheet"
  | "web"
  | "file";

export interface WorkArtifactRecord {
  /** target kind + canonical target identity. */
  readonly id: string;
  readonly target: WorkArtifactTarget;
  readonly displayName: string;
  readonly artifactKind: WorkArtifactKind;
  /** 1 on first entry into the conversation; only a real cross-run content
   *  change bumps it (spec §8.5). */
  readonly version: number;
  readonly firstSeenAt: number;
  readonly updatedAt: number;
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly lastTurnId: string | undefined;
  readonly lastChange: WorkArtifactChange;
  readonly sources: readonly WorkArtifactSource[];
  readonly signature?: WorkFileSignature;
}

export interface WorkRunDelta {
  readonly runId: string;
  readonly turnId: string | undefined;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly status: WorkProjectionStatus;
  readonly warning?: string;
  readonly createdIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly discoveredIds: readonly string[];
}

export interface WorkResult {
  readonly latestRun?: WorkRunDelta;
  readonly artifacts: readonly WorkArtifactRecord[];
  readonly artifactCountTotal: number;
  readonly truncated: boolean;
}

/** Identity of a Work run (spec §8.1). `turnId` links the result to its
 *  originating user message; `taskId` is the durable thread id — neither
 *  replaces `runId` as the run key. */
export interface WorkArtifactScope {
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly turnId: string | undefined;
  readonly startedAt: number;
}

/** One file found by the `.trylo/out` scanner (spec §8.2 / §8.5). */
export interface ScannedArtifact {
  readonly target: WorkArtifactTarget;
  readonly id: string;
  readonly displayName: string;
  readonly artifactKind: WorkArtifactKind;
  readonly absolutePath: string;
  readonly signature: WorkFileSignature;
}

/** The store's view of the terminal scan, for the run-delta comparison. */
export interface WorkScanResult {
  readonly artifacts: readonly ScannedArtifact[];
  readonly truncated: boolean;
}

export interface WorkArtifactUpsert {
  /** The raw path as the daemon / scan reported it (absolute file path or an
   *  http(s) url). Derived into a `WorkArtifactTarget` against the scope's
   *  project root; malformed / out-of-root values are rejected. */
  readonly rawPath: string;
  readonly artifactKind?: string;
  readonly at: number;
  readonly runId: string;
  readonly turnId: string | undefined;
}

// ── identity helpers ────────────────────────────────────────────────────────

function signatureOf(a: WorkFileSignature | undefined): string {
  return a === undefined ? "" : `${a.size}:${a.modifiedMs}:${a.contentHash ?? ""}`;
}

/** Merge sources while keeping the fixed event → scan → recovery order
 *  (spec §8.5), so serialisation output is deterministic. */
function orderedSources(prior: readonly WorkArtifactSource[] | undefined, next: WorkArtifactSource): readonly WorkArtifactSource[] {
  return (["event", "scan", "recovery"] as const).filter(
    (s) => s === next || (prior !== undefined && prior.includes(s)),
  );
}

/** Identity of an arbitrary artifact event path: an http(s) url stays the
 *  url; a file becomes its canonical relative path. Returns undefined when
 *  the value is not a usable target (kept out of the projection). */
function targetFromInput(
  rawPath: string,
  projectRoot: string,
): { target: WorkArtifactTarget; displayName: string; absolutePath?: string } | undefined {
  const trimmed = rawPath.trim();
  if (isHttpArtifact(trimmed)) {
    return { target: { kind: "url", url: trimmed }, displayName: trimmed };
  }
  const canonical = canonicalAbsolutePath(trimmed);
  if (canonical === undefined) return undefined;
  const rel = relativeArtifactPath(canonical, projectRoot);
  if (rel === undefined || rel.length === 0) return undefined;
  return {
    target: { kind: "file", relativePath: rel },
    displayName: artifactDisplayName(canonical) || rel.split("/").pop() || rel,
    absolutePath: canonical,
  };
}

function artifactKindFrom(hint: string | undefined, rel: string | undefined): WorkArtifactKind {
  if (
    hint === "document" ||
    hint === "presentation" ||
    hint === "spreadsheet" ||
    hint === "web" ||
    hint === "file"
  ) {
    return hint;
  }
  if (rel === undefined) return "file";
  const lower = rel.toLowerCase();
  if (/\.(md|markdown|docx?|docm|dotx|dotm|rtf|odt|ott|pages)$/.test(lower)) return "document";
  if (/\.(pptx?|pptm|potx|potm|ppsx|ppsm)$/.test(lower)) return "presentation";
  if (/\.(xlsx?|xlsm|xlsb|csv|tsv|ods|numbers|gsheet)$/.test(lower)) return "spreadsheet";
  if (/\.(html?|htm)$/.test(lower)) return "web";
  return "file";
}

// ── the scoped store ─────────────────────────────────────────────────────────

const MAX_ARTIFACTS_PER_CONVERSATION = 200;

/** C-Core: per-conversation cap on terminal-run bookkeeping (markers +
 *  baselines). Oldest finalised run evicted first — its marker is
 *  diagnostic-only, never gating an active run. */
const MAX_TRACKED_TERMINAL_RUNS = 64;

function conversationKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`;
}

type ArtifactMap = Map<string, WorkArtifactRecord>;

export class WorkArtifactStore {
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
  private readonly terminalRuns = new Map<string, WorkRunTerminalState>();
  /** conversationKey -> run keys in finalisation order; the eviction FIFO
   *  that bounds `terminalRuns` and their baselines. */
  private readonly terminalOrder = new Map<string, string[]>();
  /** conversationKey -> monotonic count of distinct artifact identities
   *  ever observed. Eviction never decreases it, so `artifactCountTotal`
   *  stays honest after bounded cleanup. */
  private readonly observedCounts = new Map<string, number>();
  /** latest run delta per conversation (kept across runs for snapshot). */
  private readonly latestRun = new Map<string, WorkRunDelta>();

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
  private recordTerminal(convo: string, runKey: string, state: WorkRunTerminalState): void {
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
   *  persisted shape is a `WorkResult` (neutral). */
  hydrate(conversation: string, stored: WorkResult | undefined): void {
    if (!stored) return;
    const map = this.conversation(conversation);
    for (const a of stored.artifacts) {
      map.set(a.id, { ...a, sources: [...a.sources] });
    }
    // Restore the monotonic total (persisted count wins; never go below the
    // number of records actually present).
    this.observedCounts.set(
      conversation,
      Math.max(stored.artifactCountTotal, map.size),
    );
    if (stored.latestRun) {
      this.latestRun.set(conversation, { ...stored.latestRun, createdIds: [...stored.latestRun.createdIds], updatedIds: [...stored.latestRun.updatedIds], discoveredIds: [...stored.latestRun.discoveredIds] });
    }
  }

  /** Start a run and pin its baseline (spec §8.2). A `null` baseline (scan
   *  failed or not available, e.g. recovery) is handled at finishRun as
   *  `discovered` rather than `created`. */
  beginRun(scope: WorkArtifactScope, baseline: readonly ScannedArtifact[] | null): void {
    const convo = conversationKey(scope.projectKey, scope.conversationId);
    this.conversation(convo); // ensure an empty record map exists
    const map = new Map<string, string>();
    for (const a of baseline ?? []) {
      map.set(a.id, signatureOf(a.signature));
    }
    this.baselines.set(this.baselineKey(convo, scope.runId), map);
  }

  /** One accepted artifact item during a run (source "event", spec §8.2).
   *  Idempotent per identity within a run. */
  upsertEvent(scope: WorkArtifactScope, input: WorkArtifactUpsert): boolean {
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
  finishRun(scope: WorkArtifactScope, scan: WorkScanResult | null, outcome: WorkRunOutcome = "completed"): WorkResult {
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
      seenId.add(a.id);
      const existing = map.get(a.id);
      if (!existing) this.observe(convo);
      const priorSig = baseline?.get(a.id);
      const finalSig = signatureOf(a.signature);

      // §8.5 change / version decision, single source of truth.
      let change: WorkArtifactChange;
      let version: number;
      if (hasBaseline) {
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
  failRun(scope: WorkArtifactScope, warning: string): WorkResult {
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
  snapshot(projectKey: string, conversationId: string): WorkResult {
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
      ...(this.latestRun.get(convo) ? { latestRun: this.latestRun.get(convo) } : {}),
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
  ): WorkRunTerminalState | undefined {
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