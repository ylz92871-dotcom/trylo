import type { ChildProcess } from "node:child_process";
import { terminateProcessTree } from "../../process-session/process-tree.js";
import type { CommandShape } from "../../sandbox/executable.js";
import { OutputCapture } from "./output-capture.js";
import { startShellChild, startShellPipeline } from "./shell-child-processes.js";

/**
 * The one place a process is actually created.
 *
 * Everything else in this package decides *whether* that may happen; this does
 * the happening, and deliberately knows nothing about policy. Keeping it in its
 * own module is what lets the "nothing was spawned" tests assert against a
 * counter instead of trying to observe a process that never existed.
 *
 * The child gets a minimal environment: nothing that looks like a credential or
 * a proxy configuration is inherited, so a command cannot quietly discover the
 * API key the CLI was started with.
 */

export type ShellSegment = {
  readonly argv: readonly string[];
  readonly shape: CommandShape;
};

export type ShellSpawnSpec = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  /** How to start `argv`; when absent it is spawned exactly as written. */
  readonly shape?: CommandShape;
  /**
   * The receivers after `argv`, in order. Empty or absent means no pipe.
   * Every segment is spawned here from an already-planned argv and joined
   * with pipes — still no shell anywhere in the path.
   */
  readonly pipeTo?: ReadonlyArray<ShellSegment>;
};

export type ShellSpawnResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly truncated: boolean;
};

export type ShellSpawner = (spec: ShellSpawnSpec) => Promise<ShellSpawnResult>;

const INHERITED_ENVIRONMENT = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
];

/**
 * `restricted` network (see the sandbox policy) is realised here as: no proxy
 * variables and no inherits beyond the list above. It is *not* OS-level network
 * isolation, and this package does not claim otherwise.
 */
export function childEnvironment(options: { env?: Readonly<Record<string, string | undefined>> } = {}): Readonly<Record<string, string>> {
  const source = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENVIRONMENT) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Applying the caller's output limits.
 *
 * The byte and line arithmetic used to live here and was wrong in a way only a
 * non-ASCII command could show: it compared and sliced UTF-16 code units against
 * budgets denominated in bytes, and it kept the head while dropping the tail —
 * which for a build log means dropping the error. `output-limits.ts` owns that
 * now, with the measured cases pinned in its own tests.
 */
type Stdio = readonly ["ignore" | "pipe", "pipe", "pipe"];

/**
 * A `shell` shape means the words were already quoted for cmd by
 * `sandbox/executable.ts`, so they must reach the command line untouched —
 * which is exactly what `windowsVerbatimArguments` exists for.
 *
 * On POSIX the child is put in **its own process group** (`detached`), because
 * that is what makes a tree reachable: `terminateProcessTree` signals the
 * group, so a command's own descendants go with it. Windows needs no such flag
 * — `taskkill /T` walks the parent/child links itself — so it is left off there
 * rather than changing console semantics for no gain.
 */
function startChild(shape: CommandShape, cwd: string, stdio: Stdio, env: Readonly<Record<string, string>>): ChildProcess {
  return startShellChild(shape, cwd, stdio, env, process.platform);
}

/**
 * End a child and its descendants, reporting a walk that failed.
 *
 * The shell spawner resolves when the child's streams close, so there is no
 * later moment at which a failure could be raised to the caller — returning it
 * from here is the only chance the fact gets out. It therefore goes onto
 * stderr, where it is visible in a terminal and captured by anything reading
 * the command's own error stream, rather than into a value nobody inspects.
 *
 * This is not a "tree kill unsupported" alarm on Windows or Linux, which are
 * both wired; it fires only when a platform has no walk at all or the helper
 * itself failed.
 */
async function endChildTree(child: ChildProcess): Promise<void> {
  const outcome = await terminateProcessTree(child);
  if (outcome.ok) {
    return;
  }
  process.stderr.write(`[run_shell] ${outcome.message}\n`);
}

function collect(child: ChildProcess, stdout: OutputCapture | undefined, stderr: OutputCapture): void {
  if (stdout !== undefined) child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  if (stdout !== undefined) child.stdout?.on("data", (chunk: string) => stdout.write(chunk));
  child.stderr?.on("data", (chunk: string) => {
    stderr.write(chunk);
  });
}

