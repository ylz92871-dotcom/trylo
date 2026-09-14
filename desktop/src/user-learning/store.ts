import { conclusionStableKey, userModelStableKey, withFingerprint } from './scope';
import {
  LOCAL_USER_ID,
  USER_LEARNING_SCHEMA_VERSION,
  type ConclusionRecord,
  type EvidenceScope,
  type PolicyDimension,
  type TaskStage,
  type UserLearningSnapshot,
  type UserModelRecord,
} from './types';

const STORAGE_KEY = 'trylo:user-learning:v1';
const STORAGE_BACKUP_KEY = 'trylo:user-learning:v1:backup';

export function emptySnapshot(now = Date.now(), userId = LOCAL_USER_ID): UserLearningSnapshot {
  return {
    schemaVersion: USER_LEARNING_SCHEMA_VERSION,
    userId,
    traces: [],
    traceLearningCommits: [],
    deletionEpoch: 0,
    eligibilityDecisions: [],
    behaviorCommitments: [],
    learningReceipts: [],
    outcomeObservations: [],
    learningCallLedger: [],
    evidence: [],
    evidenceRelations: [],
    conclusions: [],
    conclusionRelations: [],
    profileFacts: [],
    userModels: [],
    userModelDerivations: [],
    projectContexts: [],
    policyRules: [],
    policyBundles: [],
    policyDecisions: [],
    cognitionSessions: [],
    cognitionCooldowns: [],
    cognitionAskLog: [],
    learningRuns: [],
    dirtyDimensions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

const TASK_STAGES = new Set<TaskStage>(['explore', 'plan', 'produce', 'review', 'deliver', 'unknown']);

function migrateScope(scope: EvidenceScope | undefined): EvidenceScope {
  const safe = scope ?? { workspaceId: 'global', projectId: 'global', scopeTags: [] };
  const taskStage = safe.taskStage && TASK_STAGES.has(safe.taskStage)
    ? safe.taskStage
    : safe.taskStage
      ? 'unknown'
      : undefined;
  return withFingerprint({ ...safe, taskStage });
}

function supersedeDuplicateActive<
  T extends ConclusionRecord | UserModelRecord,
>(items: readonly T[]): readonly T[] {
  const winners = new Map<string, T>();
  for (const item of items) {
    if (item.status !== 'active' || !item.stableKey) continue;
    const prior = winners.get(item.stableKey);
    if (
      !prior
      || item.version > prior.version
      || (item.version === prior.version && item.updatedAt > prior.updatedAt)
      || (item.version === prior.version && item.updatedAt === prior.updatedAt && item.id > prior.id)
    ) {
      winners.set(item.stableKey, item);
    }
  }
  return items.map((item) => (
    item.status === 'active'
    && item.stableKey
    && winners.get(item.stableKey)?.id !== item.id
      ? { ...item, status: 'superseded' as const }
      : item
  ));
}

export function migrateSnapshot(value: unknown, now = Date.now()): UserLearningSnapshot {
  if (!isObject(value)) return emptySnapshot(now);
  const schemaVersion = typeof value.schemaVersion === 'number' ? value.schemaVersion : 0;
  const base = emptySnapshot(now, typeof value.userId === 'string' ? value.userId : LOCAL_USER_ID);
  const traces = asArray<UserLearningSnapshot['traces'][number]>(value.traces);
  const persistedCommits = asArray<UserLearningSnapshot['traceLearningCommits'][number]>(value.traceLearningCommits);
  const traceLearningCommits = persistedCommits.length > 0 || schemaVersion >= 4
    ? persistedCommits
    : traces.flatMap((trace) => (
      trace.closedAt !== undefined
        ? [{
          terminalKey: `legacy:${trace.id}`,
          traceId: trace.id,
          outcome: trace.outcome ?? 'exited',
          status: 'committed' as const,
          committedAt: trace.closedAt,
        }]
        : []
    ));
  const rawEvidence = asArray<UserLearningSnapshot['evidence'][number]>(value.evidence);
  const rawConclusions = asArray<UserLearningSnapshot['conclusions'][number]>(value.conclusions);
  const rawUserModels = asArray<UserLearningSnapshot['userModels'][number]>(value.userModels);
  const migratingToV5 = schemaVersion < 5;
  const evidence = migratingToV5
    ? rawEvidence.map((item) => ({ ...item, context: migrateScope(item.context) }))
    : rawEvidence;
  const conclusions = migratingToV5
    ? supersedeDuplicateActive(rawConclusions.map((item) => {
      const scope = migrateScope(item.scope);
      return {
        ...item,
        scope,
        stableKey: conclusionStableKey(item.userId, item.dimension, scope),
      };
    }))
    : rawConclusions;
  const userModels = migratingToV5
    ? supersedeDuplicateActive(rawUserModels.map((item) => {
      const scope = migrateScope(item.scope);
      return {
        ...item,
        scope,
        stableKey: userModelStableKey(item.userId, item.dimension, scope),
      };
    }))
    : rawUserModels;
  const dirtyDimensions = asArray<PolicyDimension>(value.dirtyDimensions);
  const preserved = {
    ...base,
    traces,
    traceLearningCommits,
    deletionEpoch: typeof value.deletionEpoch === 'number' ? value.deletionEpoch : 0,
    eligibilityDecisions: asArray<UserLearningSnapshot['eligibilityDecisions'][number]>(value.eligibilityDecisions),
    behaviorCommitments: asArray<UserLearningSnapshot['behaviorCommitments'][number]>(value.behaviorCommitments),
    learningReceipts: asArray<UserLearningSnapshot['learningReceipts'][number]>(value.learningReceipts),
    outcomeObservations: asArray<UserLearningSnapshot['outcomeObservations'][number]>(value.outcomeObservations),
    learningCallLedger: asArray<UserLearningSnapshot['learningCallLedger'][number]>(value.learningCallLedger),
    evidence,
    evidenceRelations: asArray<UserLearningSnapshot['evidenceRelations'][number]>(value.evidenceRelations),
    conclusions,
    conclusionRelations: asArray<UserLearningSnapshot['conclusionRelations'][number]>(value.conclusionRelations),
    profileFacts: asArray<UserLearningSnapshot['profileFacts'][number]>(value.profileFacts),
    userModels,
    userModelDerivations: asArray<UserLearningSnapshot['userModelDerivations'][number]>(value.userModelDerivations),
    projectContexts: asArray<UserLearningSnapshot['projectContexts'][number]>(value.projectContexts),
    policyRules: asArray<UserLearningSnapshot['policyRules'][number]>(value.policyRules).map((item) => (
      migratingToV5 ? { ...item, status: 'superseded' as const } : item
    )),
    policyBundles: asArray<UserLearningSnapshot['policyBundles'][number]>(value.policyBundles).map((item) => (
      migratingToV5 ? { ...item, status: 'retired' as const } : item
    )),
    policyDecisions: asArray<UserLearningSnapshot['policyDecisions'][number]>(value.policyDecisions),
    cognitionSessions: asArray<UserLearningSnapshot['cognitionSessions'][number]>(value.cognitionSessions),
    cognitionCooldowns: asArray<UserLearningSnapshot['cognitionCooldowns'][number]>(value.cognitionCooldowns),
    cognitionAskLog: asArray<UserLearningSnapshot['cognitionAskLog'][number]>(value.cognitionAskLog),
    learningRuns: asArray<UserLearningSnapshot['learningRuns'][number]>(value.learningRuns),
    dirtyDimensions: migratingToV5
      ? [...new Set([
        ...dirtyDimensions,
        ...userModels.filter((item) => item.status === 'active').map((item) => item.dimension),
      ])]
      : dirtyDimensions,
    pendingRuns: asArray<NonNullable<UserLearningSnapshot['pendingRuns']>[number]>(value.pendingRuns),
    currentBaseBundleId: migratingToV5
      ? undefined
      : typeof value.currentBaseBundleId === 'string' ? value.currentBaseBundleId : undefined,
    currentProjectBundleIds: !migratingToV5 && isObject(value.currentProjectBundleIds)
      ? value.currentProjectBundleIds as UserLearningSnapshot['currentProjectBundleIds']
      : undefined,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: now,
    persisted: true,
  };
  if (schemaVersion > USER_LEARNING_SCHEMA_VERSION) {
    return {
      ...preserved,
      schemaVersion,
      diagnostics: { incompatible: true, readOnly: true },
    };
  }
  return {
    ...preserved,
    schemaVersion: USER_LEARNING_SCHEMA_VERSION,
  };
}

export interface UserLearningStore {
  snapshot(): UserLearningSnapshot;
  replace(next: UserLearningSnapshot): UserLearningSnapshot;
  update(mutator: (prev: UserLearningSnapshot) => UserLearningSnapshot): UserLearningSnapshot;
  persist(): void;
  load(): UserLearningSnapshot;
  /** Permanently clears primary/backup persistence owned by this store. */
  clear(): UserLearningSnapshot;
}

export interface StoreOptions {
  readonly memoryOnly?: boolean;
  readonly now?: () => number;
}

export function createUserLearningStore(options: StoreOptions = {}): UserLearningStore {
  const now = options.now ?? (() => Date.now());
  const memoryOnly = options.memoryOnly === true;
  let current = emptySnapshot(now());

  const persist = (): void => {
    if (memoryOnly || typeof window === 'undefined') {
      current = { ...current, persisted: true };
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) window.localStorage.setItem(STORAGE_BACKUP_KEY, raw);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      current = {
        ...current,
        persisted: true,
        diagnostics: current.diagnostics?.incompatible ? current.diagnostics : undefined,
      };
    } catch (err) {
      const persistError = err instanceof Error ? err.message : String(err);
      current = {
        ...current,
        persisted: false,
        diagnostics: { persistFailed: true, persistError },
      };
    }
  };

  const load = (): UserLearningSnapshot => {
    if (memoryOnly || typeof window === 'undefined') return current;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
        ?? window.localStorage.getItem(STORAGE_BACKUP_KEY);
      if (!raw) return current;
      current = migrateSnapshot(JSON.parse(raw) as unknown, now());
      return current;
    } catch {
      return current;
    }
  };

  current = load();

  return {
    snapshot: () => current,
    replace(next) {
      if (current.diagnostics?.readOnly) return current;
      current = { ...next, schemaVersion: USER_LEARNING_SCHEMA_VERSION, updatedAt: now() };
      persist();
      return current;
    },
    update(mutator) {
      if (current.diagnostics?.readOnly) return current;
      current = {
        ...mutator(current),
        schemaVersion: USER_LEARNING_SCHEMA_VERSION,
        updatedAt: now(),
      };
      persist();
      return current;
    },
    persist,
    load,
    clear() {
      const cleared = { ...emptySnapshot(now(), current.userId), persisted: true };
      if (memoryOnly || typeof window === 'undefined') {
        current = cleared;
        return current;
      }
      try {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(STORAGE_BACKUP_KEY);
        current = cleared;
      } catch (err) {
        current = {
          ...cleared,
          persisted: false,
          diagnostics: {
            persistFailed: true,
            persistError: err instanceof Error ? err.message : String(err),
          },
        };
      }
      return current;
    },
  };
}

