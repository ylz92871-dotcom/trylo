/**
 * Everything the command layer is allowed to touch from the outside world.
 *
 * Every field is injected, so a CLI test can drive the real command handlers
 * without a child process, a real clock or a real terminal. Nothing below this
 * boundary reads `process` directly.
 */

import type { InteractivePermissionIo } from "./permission.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { BootstrapContext } from "./bootstrap-context.js";

export type DirEntryInfo = {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
};

export type CliContext = {
  readonly bootstrapContext?: BootstrapContext;
  readonly userSourceAvailable?: false;
  /** Structured UI approval and ownership lifecycle; absent keeps text approval. */
  readonly approval?: Pick<InteractivePermissionIo, "requestApproval" | "onApproval" | "supportsMemberApproval">;
  /** Actual run events and timestamps for phase timing; observer cannot grant authority. */
  readonly onRunEnvelope?: (envelope: Envelope) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string;
  readonly nodeVersion: string;
  /**
   * The platform token (`process.platform`), injected by the composition root
   * for the same reason as `nodeVersion`: a run states its real platform to the
   * model, and this file is the only place allowed to ask the process what it
   * is. Absent — a hand-built context in a test — means the environment block
   * says nothing about the platform rather than guessing one.
   */
  readonly platform?: string;
  /** True when stdin is a terminal, so an empty prompt is a usage error. */
  readonly stdinIsTty: boolean;
  readonly readFile: (absolutePath: string) => string | undefined;
  readonly isDirectory: (absolutePath: string) => boolean;
  readonly readDir: (absolutePath: string) => ReadonlyArray<DirEntryInfo>;
  readonly writeFile: (absolutePath: string, text: string) => boolean;
  readonly readStdin: () => Promise<string>;
  readonly readLine: (prompt?: string) => Promise<string | undefined>;
  /**
   * Reads one line of secret text with the terminal's own echo turned off.
   *
   * Kept apart from `readLine` deliberately: this one may not be a line reader
   * (readline silences itself and leaves the driver echoing), and the generic
   * reader stays generic for the repl and the permission prompt.
   */
  readonly readSecret: () => Promise<string | undefined>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /**
   * The user's interrupts (Ctrl-C / SIGINT), observed — never handled — down
   * here.
   *
   * Built by the composition root, because observing an interrupt means
   * touching `process`, and `cmd/trylo/main.ts` stays the only file allowed to
   * do that. Absent means the host cannot observe them. The process root lends
   * a lazy observer to both interactive and piped runs; read-only commands do
   * not subscribe. A finished run detaches its observer through `unobserve`.
   *
   * `exit` is kept apart from `observe` because leaving the process is a
   * process fact, not a surface decision: the surface decides *when* (the
   * second interrupt), the root decides *how*.
   */
  readonly interrupts?: {
    readonly observe: (handler: () => void) => void;
    readonly unobserve?: (handler: () => void) => void;
    readonly exit: (code: number) => void;
  };
  /**
   * How wide the terminal is right now, for a surface that has to lay text out
   * in columns.
   *
   * A function rather than a number because a terminal can be resized between
   * two frames, and a snapshot taken at start-up would go stale in the one
   * place width is actually used. Built by the composition root for the same
   * reason `interrupts` is: measuring a terminal means touching `process`, and
   * `cmd/trylo/main.ts` stays the only file allowed to do that.
   *
   * Absent means this process has no terminal to measure — every non-
   * interactive command, every test, and every piped `trylo`. A surface that
   * needs a width then falls back to a fixed one, which is what it was already
   * doing.
   */
  readonly terminalSize?: () => { readonly columns: number; readonly rows: number };
  /**
   * The terminal's key stream, as the prompt composer consumes it (WP23.2).
   *
   * `start` attaches the chunk listener and takes raw mode; `suspend` detaches
   * it and hands the terminal back to line discipline, so a foreign reader (a
   * menu, the echo-off secret reader) can use the same stream without the two
   * of them racing; `resume` undoes `suspend`; `stop` is final. Built by the
   * composition root for the same reason `interrupts` is: raw mode means
   * touching `process`, and `cmd/trylo/main.ts` stays the only file allowed to
   * do that. Absent — every piped run, every test — means the surface has no
   * composer and reads lines the way it always did.
   */
  readonly keys?: {
    readonly start: (onChunk: (chunk: string) => void) => void;
    readonly suspend: () => void;
    readonly resume: () => void;
    readonly stop: () => void;
  };
  /**
   * Open the user's editor on a buffer and answer the edited text (WP23.2 /
   * C81). The editor comes from `VISUAL`, then `EDITOR`; undefined here (no
   * terminal, no editor configured, or the editor failed) means the surface
   * says so instead of pretending the edit happened. Built by the composition
   * root: spawning a child that inherits the terminal is a process fact.
   */
  readonly editInEditor?: (text: string) => Promise<string | undefined>;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
};
