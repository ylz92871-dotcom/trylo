import { spawn, type ChildProcess } from "node:child_process";
import type {
  IsolationAvailability,
  IsolationDiagnostic,
  IsolationFailureCode,
  IsolationNetworkPolicy,
  IsolationPort,
  IsolationRequest,
  IsolationOutcome,
} from "../../ports/isolation.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { hostProcessEnvironment, hostShellEnvironment } from "./executable.js";
import { prepareWindowsIsolation, type WindowsReadinessConfig } from "./windows-readiness.js";
import { DISPATCH_ARG } from "./sandbox-vendor.js";
import { prepareWindowsHelper } from "./windows-helper-cache.js";

/**
 * Windows OS isolation, backed by the vendored `srt-win` helper.
 *
 * ## What actually enforces the boundary
 *
 * `srt-win install` provisions a dedicated `srt-sandbox` account and a
 * SID-keyed WFP filter set. `srt-win exec` then launches the child under that
 * account with a restricted token (LUA, Administrators deny-only, medium
 * integrity, privileges stripped except `SeChangeNotify`), inside a
 * kill-on-close job with a UI lockdown and a non-interactive desktop.
 *
 * The WFP fence is what gives a domain allowlist teeth: a direct TCP connect
 * from the sandbox account is refused at the kernel with `WSAEACCES`
 * (os error 10013), so traffic has to go through the allowlisting proxy rather
 * than around it. Verified on this machine — see
 * `evidence/2026-10-04-WP04-probes/probe-wfp-fence.mjs`.
 *
 * ## Why not the proxy-wrapping path
 *
 * `wrapCommandWithSandboxWindows` exists for the MITM flow, which needs a
 * proxy port pair and a CA certificate — i.e. `node-forge`, which this
 * package deliberately does not ship (see `vendor/sandbox-runtime/PATCHES.md`).
 * The all-blocked egress contract does not need a certificate, so this adapter
 * drives `srt-win exec` directly and the CA path stays unloaded.
 *
 * ## Two constraints the probes forced into the contract
 *
 *  - **The program must be an absolute path.** The sandbox logon inherits
 *    `LOGON_WITH_PROFILE` defaults, which have no usable `PATH`; a bare
 *    `cmd.exe` fails with `0x80070002`. This is a minimal environment, not a
 *    broken sandbox, and callers must respect it.
 *  - **The working directory must be on a real local drive.** A mapped or
 *    network-drive cwd is refused before launch (`mapped_drive_cwd`). The
 *    helper fails closed, and so does this adapter: it reports
 *    `isolation_start_failed` rather than retrying outside the sandbox.
 */

export type WindowsIsolationConfig = WindowsReadinessConfig & {
  /**
   * Overrides the vendored helper path. Needed by tests and by any host that
   * ships the binary somewhere other than the repository layout.
   */
  readonly helperPath?: string;
  /**
   * The environment the sandboxed child inherits, before the request's own
   * `env` is layered on.
   *
   * Exists so this file never reads `process.env` directly. Without it, "what
   * does a sandboxed process see?" has two answers — the one this file reads and
   * the one its caller believes — and only one of them is testable. The default
   * below is an injection seam in the accepted form (`??` on the same line), so
   * the common case stays a one-liner and the unusual one is explicit.
   */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
};

/**
 * Windows-only by construction. The other two backends (`linux-bwrap`,
 * `macos-seatbelt`) are declared in the port but not implemented here: the
 * vendored helper is Windows-only, and claiming a backend this file cannot
 * produce is exactly the "prompt/comment as sandbox" failure the port exists
 * to prevent.
 */
