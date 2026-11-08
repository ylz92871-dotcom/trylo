import { existsSync } from "node:fs";
import type { IsolationAvailability } from "../../ports/isolation.js";
import { acquireWindowsAclLease, type WindowsAclLease } from "./windows-acl-lease.js";
import { DISPATCH_ARG, SRT_WIN, loadVendor, type VendorWindowsApi } from "./sandbox-vendor.js";
import { hostShellEnvironment } from "./executable.js";
import { isolationCleanupError } from "./windows-isolation-error.js";
import { existingWindowsHelper } from "./windows-helper-cache.js";

export type WindowsReadinessConfig = {
  readonly helperPath?: string;
  readonly vendorApi?: VendorWindowsApi;
  readonly readableExecutable?: (program: string) => boolean;
};

type PreparedIsolation =
  | { readonly availability: Extract<IsolationAvailability, { state: "ready" }>; readonly lease: WindowsAclLease }
  | { readonly availability: Exclude<IsolationAvailability, { state: "ready" }>; readonly lease?: never };

/** The helper's restricted child must be able to read its own private installation. */
export async function prepareWindowsIsolation(writableRoots: readonly string[], config: WindowsReadinessConfig = {}, cancelled: () => boolean = () => false): Promise<PreparedIsolation> {
  const helper = config.helperPath ?? (hostShellEnvironment().platform === "win32" ? existingWindowsHelper() : SRT_WIN);
  const broken = (reason: string): PreparedIsolation => ({ availability: { state: "broken", backend: "windows-srt", reason } });
  const platform = hostShellEnvironment().platform;
  if (platform !== "win32") return { availability: { state: "unavailable", reason: `windows-srt isolation runs only on Windows; this machine reports ${platform}` } };

  if (!existsSync(helper)) return broken(`the srt-win helper is missing at ${helper}; the vendored copy was not deployed`);

  const handle = { exe: helper, prependArgs: [DISPATCH_ARG] };
  let api: VendorWindowsApi;

  try {
    api = config.vendorApi ?? await loadVendor();
    const status = await api.checkWindowsSandboxStatusAsync({ srtWin: handle });
    if (status.user?.provisioned !== true || status.user.credPresent !== true) {
      return { availability: { state: "not_installed", backend: "windows-srt", installHint: `run "${helper} ${DISPATCH_ARG} install" once, as administrator` } };
    }
    if (status.wfp?.state !== "installed" && status.wfp?.state !== "cannot-read") return broken(`the sandbox account exists but the WFP egress fence is ${status.wfp?.state ?? "absent"}`);
  } catch (error) { return broken(`the sandbox readiness probe failed: ${messageOf(error)}`); }

  // This is the execution owner's lease, not a second bootstrap ACL owner.
  // No workspace write permission is granted until behavioural WFP proof.
  const lease = await acquireWindowsAclLease([], handle, api, config.readableExecutable);

  try {
    if (cancelled()) throw new Error("isolation_cancelled: command was not run");

    lease.readExecutable(helper);
    const proof = await api.verifyWindowsWfpEgress({ srtWin: handle });
    if (proof.target.length === 0) throw new Error("the WFP egress verification returned no probe target; the fence was not proven");

    if (cancelled()) throw new Error("isolation_cancelled: command was not run");

    if (writableRoots.length > 0) lease.writeRoots(writableRoots);

    return { availability: { state: "ready", backend: "windows-srt", evidence: "srt-sandbox provisioned; a direct connect as the sandbox account is refused (egress_probe=blocked)" }, lease };
  } catch (error) {
    try { lease.close(); }
    catch (cleanup) { throw isolationCleanupError("bootstrap lease", error, cleanup); }
    return broken(`the WFP egress probe or approved write grant did not complete: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
