import {
  compactSnapshot,
  emptySnapshot,
  migrateSnapshot,
  type UserLearningStore,
} from './store';
import { LOCAL_USER_ID, USER_LEARNING_SCHEMA_VERSION, type UserLearningSnapshot } from './types';

export interface LearningFileIO {
  read(path: string): string | null;
  write(path: string, content: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
}

export function createMemoryFileIO(initial: Record<string, string> = {}): LearningFileIO & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    read(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    write(path, content) {
      files.set(path, content);
    },
    remove(path) {
      files.delete(path);
    },
    rename(from, to) {
      if (!files.has(from)) throw new Error(`missing ${from}`);
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
}

export function createLocalStorageFileIO(storage?: Storage): LearningFileIO {
  const getStorage = (): Storage | null => {
    if (storage) return storage;
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  };
  return {
    read(path) {
      try {
        return getStorage()?.getItem(path) ?? null;
      } catch {
        return null;
      }
    },
    write(path, content) {
      const store = getStorage();
      if (!store) throw new Error('no storage');
      store.setItem(path, content);
    },
    remove(path) {
      getStorage()?.removeItem(path);
    },
    rename(from, to) {
      const store = getStorage();
      if (!store) throw new Error('no storage');
      const value = store.getItem(from);
      if (value == null) throw new Error(`missing ${from}`);
      store.setItem(to, value);
      store.removeItem(from);
    },
  };
}

export function atomicWrite(io: LearningFileIO, path: string, content: string): void {
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  io.write(tmp, content);
  const previous = io.read(path);
  if (previous != null) io.write(bak, previous);
  io.rename(tmp, path);
}

export function readWithBackup(io: LearningFileIO, path: string): string | null {
  const primary = io.read(path);
  if (primary != null) return primary;
  return io.read(`${path}.bak`);
}

const LEGACY_KEY = 'trylo:user-learning:v1';

export function createFileUserLearningStore(options: {
  readonly io: LearningFileIO;
  readonly rootDir: string;
  readonly now?: () => number;
  readonly importLegacy?: () => string | null;
}): UserLearningStore {
  const now = options.now ?? (() => Date.now());
  const snapshotPath = `${options.rootDir.replace(/[\\/]+$/, '')}/snapshot.json`;
  let current = emptySnapshot(now(), LOCAL_USER_ID);

  const loadFromDisk = (): UserLearningSnapshot => {
    try {
      const raw = readWithBackup(options.io, snapshotPath);
      if (raw) {
        try {
          return migrateSnapshot(JSON.parse(raw) as unknown, now());
        } catch {
          const bak = options.io.read(`${snapshotPath}.bak`);
          if (bak) return migrateSnapshot(JSON.parse(bak) as unknown, now());
          throw new Error('corrupt snapshot');
        }
      }
      const legacy = options.importLegacy?.()
        ?? (typeof window === 'undefined' ? null : window.localStorage.getItem(LEGACY_KEY));
      if (legacy) return migrateSnapshot(JSON.parse(legacy) as unknown, now());
      return emptySnapshot(now(), LOCAL_USER_ID);
    } catch (err) {
      return {
        ...emptySnapshot(now(), LOCAL_USER_ID),
        persisted: false,
        diagnostics: {
          persistFailed: true,
          persistError: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };

  const persistToDisk = (snapshot: UserLearningSnapshot): UserLearningSnapshot => {
    if (snapshot.diagnostics?.readOnly) return snapshot;
    const compacted = compactSnapshot(snapshot);
    try {
      atomicWrite(options.io, snapshotPath, JSON.stringify(compacted));
      return {
        ...compacted,
        persisted: true,
        diagnostics: compacted.diagnostics?.incompatible ? compacted.diagnostics : undefined,
      };
    } catch (err) {
      return {
        ...compacted,
        persisted: false,
        diagnostics: {
          persistFailed: true,
          persistError: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };

  current = loadFromDisk();

  return {
    snapshot: () => current,
    load: () => {
      current = loadFromDisk();
      return current;
    },
    persist() {
      current = persistToDisk(current);
    },
    replace(next) {
      if (current.diagnostics?.readOnly) return current;
      current = persistToDisk({ ...next, schemaVersion: USER_LEARNING_SCHEMA_VERSION, updatedAt: now() });
      return current;
    },
    update(mutator) {
      if (current.diagnostics?.readOnly) return current;
      current = persistToDisk({
        ...mutator(current),
        schemaVersion: USER_LEARNING_SCHEMA_VERSION,
        updatedAt: now(),
      });
      return current;
    },
    clear() {
      const cleared = { ...emptySnapshot(now(), current.userId), persisted: true };
      try {
        options.io.remove(snapshotPath);
        options.io.remove(`${snapshotPath}.tmp`);
        options.io.remove(`${snapshotPath}.bak`);
        options.io.remove(LEGACY_KEY);
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