export function createWindowsIsolation(config: WindowsIsolationConfig = {}): IsolationPort {
  return {
    async probe(): Promise<IsolationAvailability> {
      try {
        const prepared = await prepareWindowsIsolation([], config);
        prepared.lease?.close();
        return prepared.availability;
      } catch (error) {
        return { state: "broken", backend: "windows-srt", reason: messageOf(error) };
      }
    },

    async run(request: IsolationRequest): Promise<IsolationOutcome> {
      if (request.signal.aborted) return { outcome: "cancelled" };

      if (request.network.allowedDomains.length > 0) {
        return { outcome: "isolation_failed", code: "isolation_refused", message: "domain proxy is not configured for this execution port; the command was not run" };
      }

      if (request.files.denyReadPaths.some(p => /[*?[\]]/.test(p)) || request.files.denyWritePaths.some(p => /[*?[\]]/.test(p))) {
        return { outcome: "isolation_failed", code: "isolation_refused", message: "unexpanded deny globs are refused; the command was not run" };
      }

      let prepared;

      try {
        const helperPath = config.helperPath ?? (hostShellEnvironment().platform === "win32" ? prepareWindowsHelper(config.hostEnv, request.files.writableRoots) : undefined);
        prepared = await prepareWindowsIsolation(request.files.writableRoots, { ...config, ...(helperPath === undefined ? {} : { helperPath }) }, () => request.signal.aborted);
      }
      catch (error) {
        const cleanupFailure = error instanceof AggregateError ? { cleanupFailure: { code: "isolation_cleanup_failed" as const, message: messageOf(error) } } : {};
        if (request.signal.aborted) return { outcome: "cancelled", ...cleanupFailure };
        return { outcome: "isolation_failed", code: "isolation_start_failed", message: messageOf(error), ...cleanupFailure };
      }

      const availability = prepared.availability;

      if (request.signal.aborted && prepared.lease === undefined) return { outcome: "cancelled" };

      if (availability.state !== "ready") {
        // Fail closed. Running the command unconfined would execute something
        // the user approved on the assumption of a boundary that is absent.
        return {
          outcome: "isolation_failed",
          code: failureFor(availability),
          message:
            availability.state === "not_installed"
              ? `the Windows sandbox is not installed, so the command was not run: ${availability.installHint}`
              : `the Windows sandbox is not enforcing (${availability.state}), so the command was not run: ${availability.reason}`,
        };
      }

      const lease = prepared.lease;
      if (lease === undefined) return { outcome: "isolation_failed", code: "isolation_broken", message: "the command was not run: readiness returned no ACL owner" };

      let observed: IsolationOutcome;

      try {
        const program = request.argv[0];
        if (request.signal.aborted) observed = { outcome: "cancelled" };
        else if (program === undefined) observed = { outcome: "isolation_failed", code: "isolation_refused", message: "no executable was named" };
        else {
          lease.readExecutable(program);
          // Native ACL inspection can block the event loop; cancellation may arrive during it.
          observed = request.signal.aborted ? { outcome: "cancelled" }
            : await execConfined(lease.helperPath, request, config.hostEnv);
        }
      } catch (error) {
        observed = { outcome: "isolation_failed", code: "isolation_start_failed", message: messageOf(error) };
      }

      try { lease.close(); }
      catch (error) { return { ...observed, cleanupFailure: { code: "isolation_cleanup_failed", message: messageOf(error) } }; }

      return observed;
    },
  };
}

function failureFor(availability: IsolationAvailability): IsolationFailureCode {
  switch (availability.state) {
    case "not_installed":
      return "isolation_not_installed";
    case "broken":
      return "isolation_broken";
    default:
      return "isolation_unavailable";
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function buildArgv(helper: string, request: IsolationRequest): string[] {
  const argv = [helper, DISPATCH_ARG, "exec", "--quiet"];

  for (const p of request.files.denyReadPaths) {
    argv.push("--deny-read", p);
  }

  for (const p of request.files.denyWritePaths) {
    argv.push("--deny-write", p);
  }

  for (const [key, value] of Object.entries(request.env ?? {})) {
    argv.push("--env", `${key}=${value}`);
  }

  // `--` stops srt-win from reading our target as its own options.
  argv.push("--", ...request.argv);

  return argv;
}

type Streaming = {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly limit: number;
};

function collect(stream: NodeJS.ReadableStream | null | undefined, into: string[], limit: number): void {
  if (stream === null || stream === undefined) {
    return;
  }

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (into.join("").length < limit) {
      into.push(chunk);
    }
  });
}

