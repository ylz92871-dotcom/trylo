import { LOCAL_USER_ID, USER_LEARNING_SCHEMA_VERSION, type PolicyDimension, type UserLearningSnapshot } from './types';

const STORAGE_KEY = 'trylo:user-learning:v1';
const STORAGE_BACKUP_KEY = 'trylo:user-learning:v1:backup';

export function emptySnapshot(now = Date.now(), userId = LOCAL_USER_ID): UserLearningSnapshot {
  return {
    schemaVersion: USER_LEARNING_SCHEMA_VERSION,
    userId,
    traces: [],
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

export function migrateSnapshot(value: unknown, now = Date.now()): UserLearningSnapshot {
  if (!isObject(value)) return emptySnapshot(now);
  const schemaVersion = typeof value.schemaVersion === 'number' ? value.schemaVersion : 0;
  const base = emptySnapshot(now, typeof value.userId === 'string' ? value.userId : LOCAL_USER_ID);
  const preserved = {
    ...base,
    traces: asArray<UserLearningSnapshot['traces'][number]>(value.traces),
    evidence: asArray<UserLearningSnapshot['evidence'][number]>(value.evidence),
    evidenceRelations: asArray<UserLearningSnapshot['evidenceRelations'][number]>(value.evidenceRelations),
    conclusions: asArray<UserLearningSnapshot['conclusions'][number]>(value.conclusions),
    conclusionRelations: asArray<UserLearningSnapshot['conclusionRelations'][number]>(value.conclusionRelations),
    profileFacts: asArray<UserLearningSnapshot['profileFacts'][number]>(value.profileFacts),
    userModels: asArray<UserLearningSnapshot['userModels'][number]>(value.userModels),
    userModelDerivations: asArray<UserLearningSnapshot['userModelDerivations'][number]>(value.userModelDerivations),
    projectContexts: asArray<UserLearningSnapshot['projectContexts'][number]>(value.projectContexts),
    policyRules: asArray<UserLearningSnapshot['policyRules'][number]>(value.policyRules),
    policyBundles: asArray<UserLearningSnapshot['policyBundles'][number]>(value.policyBundles),
    policyDecisions: asArray<UserLearningSnapshot['policyDecisions'][number]>(value.policyDecisions),
    cognitionSessions: asArray<UserLearningSnapshot['cognitionSessions'][number]>(value.cognitionSessions),
    cognitionCooldowns: asArray<UserLearningSnapshot['cognitionCooldowns'][number]>(value.cognitionCooldowns),
    cognitionAskLog: asArray<UserLearningSnapshot['cognitionAskLog'][number]>(value.cognitionAskLog),
    learningRuns: asArray<UserLearningSnapshot['learningRuns'][number]>(value.learningRuns),
    dirtyDimensions: asArray<PolicyDimension>(value.dirtyDimensions),
    pendingRuns: asArray<NonNullable<UserLearningSnapshot['pendingRuns']>[number]>(value.pendingRuns),
    currentBaseBundleId: typeof value.currentBaseBundleId === 'string' ? value.currentBaseBundleId : undefined,
    currentProjectBundleIds: isObject(value.currentProjectBundleIds)
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
    policyDecisions: snapshot.policyDecisions.slice(-MAX_DECISIONS),
    learningRuns: snapshot.learningRuns.slice(-MAX_RUNS),
    cognitionSessions: [...closedSessions, ...openSessions],
    pendingRuns: (snapshot.pendingRuns ?? []).filter((item) => item.status === 'pending').slice(-8),
  };
}
