import { accessSync, constants } from "node:fs";
import { childEnvironment, createNodeSpawner } from "../tools/mutating/shell-spawn.js";
import type { IsolationAvailability, IsolationOutcome, IsolationPort } from "../../ports/isolation.js";
import { MACOS_SEATBELT_EXECUTABLE, macosSeatbeltPrefix } from "./macos-seatbelt-profile.js";
import { resolveExecutablePath } from "./resolve-executable-path.js";

type Environment = Readonly<Record<string, string | undefined>>;

const MAX_OUTPUT_BYTES = 65_536;
const MAX_OUTPUT_LINES = 65_536;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Argv shapes stay literal all the way into sandbox-exec. */
export function confinedMacosArgv(prefix: readonly string[], argv: readonly string[], cwd: string): readonly string[] {
  const [program, ...args] = argv;
  if (program === undefined) throw new Error("No executable was named for Seatbelt");
  const resolved = resolveExecutablePath(program, cwd);
  if (!resolved.ok) throw new Error(resolved.message);
  return [...prefix, resolved.absolutePath, ...args];
}

const emptyPolicy = { writableRoots: [], denyReadPaths: [], denyWritePaths: [] };

export function createMacosIsolation(hostEnv: Environment): IsolationPort {
  const probe = async (): Promise<IsolationAvailability> => {
    try { accessSync(MACOS_SEATBELT_EXECUTABLE, constants.X_OK); }
    catch (error) {
      const absent = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      return absent
        ? { state: "not_installed", backend: "macos-seatbelt", installHint: "This macOS installation must provide /usr/bin/sandbox-exec" }
        : { state: "broken", backend: "macos-seatbelt", reason: messageOf(error) };
    }

    try {
      const signal = new AbortController().signal;
      const result = await createNodeSpawner(() => childEnvironment({ env: hostEnv }))({
        argv: [...macosSeatbeltPrefix(emptyPolicy), "/usr/bin/true"], cwd: "/",
        timeoutMs: 5000, signal, maxOutputBytes: MAX_OUTPUT_BYTES, maxOutputLines: MAX_OUTPUT_LINES,
      });
      return result.exitCode === 0
        ? { state: "ready", backend: "macos-seatbelt", evidence: "sandbox-exec applied a deny-by-default profile" }
        : { state: "broken", backend: "macos-seatbelt", reason: result.stderr.trim() || "Seatbelt probe did not complete" };
    } catch (error) { return { state: "broken", backend: "macos-seatbelt", reason: messageOf(error) }; }
  };

  return {
    probe,
    async run(request): Promise<IsolationOutcome> {
      if (request.signal.aborted) return { outcome: "cancelled" };
      if (request.network.allowedDomains.length > 0) {
        return { outcome: "isolation_failed", code: "isolation_refused", message: "Seatbelt domain rules require a separate egress proxy; nothing was started" };
      }

      let argv: readonly string[];
      try { argv = confinedMacosArgv(macosSeatbeltPrefix(request.files), request.argv, request.cwd); }
      catch (error) { return { outcome: "isolation_failed", code: "isolation_refused", message: messageOf(error) }; }

      const readiness = await probe();
      if (request.signal.aborted) return { outcome: "cancelled" };
      if (readiness.state !== "ready") {
        return { outcome: "isolation_failed", code: `isolation_${readiness.state}`,
          message: readiness.state === "not_installed" ? readiness.installHint : readiness.reason };
      }

      try {
        const env = childEnvironment({ env: { ...hostEnv, ...request.env } });
        const result = await createNodeSpawner(() => env)({ argv, cwd: request.cwd, timeoutMs: request.timeoutMs,
          signal: request.signal, maxOutputBytes: MAX_OUTPUT_BYTES, maxOutputLines: MAX_OUTPUT_LINES });
        if (result.aborted) return { outcome: "cancelled" };
        if (result.exitCode !== 0 && /^sandbox-exec: (?:sandbox_apply|sandbox_compile|execvp)/m.test(result.stderr)) {
          return { outcome: "isolation_failed", code: "isolation_start_failed", message: result.stderr.trim() };
        }
        return { outcome: "completed", backend: "macos-seatbelt", stdout: result.stdout, stderr: result.stderr,
          exitCode: result.exitCode, timedOut: result.timedOut };
      } catch (error) { return { outcome: "isolation_failed", code: "isolation_start_failed", message: messageOf(error) }; }
    },
  };
}
