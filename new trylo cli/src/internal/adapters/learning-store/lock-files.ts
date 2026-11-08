import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type LockStamp = {
  readonly formatVersion: 1;
  readonly role: "writer" | "intent";
  readonly pid: number;
  readonly token: string;
};

export type StampRead = { readonly kind: "missing" } | { readonly kind: "invalid" } | { readonly kind: "valid"; readonly stamp: LockStamp };

/** The target is published only after its complete payload was fsynced on this volume. */
export function publishStamp(target: string, stamp: LockStamp, link: (source: string, target: string) => void = linkSync): number | undefined {
  // Preparation artifacts are never mistaken for published recovery intents.
  const prepared = path.join(path.dirname(target), `.${path.basename(target)}.prepared-${stamp.token}`);
  const fd = openSync(prepared, "wx", 0o600);
  let published = false;

  try {
    writeFileSync(fd, `${JSON.stringify(stamp)}\n`, "utf8");
    fsyncSync(fd);

    try {
      link(prepared, target);
      published = true;
      return fd;
    } catch (error) {
      if (isLockIoCode(error, "EEXIST")) return undefined;
      // No empty wx fallback: unsupported hardlinks/volumes/permissions are IO failure.
      throw error;
    }
  } finally {
    try {
      unlinkSync(prepared);
    } finally {
      if (!published) closeSync(fd);
    }
  }
}

export function readStamp(file: string): StampRead {
  let fd: number | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_048) return { kind: "invalid" };

    fd = openSync(file, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 2_048) return { kind: "invalid" };

    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!isStamp(value)) return { kind: "invalid" };

    return { kind: "valid", stamp: value };
  } catch (error) {
    if (isLockIoCode(error, "ENOENT")) return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "invalid" };
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isStamp(value: unknown): value is LockStamp {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 4 && "formatVersion" in value && value.formatVersion === 1 &&
    "role" in value && (value.role === "writer" || value.role === "intent") &&
    "pid" in value && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    "token" in value && typeof value.token === "string" && /^[a-zA-Z0-9-]{8,128}$/.test(value.token);
}

export function isLockIoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
