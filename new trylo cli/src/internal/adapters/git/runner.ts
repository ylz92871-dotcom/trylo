import { spawn, type ChildProcess } from "node:child_process";
import { GIT_DIFF_TIMEOUT_MS, type GitCommandResult, type GitCommandRunner } from "../../surface/cli/git-diff.js";

/**
 * The `git` subprocess runner behind `collectGitDiff` (WP11.1, C21).
 *
 * One spawn per command, no shell, timeout-bounded, abort-aware. Output is
 * piped and decoded as UTF-8; a diff is text by construction here (binary
 * entries arrive as git's own "Binary files … differ" line, not raw bytes).
 * The timeout kills and reports instead of hanging the command that asked.
 */

export type GitSpawn = (
  file: string,
  argv: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string | undefined>;
    readonly signal?: AbortSignal;
    readonly windowsHide: true;
  },
) => ChildProcess;

export type GitRunnerOptions = {
  readonly timeoutMs?: number;
  /** Injection seam: tests script exits and output without spawning git. */
  readonly spawnImpl?: GitSpawn;
};

function toErrorText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

function runOnce(
  spawnImpl: GitSpawn,
  argv: ReadonlyArray<string>,
  cwd: string,
  extraEnv: Readonly<Record<string, string | undefined>> | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<GitCommandResult> {
  const [file, ...args] = argv;
  if (file === undefined) {
    throw new Error("git runner received an empty argv");
  }
  return new Promise<GitCommandResult>((resolve, reject) => {
    // No `process.env` read here: `env` arrives from the caller (the CLI
    // context's injected environment plus driver neutering), and `undefined`
    // means plain inheritance. The surface stays the only place that knows
    // the ambient environment, behind its injection seam.
    const child = spawnImpl(file, args, {
      cwd,
      windowsHide: true,
      ...(extraEnv === undefined ? {} : { env: { ...extraEnv } }),
      ...(signal === undefined ? {} : { signal }),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          // Already gone; the error below still reports the timeout.
        }
        reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    if (timer.unref !== undefined) {
      timer.unref();
    }
    child.stdout?.on("data", (chunk) => {
      stdout += toErrorText(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += toErrorText(chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exit: code ?? 1, stdout, stderr });
      }
    });
  });
}

/**
 * Builds the production git runner. `timeoutMs` bounds each command;
 * `GIT_DIFF_TIMEOUT_MS` (30s, matching Codex `DIFF_COMMAND_TIMEOUT`) applies
 * when absent. No ambient reads here beyond the spawn itself: `process.env`
 * is inherited, never inspected.
 */
export function createGitRunner(options?: GitRunnerOptions): GitCommandRunner {
  const spawnImpl: GitSpawn = options?.spawnImpl ?? ((file, argv, spawnOptions) => spawn(file, [...argv], spawnOptions));
  const timeoutMs = options?.timeoutMs ?? GIT_DIFF_TIMEOUT_MS;
  return {
    run(argv, cwd, runOptions): Promise<GitCommandResult> {
      try {
        return runOnce(spawnImpl, argv, cwd, runOptions?.env, runOptions?.signal, timeoutMs);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
