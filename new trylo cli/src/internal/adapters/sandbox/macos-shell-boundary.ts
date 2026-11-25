import { tmpdir } from "node:os";
import path from "node:path";
import { ShellIsolationError } from "../../ports/isolation.js";
import type { ProcessSessionStart } from "../../ports/process-session.js";
import { childEnvironment, type ShellSpawner } from "../tools/mutating/shell-spawn.js";
import { confinedMacosArgv, createMacosIsolation } from "./macos-isolation.js";
import { macosSeatbeltPrefix } from "./macos-seatbelt-profile.js";

/** POSIX pipes and PTYs can both launch the admitted argv directly through Seatbelt. */
export function createMacosShellBoundary(workspaceRoot: string, hostEnv: Readonly<Record<string, string | undefined>>) {
  const environment = childEnvironment({ env: hostEnv });
  const isolation = createMacosIsolation(hostEnv);
  let confirmed = false;
  let closed = false;

  const wrap = async (argv: readonly string[], cwd = workspaceRoot): Promise<readonly string[]> => {
    if (closed) throw new ShellIsolationError("isolation_closed", "command was not run");

    if (!confirmed) {
      const readiness = await isolation.probe();
      if (closed) throw new ShellIsolationError("isolation_closed", "command was not run");
      if (readiness.state !== "ready") {
        throw new ShellIsolationError(`isolation_${readiness.state}`, readiness.state === "not_installed" ? readiness.installHint : readiness.reason);
      }
      confirmed = true;
    }

    try {
      const prefix = macosSeatbeltPrefix({
        writableRoots: [workspaceRoot, environment.TMPDIR || tmpdir()],
        denyReadPaths: [],
        denyWritePaths: [".git/config", ".git/hooks", ".trylo", ".agents", ".codex"].map(name => path.join(workspaceRoot, name)),
      });
      return confinedMacosArgv(prefix, argv, cwd);
    } catch (error) {
      throw new ShellIsolationError("isolation_preparation_failed", error instanceof Error ? error.message : String(error), { cause: error });
    }
  };

  return {
    wrapSession: (request: ProcessSessionStart) => wrap(request.argv, request.cwd),
    helperEnvironment: () => environment,
    spawner(spawn: ShellSpawner): ShellSpawner {
      return async spec => {
        if (spec.signal.aborted) return { stdout: "", stderr: "", exitCode: -1, timedOut: false, aborted: true, truncated: false };

        const argv = await wrap(spec.shape?.argv ?? spec.argv, spec.cwd);
        const pipeTo = await Promise.all((spec.pipeTo ?? []).map(async segment => {
          const argv = await wrap(segment.shape.argv, spec.cwd);
          return { argv, shape: { kind: "direct" as const, argv } };
        }));
        return spawn({ ...spec, argv, shape: { kind: "direct", argv }, pipeTo });
      };
    },
    async close(): Promise<void> { closed = true; },
  };
}
