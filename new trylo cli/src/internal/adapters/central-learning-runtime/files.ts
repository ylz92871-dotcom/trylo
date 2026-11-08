import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lockToken, ownsLock, releaseLock, tryAcquireLock, type BoardLockOptions, type LockHandle } from "../learning-store/lock.js";
import { isLockIoCode } from "../learning-store/lock-files.js";
import { canonicalRuntimeRoot, isRuntimeIntent, isRuntimeLocator, runtimeFailure, runtimePathIdentity, runtimeSuccess,
  type RuntimeIntent, type RuntimeLocator, type RuntimeOwner, type RuntimeResult, type RuntimeScopePaths } from "./files-contract.js";

export type { RuntimeIntent, RuntimeLocator, RuntimeOwner, RuntimeResult, RuntimeScopePaths, RuntimeFileFailure } from "./files-contract.js";
export { isRuntimeIntent, isRuntimeLocator } from "./files-contract.js";

const MAX_FILE_BYTES = 1_048_576;

/** Separate homes cannot discover or control one another, even for the same workspace. */
export function runtimeScopePaths(homeRoot: string, workspaceRoot: string): RuntimeScopePaths {
  const home = canonicalRuntimeRoot(homeRoot), workspace = canonicalRuntimeRoot(workspaceRoot);
  const scopeKey = createHash("sha256").update(JSON.stringify([runtimePathIdentity(home), runtimePathIdentity(workspace)])).digest("hex");
  const directory = path.join(home, "learning", "runtime", scopeKey);
  return { homeRoot: home, workspaceRoot: workspace, scopeKey, directory, intentPath: path.join(directory, "intent.json"),
    locatorPath: path.join(directory, "locator.json"), ownerLockPath: path.join(directory, "owner.lock") };
}

export function readRuntimeIntent(paths: RuntimeScopePaths): RuntimeResult<RuntimeIntent | undefined> {
  const result = readRecord(paths.intentPath, isRuntimeIntent);
  if (!result.ok || result.value === undefined) return result;
  return sameRoot(result.value.homeRoot, paths.homeRoot) && sameRoot(result.value.workspaceRoot, paths.workspaceRoot)
    ? result : runtimeFailure("runtime_scope_mismatch", "runtime intent roots do not match its scope");
}

export function readRuntimeLocator(paths: RuntimeScopePaths): RuntimeResult<RuntimeLocator | undefined> {
  const result = readRecord(paths.locatorPath, isRuntimeLocator);
  if (!result.ok || result.value === undefined) return result;
  return result.value.scopeKey === paths.scopeKey ? result
    : runtimeFailure("runtime_scope_mismatch", "runtime locator does not match its scope");
}

/** Read existing enabled scopes in one home without opening an owner or returning private records. */
export function readExistingEnabledRuntimeScopes(homeRoot: string): RuntimeResult<{
  scopes: readonly RuntimeScopePaths[]; issues: readonly { scopeKey: string; reason: string }[];
}> {
  const registry = readRuntimeRegistry(homeRoot);
  if (!registry.ok) return registry;
  return { ok: true, value: registry.value === undefined ? { scopes: [], issues: [] }
    : scanRuntimeRegistry(registry.value, registry.value.entries, "existing_owner") };
}

/** Enumerate original enabled registrations even after their owner removed its locator.
 * Pagination counts scanned registry keys, including disabled or damaged entries. */
export function readRecoverableRuntimeScopes(homeRoot: string,
  options: { readonly afterScopeKey?: string; readonly limit?: number } = {}): RuntimeResult<{
    scopes: RuntimeScopePaths[]; issues: { scopeKey: string; reason: string }[]; nextCursor?: string;
  }> {
  const limit = options.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64
    || options.afterScopeKey !== undefined && !/^[0-9a-f]{64}$/u.test(options.afterScopeKey)) {
    return runtimeFailure("runtime_record_invalid", "runtime discovery page must use a hexadecimal scope cursor and a limit from 1 to 64");
  }

  const registry = readRuntimeRegistry(homeRoot);
  if (!registry.ok) return registry;

  if (registry.value === undefined) return { ok: true, value: { scopes: [], issues: [] } };

  const entries = registry.value.entries.filter(key => options.afterScopeKey === undefined || key > options.afterScopeKey);
  const page = entries.slice(0, limit), scanned = scanRuntimeRegistry(registry.value, page, "recoverable");

  return { ok: true, value: { ...scanned, ...(entries.length > page.length ? { nextCursor: page.at(-1)! } : {}) } };
}

type RuntimeRegistry = { readonly home: string; readonly directory: string; readonly physicalDirectory: string; readonly entries: readonly string[] };

type RuntimeDiscoveryMode = "existing_owner" | "recoverable";

