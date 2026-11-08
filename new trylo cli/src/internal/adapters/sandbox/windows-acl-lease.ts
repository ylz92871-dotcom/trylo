import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { loadVendor, type SrtWinHandle, type VendorWindowsApi } from "./sandbox-vendor.js";
import { acquireAclOwner } from "./windows-acl-owner.js";
import { hasPublicExecutableRead } from "./windows-public-read.js";
import { isolationCleanupError } from "./windows-isolation-error.js";

const RELEASED = new Set(["revoked", "stillHeld", "restored", "alreadyOriginal"]);

/** Validate the helper's observed per-path outcomes, including malformed output. */
export function requireAclRelease(outcomes: unknown): void {
  if (!Array.isArray(outcomes) || outcomes.some(item => item === null || typeof item !== "object" || typeof item.path !== "string" || !RELEASED.has(item.status))) {
    throw new Error("isolation_cleanup_failed: ACL revocation was missing, malformed or anomalous; inspect srt-win acl recover");
  }
}

export type WindowsAclLease = {
  readonly helperPath: string;
  readonly readExecutable: (program: string) => void;
  readonly writeRoots: (roots: readonly string[]) => void;
  readonly close: () => void;
};

/** One owner of grants and compensation for both CLI execution and IsolationPort. */
export async function acquireWindowsAclLease(writableRoots: readonly string[], handle: SrtWinHandle, vendor?: VendorWindowsApi, readable = hasPublicExecutableRead): Promise<WindowsAclLease> {
  const api = vendor ?? await loadVendor();
  const user = await api.getWindowsSandboxUserStatusAsync({ srtWin: handle });
  const sid = user.sid;
  if (sid === undefined || sid.length === 0) throw new Error("isolation_broken: sandbox identity is missing");

  const releaseOwner = acquireAclOwner();
  const revoke = () => requireAclRelease(api.revokeWindowsAcl({ sandboxUserSid: sid, srtWin: handle }));

  try {
    api.grantWindowsAcl({ read: [], write: writableRoots.map(root => realpathSync.native(root)), sandboxUserSid: sid, srtWin: handle });
  } catch (error) {
    try { revoke(); }
    catch (cleanup) { throw isolationCleanupError("partial grant", error, cleanup); }
    releaseOwner();
    throw error;
  }

  let closed = false;
  const readPrograms = new Set<string>();

  return {
    helperPath: handle.exe,
    writeRoots(roots) {
      if (closed) throw new Error("isolation_closed: no new write grant");
      api.grantWindowsAcl({ read: [], write: roots.map(root => realpathSync.native(root)), sandboxUserSid: sid, srtWin: handle });
    },
    readExecutable(program) {
      if (closed) throw new Error("isolation_closed: no new read grant");
      const actual = realpathSync.native(program);
      if (readPrograms.has(actual)) return;
      if (!readable(actual)) api.grantWindowsAcl({ read: [dirname(actual)], write: [], sandboxUserSid: sid, srtWin: handle });
      readPrograms.add(actual);
    },
    close() {
      if (closed) return;
      revoke();
      closed = true;
      releaseOwner();
    },
  };
}
