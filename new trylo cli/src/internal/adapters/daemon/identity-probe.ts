import { execFile } from "node:child_process";
import { observeDarwinProcess } from "../process-session/darwin-process.js";

import {
  verifyIdentity,
  type DaemonIdentity,
  type DaemonIdentityProbe,
  type IdentityVerdict,
} from "../../domain/daemon-identity.js";

/**
 * The platform answer to "when did this pid start" (WP26 / A04).
 *
 * ## What each platform can actually do
 *
 * Measured on this host (win32, Node v22.22.2 —
 * `evidence/2026-10-07-WP26-review/process-identity.out.txt`):
 *
 *  - **win32**: `Win32_Process.CreationDate` via PowerShell. Verified to work,
 *    ~200–600 ms per call. `wmic` does not work on this host, so it is not a
 *    fallback.
 *  - **darwin**: BSD `ps` reports the process start time and group in one query.
 *
 * ## Why the probe is a seam and not an import
 *
 * The domain module must not spawn PowerShell. Injecting the probe keeps the
 * decision ("is this still my daemon?") pure and testable without a process
 * table, and gives a platform that can read start times another way in.
 */

const POWERSHELL_TIMEOUT_MS = 5_000;

/** One CIM query for one pid. Rejects when the answer is not usable. */
function queryWin32CreationDate(pid: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      `if ($null -eq $p) { exit 3 }; ` +
      `$p.CreationDate.ToUniversalTime().ToString("o")`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          // Exit code 3 is the script's own "no such process", which is an
          // answer rather than a failure. Node reports it as an error, so it is
          // told apart by the child's own exit code.
          const code = (error as { code?: unknown }).code;
          if (code === 3) {
            reject(new Error(`no process with pid ${pid}`));
            return;
          }

          reject(new Error(`PowerShell query failed: ${stderr.trim() || error.message}`));

          return;
        }

        const value = stdout.trim();
        if (value.length === 0) {
          reject(new Error(`PowerShell returned nothing for pid ${pid}`));
          return;
        }

        resolvePromise(value);
      },
    );
  });
}

/**
 * Build the win32 probe.
 *
 * The returned probe is reusable: each call is one PowerShell invocation, so a
 * caller should verify at most one candidate per query rather than sweeping the
 * table. {@link verifyDaemonOnce} does exactly that.
 */
export function createWin32IdentityProbe(): DaemonIdentityProbe {
  return {
    async observe(pid: number): Promise<DaemonIdentity | undefined> {
      try {
        const iso = await queryWin32CreationDate(pid);
        const startedAtMs = Date.parse(iso);
        if (Number.isNaN(startedAtMs)) {
          throw new Error(`unparseable CreationDate '${iso}'`);
        }
        return { pid, startedAtMs };
      } catch (error: unknown) {
        // "no such process" is a real answer and maps to `undefined`; anything
        // else must keep propagating so `verifyIdentity` can report
        // `unverifiable` rather than silently concluding the daemon is gone.
        if (error instanceof Error && error.message.startsWith("no process with pid")) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

/**
 * The probe for this platform, or an explicit refusal.
 *
 * A refusal is thrown rather than returned as a "probe that always fails",
 * because a caller that swallowed it would get `unverifiable` on every call and
 * have no way to tell that from a transient system problem.
 */
export function createProcessIdentityProbe(platform: string): DaemonIdentityProbe {
  if (platform === "win32") {
    return createWin32IdentityProbe();
  }
  if (platform === "darwin") return { observe: observeDarwinProcess };
  throw new Error(`no process start-time reader for platform '${platform}'`);
}

/**
 * Verify one candidate identity.
 *
 * Exists so the "call the probe at most once per verification" discipline is
 * visible at the call site. The win32 probe costs 200-600ms per call, so a
 * caller that sweeps a process table through it would stall for seconds; this
 * narrows the contract to one probe call per verification.
 */
export function verifyDaemonOnce(
  probe: DaemonIdentityProbe,
  recorded: DaemonIdentity,
): Promise<IdentityVerdict> {
  return verifyIdentity(recorded, probe);
}