function readRuntimeRegistry(homeRoot: string): RuntimeResult<RuntimeRegistry | undefined> {
  let home: string;

  try { home = canonicalRuntimeRoot(homeRoot); }
  catch { return runtimeFailure("runtime_record_invalid", "runtime home must be a canonical absolute root"); }

  const directory = path.join(home, "learning", "runtime");
  let physicalDirectory: string, entries: string[];

  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return runtimeFailure("runtime_record_invalid", "runtime registry must be an original directory");
    }

    physicalDirectory = path.join(realpathSync.native(home), "learning", "runtime");

    if (!sameRoot(realpathSync.native(directory), physicalDirectory)) {
      return runtimeFailure("runtime_scope_mismatch", "runtime registry escapes its original home");
    }

    entries = readdirSync(directory).filter(name => /^[0-9a-f]{64}$/.test(name)).sort();
  } catch (error) {
    if (isLockIoCode(error, "ENOENT")) return { ok: true, value: undefined };
    return runtimeFailure("runtime_io_failed", "runtime registry could not be read");
  }

  return { ok: true, value: { home, directory, physicalDirectory, entries } };
}

function scanRuntimeRegistry(registry: RuntimeRegistry, entries: readonly string[], mode: RuntimeDiscoveryMode): {
  scopes: RuntimeScopePaths[]; issues: { scopeKey: string; reason: string }[];
} {
  const scopes: RuntimeScopePaths[] = [], issues: { scopeKey: string; reason: string }[] = [];

  for (const scopeKey of entries) {
    const result = readRegisteredRuntimeScope(registry, scopeKey, mode);
    if (!result.ok) issues.push({ scopeKey, reason: result.reason });
    else if (result.value !== undefined) scopes.push(result.value);
  }

  return { scopes, issues };
}

function readRegisteredRuntimeScope(registry: RuntimeRegistry, scopeKey: string, mode: RuntimeDiscoveryMode):
RuntimeResult<RuntimeScopePaths | undefined> | { readonly ok: false; readonly reason: "runtime_intent_missing" } {
  const { home, directory, physicalDirectory } = registry, entry = path.join(directory, scopeKey);
  const boundary = originalRuntimeDirectory(directory, physicalDirectory, entry, scopeKey);
  if (!boundary.ok) return boundary;

  const original = readRecord(path.join(entry, "intent.json"), isRuntimeIntent);
  if (!original.ok) return original;

  if (original.value === undefined) return { ok: false, reason: "runtime_intent_missing" };

  const paths = runtimeScopePaths(original.value.homeRoot, original.value.workspaceRoot);
  if (!sameRoot(paths.homeRoot, home) || paths.scopeKey !== scopeKey || !sameRoot(paths.directory, entry)) {
    return runtimeFailure("runtime_scope_mismatch", "runtime registration does not identify its original home and scope");
  }

  const intent = readRuntimeIntent(paths);
  if (!intent.ok) return intent;

  if (intent.value === undefined) return { ok: false, reason: "runtime_intent_missing" };

  if (!intent.value.enabled) return { ok: true, value: undefined };

  if (mode === "existing_owner") {
    const locator = readRuntimeLocator(paths);
    if (!locator.ok) return locator;
    if (locator.value === undefined) return { ok: true, value: undefined };
  }

  const finalBoundary = originalRuntimeDirectory(directory, physicalDirectory, entry, scopeKey);

  return finalBoundary.ok ? { ok: true, value: paths } : finalBoundary;
}

function originalRuntimeDirectory(directory: string, physicalDirectory: string, entry: string, scopeKey: string): RuntimeResult<true> {
  try {
    const root = lstatSync(directory), candidate = lstatSync(entry);
    if (!root.isDirectory() || root.isSymbolicLink() || !candidate.isDirectory() || candidate.isSymbolicLink()) {
      return runtimeFailure("runtime_record_invalid", "runtime discovery requires original directories");
    }

    if (!sameRoot(realpathSync.native(directory), physicalDirectory)
      || !sameRoot(realpathSync.native(entry), path.join(physicalDirectory, scopeKey))) {
      return runtimeFailure("runtime_scope_mismatch", "runtime scope escapes its original registry");
    }

    return runtimeSuccess();
  } catch { return runtimeFailure("runtime_io_failed", "runtime scope directory could not be read"); }
}

/** A process lifetime lock in this runtime's directory; no Board writer is held by this owner. */
export function tryAcquireRuntimeOwner(paths: RuntimeScopePaths, options: BoardLockOptions = {}): RuntimeResult<RuntimeOwner> {
  const pid = options.ownerPid ?? process.pid;
  try { mkdirSync(paths.directory, { recursive: true }); }
  catch { return runtimeFailure("runtime_io_failed", "runtime directory could not be created"); }
  const lock = tryAcquireLock(paths.ownerLockPath, { ...options, ownerPid: pid });
  if ("ok" in lock) return runtimeFailure(lock.reason === "multi_writer" ? "runtime_owner_busy" : "runtime_io_failed", lock.detail);
  return { ok: true, value: createOwner(paths, pid, lock) };
}