function runSingle(spec: ShellSpawnSpec, shape: CommandShape, env: Readonly<Record<string, string>>): Promise<ShellSpawnResult> {
  return new Promise<ShellSpawnResult>((resolve, reject) => {
    const capturedStdout = new OutputCapture(spec.maxOutputBytes);
    const capturedStderr = new OutputCapture(spec.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ShellSpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      spec.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const report = (): ShellSpawnResult => {
      const stdout = capturedStdout.read(spec.maxOutputLines);
      const stderr = capturedStderr.read(spec.maxOutputLines);
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: child.exitCode ?? -1,
        timedOut,
        aborted: spec.signal.aborted,
        truncated: stdout.truncated || stderr.truncated,
      };
    };
    function onAbort(): void {
      void endChildTree(child);
    }
    const child = startChild(shape, spec.cwd, ["ignore", "pipe", "pipe"], env);
    collect(child, capturedStdout, capturedStderr);
    timer = setTimeout(() => {
      timedOut = true;
      void endChildTree(child);
    }, spec.timeoutMs);
    spec.signal.addEventListener("abort", onAbort);
    if (spec.signal.aborted) onAbort();
    child.on("error", (err) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      spec.signal.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", () => {
      finish(report());
    });
  });
}

/**
 * `A | B | …` without a shell: one spawn per segment, each stdout piped into
 * the next stdin. The exit code and stdout come from the last segment — that
 * is what a shell reports too — while stderr of every segment is merged,
 * because a failure in any one of them is worth seeing.
 */
/**
 * The last segment decides the result, the way a shell would: its exit code,
 * its stdout. Stderr is merged across the whole pipeline because a failure in
 * any segment is worth seeing.
 */
function pipeReport(
  spec: ShellSpawnSpec,
  children: ReadonlyArray<ChildProcess>,
  capturedStdout: OutputCapture,
  capturedStderr: OutputCapture,
  timedOut: boolean,
): ShellSpawnResult {
  const last = children[children.length - 1];
  const stdout = capturedStdout.read(spec.maxOutputLines);
  const stderr = capturedStderr.read(spec.maxOutputLines);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: last?.exitCode ?? -1,
    timedOut,
    aborted: spec.signal.aborted,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function runPipeline(
  spec: ShellSpawnSpec,
  source: CommandShape,
  receivers: ReadonlyArray<ShellSegment>,
  env: Readonly<Record<string, string>>,
): Promise<ShellSpawnResult> {
  return new Promise<ShellSpawnResult>((resolve, reject) => {
    // First segment's stdout is ignored (nothing reads it but the pipe);
    // every other segment pipes stdout into the next stdin.
    const children = startShellPipeline([source, ...receivers.map(receiver => receiver.shape)], (shape, receiver) => startChild(shape, spec.cwd, [receiver ? "pipe" : "ignore", "pipe", "pipe"], env));
    const capturedStdout = new OutputCapture(spec.maxOutputBytes);
    const capturedStderr = new OutputCapture(spec.maxOutputBytes);
    children.forEach((child, index) => {
      // Intermediate stdout flows only to the next process, never into a second log copy.
      collect(child, index === children.length - 1 ? capturedStdout : undefined, capturedStderr);
    });
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const killAll = (): void => {
      for (const child of children) {
        void endChildTree(child);
      }
    };
    const stop = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      spec.signal.removeEventListener("abort", onAbort);
    };
    function onAbort(): void {
      killAll();
    }
    timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, spec.timeoutMs);
    spec.signal.addEventListener("abort", onAbort);
    if (spec.signal.aborted) onAbort();
    let failure: { readonly error: unknown } | undefined;
    let closed = 0;
    const failed = (err: unknown): void => {
      if (failure !== undefined) {
        return;
      }
      failure = { error: err };
      // A failed receiver still has running producers. Returning here leaves
      // them holding the workspace (EPERM on Windows) after the tool has ended.
      killAll();
    };
    for (const child of children) {
      child.on("error", failed);
      child.on("close", () => {
        closed += 1;
        if (settled || closed !== children.length) {
          return;
        }
        stop();
        settled = true;
        if (failure !== undefined) {
          reject(failure.error);
        } else {
          resolve(pipeReport(spec, children, capturedStdout, capturedStderr, timedOut));
        }
      });
    }
  });
}

/** Trusted execution adapters can supply their broker environment; tool arguments cannot. */
export const createNodeSpawner = (environment: () => Readonly<Record<string, string>> = childEnvironment): ShellSpawner => async (spec) => {
  const cancelled: ShellSpawnResult = { stdout: "", stderr: "", exitCode: -1, timedOut: false, aborted: true, truncated: false };
  if (spec.signal.aborted) return cancelled;
  const env = environment();
  if (spec.signal.aborted) return cancelled;
  const shape = spec.shape ?? { kind: "direct", argv: spec.argv };
  const receivers = spec.pipeTo ?? [];
  if (receivers.length === 0) {
    return await runSingle(spec, shape, env);
  }
  return await runPipeline(spec, shape, receivers, env);
};