export function markDirty(
  snapshot: UserLearningSnapshot,
  dimensions: readonly PolicyDimension[],
): UserLearningSnapshot {
  const set = new Set(snapshot.dirtyDimensions);
  for (const d of dimensions) set.add(d);
  return { ...snapshot, dirtyDimensions: [...set] };
}

export function clearDirty(
  snapshot: UserLearningSnapshot,
  dimensions?: readonly PolicyDimension[],
): UserLearningSnapshot {
  if (!dimensions || dimensions.length === 0) {
    return { ...snapshot, dirtyDimensions: [] };
  }
  const drop = new Set(dimensions);
  return { ...snapshot, dirtyDimensions: snapshot.dirtyDimensions.filter((d) => !drop.has(d)) };
}

export function activeRecords<T extends { status: string }>(items: readonly T[]): readonly T[] {
  return items.filter((item) => item.status === 'active');
}

const MAX_TRACES = 80;
const MAX_EXECUTION_RESULT = 400;
const MAX_DECISIONS = 200;
const MAX_RUNS = 150;
const MAX_SESSIONS = 40;
const MAX_TRACE_LEARNING_COMMITS = 500;
const LEARNING_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OUTCOME_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function compactSnapshot(snapshot: UserLearningSnapshot): UserLearningSnapshot {
  const openSessions = snapshot.cognitionSessions.filter((item) => item.status === 'open');
  const closedSessions = snapshot.cognitionSessions
    .filter((item) => item.status !== 'open')
    .slice(-MAX_SESSIONS);
  return {
    ...snapshot,
    traces: snapshot.traces.slice(-MAX_TRACES).map((trace) => ({
      ...trace,
      executionResult: trace.executionResult && trace.executionResult.length > MAX_EXECUTION_RESULT
        ? `${trace.executionResult.slice(0, MAX_EXECUTION_RESULT)}…`
        : trace.executionResult,
    })),
    traceLearningCommits: snapshot.traceLearningCommits.slice(-MAX_TRACE_LEARNING_COMMITS),
    learningCallLedger: snapshot.learningCallLedger
      .filter((item) => item.reservedAt >= snapshot.updatedAt - LEARNING_LEDGER_RETENTION_MS)
      .slice(-500),
    outcomeObservations: snapshot.outcomeObservations
      .filter((item) => item.createdAt >= snapshot.updatedAt - OUTCOME_RETENTION_MS)
      .slice(-1000),
    learningReceipts: [
      ...snapshot.learningReceipts.filter((item) => item.state !== 'pending').slice(-200),
      ...snapshot.learningReceipts.filter((item) => item.state === 'pending'),
    ],
    policyDecisions: snapshot.policyDecisions.slice(-MAX_DECISIONS),
    learningRuns: snapshot.learningRuns.slice(-MAX_RUNS),
    cognitionSessions: [...closedSessions, ...openSessions],
    pendingRuns: (snapshot.pendingRuns ?? []).filter((item) => item.status === 'pending').slice(-8),
  };
}
