import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type NpmResolverProcessCode = "cancelled" | "npm_resolution_timeout" | "npm_resolution_failed"
  | "npm_resolver_unavailable" | "npm_resolver_output_limit" | "npm_resolver_stop_unconfirmed";

export type NpmResolverProcessResult = { readonly ok: true } | { readonly ok: false; readonly code: NpmResolverProcessCode;
  readonly cleanup: "safe" | "retained" };

export type NpmResolverProcessOptions = {
  readonly launch?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly after?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clear?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** One direct npm process owner. A kill request or AbortError is not an exit receipt. */
export function executeNpmResolverProcess(input: { readonly executable: string; readonly args: readonly string[];
  readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly signal: AbortSignal }, options: NpmResolverProcessOptions = {}): Promise<NpmResolverProcessResult> {
  if (input.signal.aborted) return Promise.resolve({ ok: false, code: "cancelled", cleanup: "safe" });

  const launch = options.launch ?? spawn, after = options.after ?? setTimeout, clear = options.clear ?? clearTimeout;

  return new Promise(resolve => {
    let child: ChildProcess;

    try { child = launch(input.executable, input.args, { cwd: input.cwd, env: input.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch {
      resolve({ ok: false, code: "npm_resolver_unavailable", cleanup: "safe" });
      return;
    }

    let settled = false, bytes = 0, reason: Exclude<NpmResolverProcessCode, "npm_resolver_stop_unconfirmed"> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined, forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: NpmResolverProcessResult) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", cancel);
      clear(deadline);
      if (stopTimer !== undefined) clear(stopTimer);
      if (forceTimer !== undefined) clear(forceTimer);
      resolve(result);
    };
    const signalStop = (code: Exclude<NpmResolverProcessCode, "npm_resolver_stop_unconfirmed">) => {
      if (settled || stopTimer !== undefined) return;

      reason ??= code;
      stopTimer = after(() => {
        forceTimer = after(() => finish({ ok: false, code: "npm_resolver_stop_unconfirmed", cleanup: "retained" }), 2_000);
        try { child.kill("SIGKILL"); } catch { /* Failure to send a second signal is still not a close receipt. */ }
      }, 5_000);

      try { child.kill("SIGTERM"); } catch { /* No exit fact: keep ownership until close or the bounded stop deadline. */ }
    };
    const cancel = () => signalStop("cancelled");
    const deadline = after(() => signalStop("npm_resolution_timeout"), 90_000);
    const count = (chunk: Uint8Array | string) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (bytes > 262_144) signalStop("npm_resolver_output_limit");
    };

    child.stdout?.on("data", count);
    child.stderr?.on("data", count);
    // Retain the listener after settlement: late OS errors must not become uncaught exceptions.
    child.on("error", error => {
      if (reason === undefined) reason = isUnavailable(error) ? "npm_resolver_unavailable" : "npm_resolution_failed";
    });
    child.once("close", code => finish(reason !== undefined ? { ok: false, code: reason, cleanup: "safe" }
      : code === 0 ? { ok: true } : { ok: false, code: "npm_resolution_failed", cleanup: "safe" }));
    input.signal.addEventListener("abort", cancel, { once: true });

    if (input.signal.aborted) cancel();
  });
}

function isUnavailable(error: Error): boolean {
  return "code" in error && ["ENOENT", "EACCES", "ENOEXEC"].includes(String(error.code));
}