function createOwner(paths: RuntimeScopePaths, pid: number, lock: LockHandle): RuntimeOwner {
  let open = true, temporarySequence = 0;
  const owns = () => open && ownsLock(lock);
  const lost = () => runtimeFailure("runtime_owner_lost", "runtime owner no longer holds its process lock");
  const persist = (file: string, value: unknown): RuntimeResult<true> => {
    if (!owns()) return lost();
    temporarySequence++;
    const temporary = path.join(paths.directory, `.${path.basename(file)}.${lockToken(lock)}-${temporarySequence}.tmp`);
    return atomicReplace(file, temporary, value, owns);
  };

  return {
    pid, owns,
    writeIntent(value) {
      if (!owns()) return lost();
      try {
        if (!isRuntimeIntent(value)) return runtimeFailure("runtime_record_invalid", "runtime intent shape is invalid");
        if (!sameRoot(value.homeRoot, paths.homeRoot) || !sameRoot(value.workspaceRoot, paths.workspaceRoot)) {
          return runtimeFailure("runtime_scope_mismatch", "runtime intent roots do not match its scope");
        }
        const previous = readRuntimeIntent(paths);
        return previous.ok ? persist(paths.intentPath, value) : previous;
      } catch { return runtimeFailure("runtime_record_invalid", "runtime intent could not be validated"); }
    },
    writeLocator(value) {
      if (!owns()) return lost();
      try {
        if (!isRuntimeLocator(value)) return runtimeFailure("runtime_record_invalid", "runtime locator shape is invalid");
        if (value.scopeKey !== paths.scopeKey || value.pid !== pid) {
          return runtimeFailure("runtime_scope_mismatch", "runtime locator does not identify this scope owner");
        }
        const previous = readRuntimeLocator(paths);
        return previous.ok ? persist(paths.locatorPath, value) : previous;
      } catch { return runtimeFailure("runtime_record_invalid", "runtime locator could not be validated"); }
    },
    clearLocator() {
      if (!owns()) return lost();

      const current = readRuntimeLocator(paths);
      if (!current.ok) return current;

      if (!owns()) return lost();

      try {
        unlinkSync(paths.locatorPath);
        return runtimeSuccess();
      }
      catch (error) { return isLockIoCode(error, "ENOENT") ? runtimeSuccess()
        : runtimeFailure("runtime_io_failed", "runtime locator could not be removed"); }
    },
    close() {
      if (!open) return runtimeSuccess();
      open = false;
      try {
        releaseLock(lock);
        return runtimeSuccess();
      }
      catch { return runtimeFailure("runtime_io_failed", "runtime owner lock could not be released"); }
    },
  };
}

function readRecord<T>(file: string, guard: (value: unknown) => value is T): RuntimeResult<T | undefined> {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) {
      return runtimeFailure("runtime_record_invalid", "runtime record must be a bounded regular file");
    }

    fd = openSync(file, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) return runtimeFailure("runtime_record_invalid", "runtime record size is invalid");

    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));

    return guard(value) ? { ok: true, value } : runtimeFailure("runtime_record_invalid", "runtime record shape is invalid");
  } catch (error) {
    if (isLockIoCode(error, "ENOENT")) return { ok: true, value: undefined };
    return error instanceof SyntaxError ? runtimeFailure("runtime_record_invalid", "runtime record JSON is invalid")
      : runtimeFailure("runtime_io_failed", "runtime record could not be read");
  } finally {
    if (fd !== undefined) closePrivateFd(fd);
  }
}

/** Complete fsynced bytes precede the atomic rename; the final fence has no intervening await. */
function atomicReplace(file: string, temporary: string, value: unknown, owns: () => boolean): RuntimeResult<true> {
  let fd: number | undefined, temporaryCreated = false;
  try {
    const body = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) return runtimeFailure("runtime_record_invalid", "runtime record exceeds its byte limit");

    if (!owns()) return runtimeFailure("runtime_owner_lost", "runtime owner lost its process lock before writing");

    fd = openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (!owns()) return runtimeFailure("runtime_owner_lost", "runtime owner lost its process lock before publication");

    renameSync(temporary, file);
    temporaryCreated = false;

    return runtimeSuccess();
  } catch {
    return runtimeFailure("runtime_io_failed", "runtime record could not be atomically published");
  } finally {
    if (fd !== undefined) closePrivateFd(fd);
    if (temporaryCreated) {
      try { unlinkSync(temporary); }
      catch { /* Cleanup contract: preserve an unremovable private temp as evidence; readers never consume it. */ }
    }
  }
}

function sameRoot(left: string, right: string): boolean { return runtimePathIdentity(left) === runtimePathIdentity(right); }

function closePrivateFd(fd: number): void {
  try { closeSync(fd); }
  catch { /* Cleanup contract: descriptor cleanup cannot replace the typed read/publication outcome. */ }
}