function clip(chunks: readonly string[], limit: number): string {
  const text = chunks.join("");
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Runs the helper with the host environment unless the caller supplied one.
 *
 * `hostEnv` is a parameter rather than a closed-over value because this function
 * is module-level: reaching for the factory's `config` here would mean either a
 * module global (the hidden owner this package forbids) or threading the whole
 * config through a function that only ever needed one field.
 */
async function execConfined(
  helper: string,
  request: IsolationRequest,
  hostEnv: Readonly<Record<string, string | undefined>> | undefined,
): Promise<IsolationOutcome> {
  const argv = buildArgv(helper, request);
  const limit = 65_536;

  return await new Promise<IsolationOutcome>((resolve) => {
    const out: Streaming = { stdout: [], stderr: [], limit };
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: IsolationOutcome): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      request.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    let child: ChildProcess | undefined;

    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        cwd: request.cwd,
        env: { ...(hostEnv ?? hostProcessEnvironment()), ...(request.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      // The sandbox refused to start (a mapped-drive cwd is the known case).
      finish({
        outcome: "isolation_failed",
        code: "isolation_start_failed",
        message: `the sandbox helper could not be started for ${request.argv.join(" ")}: ${messageOf(err)}`,
      });
      return;
    }

    function onAbort(): void {
      child?.kill();
    }

    collect(child.stdout, out.stdout, limit);
    collect(child.stderr, out.stderr, limit);
    timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
    }, request.timeoutMs);
    request.signal.addEventListener("abort", onAbort);

    child.on("error", (err) => {
      finish({
        outcome: "isolation_failed",
        code: "isolation_start_failed",
        message: `the sandbox helper could not be started: ${messageOf(err)}`,
      });
    });

    child.on("close", (code) => {
      if (request.signal.aborted) {
        finish({ outcome: "cancelled" });
        return;
      }

      const stderr = clip(out.stderr, limit);

      // srt-win reserves 15 for "the sandbox user is not provisioned" and 16
      // for "the sandbox refused this launch" (a mapped-drive cwd, an
      // unstamped path). Neither means the command ran, so neither may be
      // reported as the command's own non-zero exit.
      if (code === 15 || code === 16) {
        finish({
          outcome: "isolation_failed",
          code: "isolation_refused",
          message: `the sandbox refused to run ${request.argv.join(" ")} (exit ${code}): ${stderr.trim() || "no detail"}`,
        });
        return;
      }

      finish({
        outcome: "completed",
        stdout: clip(out.stdout, limit),
        stderr,
        exitCode: code ?? -1,
        timedOut,
        backend: "windows-srt",
      });
    });
  });
}

/** `doctor` rows. Temporarily leases helper read access for proof; installs nothing. */
export async function windowsIsolationDiagnostic(
  config: WindowsIsolationConfig = {},
): Promise<IsolationDiagnostic> {
  const availability = await createWindowsIsolation(config).probe();
  const base = { backend: "windows-srt", state: availability.state };

  if (availability.state === "ready") {
    return { ...base, detail: availability.evidence };
  }

  if (availability.state === "not_installed") {
    return { ...base, detail: "the sandbox account is not provisioned", remedy: availability.installHint };
  }

  if (availability.state === "broken") {
    return { ...base, detail: availability.reason, remedy: "re-run the installer, then re-check" };
  }

  return { ...base, detail: availability.reason, raw: { platform: process.platform } as JsonObject };
}

/** Re-exported so callers do not hardcode the network default themselves. */
export function emptyNetworkPolicy(fenceVerified: boolean): IsolationNetworkPolicy {
  return { allowedDomains: [], deniedDomains: [], egressFenceVerified: fenceVerified };
}
