#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { parseArgs } from "../../internal/surface/cli/args.js";
import { dispatch } from "../../internal/surface/cli/commands.js";
import { pathCompletions } from "../../internal/surface/cli/complete.js";
import { slashCompleter } from "../../internal/surface/cli/slash.js";
import type { CliContext, DirEntryInfo } from "../../internal/surface/cli/context.js";
import { readSecretLine } from "../../internal/surface/cli/secret-prompt.js";
import { createTerminalLineReader } from "./terminal-line-reader.js";
import { IsolationCleanupError } from "../../internal/adapters/sandbox/windows-isolation-error.js";
import { createToolProductionService } from "./tool-production-service.js";

/**
 * Process entry point.
 *
 * The only file allowed to touch `process`, and it does nothing but build a
 * `CliContext` from real IO and hand it to the command dispatcher. Every
 * decision below it is testable without a child process.
 */

/** Used only when a terminal refuses to say how wide it is. */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

/**
 * The terminal's key stream (WP23.2). The listener is detached and reattached
 * rather than muted: a muted listener would still eat the data events a
 * foreign reader (a menu, the echo-off secret reader) is waiting on. Raw mode
 * follows the listener, because with it on the terminal sends bytes instead
 * of lines and SIGINT never fires.
 */
function terminalKeys(): CliContext["keys"] {
  if (process.stdin.isTTY !== true) {
    return undefined;
  }
  let listener: ((chunk: Buffer) => void) | undefined;
  const attach = (withRaw: boolean): void => {
    if (listener !== undefined) {
      return;
    }
    // A borrowed readline can leave stdin flowing without delivering keys.
    // Give the restored owner an explicit pause/resume edge.
    process.stdin.pause();
    listener = (chunk) => onChunk(chunk.toString("utf8"));
    process.stdin.on("data", listener);
    if (withRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  };
  const detach = (): void => {
    if (listener === undefined) {
      return;
    }
    process.stdin.removeListener("data", listener);
    listener = undefined;
    process.stdin.setRawMode(false);
  };
  let onChunk: (chunk: string) => void = () => {};
  return {
    start: (handler) => {
      onChunk = handler;
      attach(true);
    },
    suspend: () => detach(),
    resume: () => attach(true),
    stop: () => {
      detach();
      process.stdin.pause();
    },
  };
}

/**
 * The person's editor on a buffer (WP23.2 / C81). A synchronous spawn that
 * inherits the terminal: the process has nothing else to do while the editor
 * is open, and the editor needs the screen it is on.
 */
async function editInEditor(text: string): Promise<string | undefined> {
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (editor === undefined || editor.trim().length === 0) {
    return undefined;
  }
  const file = path.join(tmpdir(), `trylo-edit-${randomUUID()}.md`);
  writeFileSync(file, text, "utf8");
  try {
    const result = spawnSync(editor, [file], { stdio: "inherit", shell: process.platform === "win32" });
    if (result.error !== undefined || result.status !== 0) {
      return undefined;
    }
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // A temp file the OS will sweep is not a failure the session can act on.
    }
  }
}

function safeReadFile(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

function safeIsDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(absolutePath: string): ReadonlyArray<DirEntryInfo> {
  try {
    return readdirSync(absolutePath, { withFileTypes: true }).map((entry) => {
      let bytes = 0;
      let modifiedAtMs = 0;
      try {
        const info = statSync(path.join(absolutePath, entry.name));
        bytes = info.size;
        modifiedAtMs = info.mtimeMs;
      } catch {
        // A file that vanished between listing and stat is simply unsized.
      }
      return { name: entry.name, bytes, modifiedAtMs };
    });
  } catch {
    return [];
  }
}

function safeWriteFile(absolutePath: string, text: string): boolean {
  try {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, text);
    return true;
  } catch {
    return false;
  }
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
    process.stdin.resume();
  });
}

type ProcessContext = CliContext & { readonly close: () => void };

