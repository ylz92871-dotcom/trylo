import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CredentialFailure,
  CredentialLedgerDocument,
  CredentialScope,
} from "../../ports/credentials.js";
import { decodeDocument, encodeDocument, emptyDocument } from "../../credentials/document.js";
import type { FileScope, LedgerReadResult, LedgerStore } from "../../credentials/ledger-store.js";

/**
 * The file-backed ledger store: one JSON document per scope, replaced wholesale.
 *
 * Storage rules, each addressing a specific way a ledger goes wrong:
 *
 *  - **Whole-file replace through tmp + fsync + rename.** Appending to a ledger
 *    would make "the file has two `records` arrays" representable; renaming a
 *    fully written sibling means a reader sees the old ledger or the new one,
 *    never a half-written one, and a crash leaves at most an abandoned temp file.
 *  - **One writer, refused not queued.** The lock is created with `wx`, so a
 *    second writer gets `lock_conflict` immediately (WP §2.5: 显式码，禁止死等).
 *    A stale lock is *not* stolen: only the holder releases it, because guessing
 *    a lock is stale is how two writers both believe they own the file.
 *  - **0600 on POSIX.** A credential file that is group- or world-readable is a
 *    leak. Reading such a file raises `credentials_insecure` for that scope only
 *    (other scopes still work) — refuse the read, do not silently accept it.
 *  - **No `..` escape.** Both roots are resolved before use and a resolved path
 *    that leaves its root is `path_escape`, so a `homeDir` of `{home}/..` cannot
 *    write outside the directory the caller named.
 *  - **Fail closed on decode.** A corrupt file is never collapsed into "no
 *    credentials", which would let the next write destroy what it held.
 */

export const USER_LEDGER_RELATIVE = "credentials.json";
export const PROJECT_LEDGER_RELATIVE = path.join(".trylo", "credentials.json");

export type FileStoreConfig = {
  readonly homeDir: string;
  /** Absent means there is no project layer here; that is *missing*, not an error. */
  readonly projectDir?: string | undefined;
};

export type FileStorePaths = {
  readonly userFile: string;
  readonly projectFile?: string | undefined;
};

/** Resolve the ledger path for a scope, or fail on an escape. */
export function ledgerPath(
  config: FileStoreConfig,
  scope: FileScope,
): { readonly ok: true; readonly path: string } | CredentialFailure {
  if (scope === "user") {
    const candidate = path.join(path.resolve(config.homeDir), USER_LEDGER_RELATIVE);
    return guardWithin(path.resolve(config.homeDir), candidate, "homeDir");
  }

  if (config.projectDir === undefined) {
    return { ok: false, code: "path_escape", detail: "no project directory is configured" };
  }

  const root = path.resolve(config.projectDir);
  const candidate = path.join(root, PROJECT_LEDGER_RELATIVE);

  return guardWithin(root, candidate, "projectDir");
}

function guardWithin(
  root: string,
  candidate: string,
  label: string,
): { readonly ok: true; readonly path: string } | CredentialFailure {
  const resolved = path.resolve(candidate);
  const rel = path.relative(root, resolved);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      ok: false,
      code: "path_escape",
      detail: `${label} resolves outside its root (${candidate})`,
    };
  }

  return { ok: true, path: resolved };
}

export function createFileLedgerStore(config: FileStoreConfig): LedgerStore {
  const held = new Set<FileScope>();
  return {
    read: (scope) => readScope(config, scope),
    write: (scope, document) => writeScope(config, scope, document, held),
  };
}

function readScope(config: FileStoreConfig, scope: CredentialScope): LedgerReadResult {
  if (scope !== "user" && config.projectDir === undefined) {
    return { ok: true, document: emptyDocument(), existed: false };
  }

  const located = ledgerPath(config, scope as FileScope);
  if (!located.ok) {
    return located;
  }

  const file = located.path;
  if (!existsSync(file)) {
    return { ok: true, document: emptyDocument(), existed: false };
  }

  const insecure = insecureCheck(file);
  if (insecure !== undefined) {
    return insecure;
  }

  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: false, code: "read_failed", detail: `${file} could not be read` };
  }

  if (raw.trim().length === 0) {
    return { ok: false, code: "credentials_corrupt", detail: `${file} is empty` };
  }

  const decoded = decodeDocument(raw, file);

  return decoded.ok ? { ok: true, document: decoded.value, existed: true } : decoded;
}

/**
 * POSIX-only permission check. Windows has no equivalent 0600 mode through
 * `statSync`, so on win32 this returns `undefined` and the caller proceeds; the
 * gap is recorded in `AUTH-QUALITY-AUDIT.md` rather than pretended covered.
 */
function insecureCheck(file: string): CredentialFailure | undefined {
  if (process.platform === "win32") {
    return undefined;
  }

  try {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        ok: false,
        code: "credentials_insecure",
        detail: `${file} is readable by group or others (mode ${mode.toString(8)})`,
      };
    }
  } catch {
    return { ok: false, code: "read_failed", detail: `${file} could not be inspected` };
  }

  return undefined;
}

function writeScope(
  config: FileStoreConfig,
  scope: CredentialScope,
  document: CredentialLedgerDocument,
  held: Set<FileScope>,
): CredentialFailure | undefined {
  const located = ledgerPath(config, scope as FileScope);
  if (!located.ok) {
    return located;
  }

  const file = located.path;
  const lock = `${file}.lock`;
  const lockFailure = acquire(lock, scope as FileScope, held);
  if (lockFailure !== undefined) {
    return lockFailure;
  }

  try {
    return replace(file, encodeDocument(document));
  } finally {
    release(lock, scope as FileScope, held);
  }
}

function acquire(lock: string, scope: FileScope, held: Set<FileScope>): CredentialFailure | undefined {
  if (held.has(scope)) {
    return { ok: false, code: "lock_conflict", detail: `${scope} ledger is already locked by this writer` };
  }

  try {
    mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    return { ok: false, code: "directory_unavailable", detail: `cannot create ${path.dirname(lock)}` };
  }

  try {
    const handle = openSync(lock, "wx");

    try {
      writeFileSync(handle, `${process.pid}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    held.add(scope);

    return undefined;
  } catch {
    return { ok: false, code: "lock_conflict", detail: `${lock} is held by another writer` };
  }
}

function release(lock: string, scope: FileScope, held: Set<FileScope>): void {
  if (!held.delete(scope)) {
    return;
  }
  try {
    unlinkSync(lock);
  } catch {
    // Losing the lock file is not worth failing a write that already landed.
  }
}

function replace(file: string, text: string): CredentialFailure | undefined {
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const handle = openSync(temporary, "r+");

    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    discard(temporary);
    return { ok: false, code: "write_failed", detail: `${file} could not be written` };
  }

  try {
    renameSync(temporary, file);
  } catch {
    discard(temporary);
    return { ok: false, code: "write_failed", detail: `${file} could not be replaced` };
  }

  return undefined;
}

function discard(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // An abandoned temp file is harmless; failing the write twice is not.
  }
}

/** `lstatSync` guard so a symlink to a directory is not mistaken for a ledger. */
export function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}/** Exposed for the port's `exportPublic`/`status` assembly, which needs the paths. */

export function describePaths(config: FileStoreConfig): FileStorePaths {
  const user = ledgerPath(config, "user");
  const project = config.projectDir === undefined ? undefined : ledgerPath(config, "project");
  return {
    userFile: user.ok ? user.path : "",
    projectFile: project !== undefined && project.ok ? project.path : undefined,
  };
}
