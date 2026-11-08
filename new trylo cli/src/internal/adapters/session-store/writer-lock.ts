import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export type ProcessStatus = "alive" | "dead" | "unknown";

export type WriterIdentity = { readonly pid: number; readonly token: string };

export type WriterLock = {
  readonly path: string;
  readonly identity: WriterIdentity;
  readonly processStatus: (pid: number) => ProcessStatus;
};

function read(file: string): string | undefined {
  try {
    const info = lstatSync(file);
    return info.isFile() && info.size <= 512 ? readFileSync(file, "utf8").trim() : undefined;
  } catch { return undefined; /* Unreadable/redirected ownership is never guessed. */ }
}

function ownerPid(text: string | undefined): number | undefined {
  if (text === undefined || text.length > 512) return undefined;

  if (/^[1-9]\d*$/.test(text)) {
    const pid = Number(text);
    return Number.isSafeInteger(pid) ? pid : undefined;
  }

  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const owner = value as Record<string, unknown>;
    return Object.keys(owner).sort().join(",") === "pid,token" && typeof owner.pid === "number"
      && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token.length > 0
      ? owner.pid : undefined;
  } catch { return undefined; /* Malformed/legacy unknown owners stay locked. */ }
}

function create(file: string, stamp: string): boolean {
  try {
    const handle = openSync(file, "wx");
    try {
      writeFileSync(handle, stamp + "\n");
      fsyncSync(handle);
    } finally { closeSync(handle); }
    return true;
  } catch { return false; /* Creation is exclusive; failure grants no ownership. */ }
}

export function ownsWriterLock(lock: WriterLock): boolean {
  return read(lock.path) === JSON.stringify(lock.identity);
}

export function releaseWriterLock(lock: WriterLock): void {
  if (!ownsWriterLock(lock)) return;
  try { unlinkSync(lock.path); } catch { /* A lost/unavailable lock grants no further writes. */ }
}

/** Reclaim only a provably dead owner under an exclusive reclaim guard. Normal
 * contenders can only create with wx: if one wins the freed slot, we refuse.
 * Unknown owners and abandoned reclaim guards require explicit recovery.
 */
export function acquireWriterLock(lock: WriterLock): boolean {
  const stamp = JSON.stringify(lock.identity);
  if (create(lock.path, stamp)) return true;

  const guard = { ...lock, path: lock.path + ".reclaim" };
  if (!create(guard.path, stamp)) return false;

  try {
    // Re-read the same owner under the guard before removing its stale lock.
    const previous = read(lock.path), pid = ownerPid(previous);
    if (pid === undefined || lock.processStatus(pid) !== "dead" || read(lock.path) !== previous) return false;
    try { unlinkSync(lock.path); } catch { return false; /* Failed reclamation cannot grant ownership. */ }
    return create(lock.path, stamp);
  } finally { releaseWriterLock(guard); }
}