export function createProcessContext(): ProcessContext {
  let readline: ReturnType<typeof createInterface> | undefined;
  const interrupts = processInterrupts();
  const keys = terminalKeys();
  // "close" fires exactly once, when stdin hits EOF (a pipe) or Ctrl-D (a
  // terminal); after that every `question` throws ERR_USE_AFTER_CLOSE, so the
  // closed fact is latched and reported as the end of input instead.
  let stdinClosed = false;
  /**
   * Lines already read from a pipe, and the readers waiting for one.
   *
   * On a pipe `readline.question` answers exactly once — a second call never
   * calls back (a minimal probe shows Node reporting an unsettled top-level
   * await), which made the REPL stop after its first command. So a pipe is read
   * by listening for lines and queueing them here, while a terminal keeps using
   * `question`, which is the only path that gives line editing, history and
   * completion.
   */
  const pipedLines: string[] = [];
  const pipedWaiters: Array<(line: string | undefined) => void> = [];
  const terminalReader = createTerminalLineReader(process.stdin, process.stderr, line => {
    const [commands] = slashCompleter(line);
    if (commands.length > 0) return [[...commands], line];
    return [[...pathCompletions(line, process.cwd(), absolutePath => {
      try {
        return readdirSync(absolutePath, { withFileTypes: true }).map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      } catch {
        return [];
      }
    })], line];
  });
  const ensureReadline = () => {
    if (readline === undefined) {
      // Pipes keep one queue reader; terminal borrowing has its own short reader.
      readline = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
      readline.on("line", line => {
        const waiter = pipedWaiters.shift();
        if (waiter === undefined) pipedLines.push(line);
        else waiter(line);
      });
      readline.on("close", () => {
        stdinClosed = true;
        // Everyone still waiting met the end of input, which is the same
        // answer `question` would have given: there is no next line.
        while (pipedWaiters.length > 0) {
          pipedWaiters.shift()?.(undefined);
        }
      });
    }
    return readline;
  };
  return {
    get toolProduction() {
      return createToolProductionService({ homeDir: homedir(), env: process.env, now: () => Date.now(), newId: prefix => `${prefix}-${randomUUID()}` });
    },
    env: process.env,
    homeDir: homedir(),
    cwd: process.cwd(),
    nodeVersion: process.version,
    // The platform, injected beside `nodeVersion` for the same reason: this file
    // is the one sanctioned owner of `process`, and a run that tells the model
    // which platform it is on must not read `process` for it anywhere else.
    platform: process.platform,
    stdinIsTty: process.stdin.isTTY === true,
    readFile: safeReadFile,
    isDirectory: safeIsDirectory,
    readDir: safeReadDir,
    writeFile: safeWriteFile,
    readStdin: readAllStdin,
    readLine: async (prompt?: string) => {
      // The composer suspends before lending the terminal. Closing this short
      // reader detaches keypress listeners before the composer resumes.
      if (process.stdin.isTTY === true) return terminalReader.read(prompt);
      ensureReadline();
      const queued = pipedLines.shift();
      if (queued !== undefined) return queued;
      if (stdinClosed) return undefined;
      return new Promise<string | undefined>(resolve => pipedWaiters.push(resolve));
    },
    // The login secret gets the echo-off reader. The generic `readLine` above
    // deliberately stays generic: it is for the repl and the permission prompt,
    // which are talking to a person, not collecting a key.
    readSecret: () => readSecretLine(process.stdin),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    // Runs observe SIGINT even with piped stdin, so cancellation can settle
    // the journal and children. Read-only commands never install a listener.
    interrupts,
    // Read on demand, not once: a person resizes a window and the next frame
    // is laid out in the new width, with no event to subscribe to and no state
    // to keep in sync.
    ...(process.stdout.isTTY === true
      ? {
          terminalSize: () => ({
            columns: process.stdout.columns ?? FALLBACK_COLUMNS,
            rows: process.stdout.rows ?? FALLBACK_ROWS,
          }),
        }
      : {}),
    ...(keys === undefined ? {} : { keys }),
    editInEditor,
    now: () => Date.now(),
    newId: (prefix) => `${prefix}-${randomUUID()}`,
    close: () => {
      terminalReader.close();
      readline?.close();
      keys?.stop();
      // A still-open Desktop pipe must not retain the completed process.
      process.stdin.pause();
      interrupts?.close();
    },
  };
}

/**
 * The process's interrupt surface, and the only place a signal handler is ever
 * installed.
 *
 * `observe` is lazy: the listener goes up the first time a surface asks to hear
 * about interrupts. Runs and interactive sessions ask; read-only commands
 * such as `trylo doctor` keep the OS default because they never observe.
 *
 * `exit` really exits, because the second interrupt must end the process even
 * when what is in flight is a pending read (a permission prompt, a half-typed
 * line). Nothing below the root can reach that read, and an interrupt cannot be
 * made to return from it: without this the second press would be a no-op
 * exactly when a person most needs it to work.
 */
function processInterrupts(): NonNullable<CliContext["interrupts"]> & { readonly close: () => void } {
  let installed = false;
  const handlers: Array<() => void> = [];
  const onInterrupt = (): void => {
    for (const each of handlers) {
      each();
    }
  };
  return {
    observe: (handler) => {
      handlers.push(handler);
      if (!installed) {
        installed = true;
        process.on("SIGINT", onInterrupt);
      }
    },
    unobserve: (handler) => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
      if (handlers.length === 0) {
        process.removeListener("SIGINT", onInterrupt);
        installed = false;
      }
    },
    exit: (code) => {
      process.exit(code);
    },
    close: () => {
      process.removeListener("SIGINT", onInterrupt);
    },
  };
}

/**
 * argv in, exit code out. Command families are resolved by the parser and the
 * dispatcher (`surface/cli/family-entries.ts`), so nothing here knows they exist.
 */
async function dispatchWithCleanupReport(argv: readonly string[], ctx: CliContext): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), ctx);
  } catch (error) {
    if (!(error instanceof IsolationCleanupError)) throw error;
    ctx.stderr(`${error.message}\nSandbox cleanup could not be confirmed. Run trylo doctor before starting another shell task.\n`);
    return 1;
  }
}

export async function main(argv: readonly string[], ctx?: CliContext): Promise<number> {
  if (ctx !== undefined) return dispatchWithCleanupReport(argv, ctx);
  const owned = createProcessContext();
  try { return await dispatchWithCleanupReport(argv, owned); }
  finally { owned.close(); }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry !== undefined && entry.endsWith("/cmd/trylo/main.js")) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
