import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpRegistryFailure, McpScope, McpServerEntry } from "../../ports/mcp-registry.js";
import { decodeDocument, emptyDocument, encodeDocument, type RegistryDocument } from "./document.js";

/**
 * How one registry file is locked, read and replaced.
 *
 * The storage rules exist because this is a *document*, not an event log:
 *
 *  - **Whole-file replace.** Appending to a document makes "the file has two
 *    `formatVersion` keys" representable, and there is no reason to allow it.
 *  - **Rename, not truncate.** The new bytes are written to a sibling temporary
 *    file and renamed into place, so a reader sees the old document or the new
 *    one, never a half-written one. A crash leaves an abandoned temp file at
 *    worst.
 *  - **One writer.** A lock file beside the document is created with `wx`, so
 *    the second writer is refused rather than interleaving. The lock is not
 *    stolen when stale: only the process that took it releases it, because
 *    guessing that a lock is stale is how two writers end up believing they
 *    both own the file.
 *  - **Fail closed on read.** A document that cannot be decoded raises the
 *    error. It is never collapsed into "no servers", which would make the next
 *    write destroy whatever the file really contained.
 */

export type McpRegistryPaths = {
  readonly userFile: string;
  readonly projectFile: string;
};

export type McpRegistryStoreConfig = McpRegistryPaths & {
  /** A supplied run document must exist; absent user/project registries remain valid. */
  readonly required?: boolean;
  /** Injected so tests do not need a real clock of their own. */
  readonly now?: () => string;
};

/** One writer's view of the two files, including the locks it currently holds. */
export type RegistryIo = {
  readonly config: McpRegistryStoreConfig;
  /** Which locks this instance holds, so release is never a blind unlink. */
  readonly held: Set<McpScope>;
};

export type LoadedScope =
  | { readonly ok: true; readonly document: RegistryDocument; readonly existed: boolean }
  | McpRegistryFailure;

export function createRegistryIo(config: McpRegistryStoreConfig): RegistryIo {
  return { config, held: new Set<McpScope>() };
}

export function fileFor(io: RegistryIo, scope: McpScope): string {
  return scope === "user" ? io.config.userFile : io.config.projectFile;
}

export function lockFor(io: RegistryIo, scope: McpScope): string {
  return `${fileFor(io, scope)}.lock`;
}

export function acquireLock(io: RegistryIo, scope: McpScope): McpRegistryFailure | undefined {
  if (io.held.has(scope)) {
    return { ok: false, code: "lock_conflict", detail: `${scope} registry is already locked by this writer` };
  }

  const lockPath = lockFor(io, scope);

  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return { ok: false, code: "directory_unavailable", detail: `cannot create ${path.dirname(lockPath)}` };
  }

  try {
    const handle = openSync(lockPath, "wx");

    try {
      writeFileSync(handle, `${process.pid}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    io.held.add(scope);

    return undefined;
  } catch {
    return { ok: false, code: "lock_conflict", detail: `${fileFor(io, scope)} is locked by another writer` };
  }
}

export function releaseLock(io: RegistryIo, scope: McpScope): void {
  if (!io.held.delete(scope)) {
    return;
  }
  try {
    unlinkSync(lockFor(io, scope));
  } catch {
    // Losing the lock file is not worth failing a write that already landed.
  }
}

export function loadScope(io: RegistryIo, scope: McpScope): LoadedScope {
  const file = fileFor(io, scope);
  if (!existsSync(file)) {
    if (io.config.required) return { ok: false, code: "read_failed", detail: `${file} does not exist` };
    return { ok: true, document: emptyDocument(), existed: false };
  }

  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: false, code: "read_failed", detail: `${file} could not be read` };
  }

  if (raw.trim().length === 0) {
    // Zero bytes is a file somebody created and never finished, not a
    // registry with no servers.
    return { ok: false, code: "invalid_document", detail: `${file} is empty` };
  }

  const decoded = decodeDocument(raw, file);

  return decoded.ok ? { ok: true, document: decoded.value, existed: true } : decoded;
}

/**
 * Writes the whole document through a temporary sibling and a rename.
 *
 * `formatVersion` is stamped by the encoder rather than carried from the
 * loaded document, so the on-disk version can only ever be the one this
 * build understands.
 */
export function storeScope(
  io: RegistryIo,
  scope: McpScope,
  servers: ReadonlyArray<McpServerEntry>,
): McpRegistryFailure | undefined {
  const file = fileFor(io, scope);
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    // `wx`: the temporary name is fresh, so an existing file means something
    // is wrong and truncating it would be the wrong way to find out.
    writeFileSync(temporary, encodeDocument(servers), { encoding: "utf8", flag: "wx" });
    // fsync the contents before the rename so the name never points at
    // bytes that have not reached disk.
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
    renameSyncOver(temporary, file);
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

/**
 * Replaces the document in one step.
 *
 * The rename is what makes "the file is either the old document or the new one"
 * true: a reader either opens the old bytes or the new ones, and a crash leaves
 * at most an abandoned temporary file.
 */
function renameSyncOver(from: string, to: string): void {
  renameSync(from, to);
}
