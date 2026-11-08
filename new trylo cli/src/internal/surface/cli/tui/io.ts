import type { CliContext } from "../context.js";
import { DEFAULT_WIDTH } from "./frame.js";
import type { ChoiceRequest } from "./choice.js";
import type { ComposerView } from "./composer-view.js";

/**
 * The TUI's IO shell port.
 *
 * The renderer and the state are pure; this port is the only thing that
 * touches a terminal, and it is injected so the shell is testable without
 * one. The line adapter below is built entirely from the injected
 * `CliContext`: it adds no `process` access, no raw-mode switches and no
 * signal handlers, so this build's IO story stays exactly the one
 * `cmd/trylo/main.ts` already tells.
 *
 * `onInterrupt` is no longer dormant. The composition root builds the
 * `ctx.interrupts` capability in `cmd/trylo/main.ts` (the only file that may
 * touch `process`), and this adapter passes it straight through; the Ctrl-C
 * state machine in `entry.ts` then runs live. Absent — a context with no
 * interrupt source, which is every test that does not opt in — still means the
 * machine stays dormant rather than half-wired.
 */

export type TuiSize = {
  readonly columns: number;
  readonly rows: number;
};

export type TuiIo = {
  readonly choose?: (request: ChoiceRequest) => Promise<string | undefined>;
  readonly captureView?: () => ComposerView | undefined;
  readonly readLine: (prompt?: string) => Promise<string | undefined>;
  readonly write: (text: string) => void;
  readonly size: () => TuiSize;
  readonly onInterrupt?: (handler: () => void) => void;
  /**
   * How the shell defers a repaint (WP D3). Present, the shell hands over the
   * flush it wants to run later and this decides when; absent, the shell uses
   * its own timer.
   *
   * It is a capability rather than a hard-coded `setTimeout` for one reason:
   * the rule being kept — "a repaint never loses text and always leaves the
   * cursor where the next paint expects it" — is checkable without a clock if
   * the caller drives the schedule itself. A test that has to wait 33ms to
   * learn something would be a flaky test.
   */
  readonly schedule?: (flush: () => void, milliseconds: number) => void;
};

/**
 * What a context with no terminal to measure is assumed to be: the same 24
 * rows it always reported, and the width `frame.ts` already defaulted to.
 */
const DEFAULT_ROWS = 24;

/**
 * The line adapter: the TUI over the context's own line reader.
 *
 * The width comes from the context's `terminalSize` capability when the
 * composition root supplied one, which is to say on a real terminal. Absent —
 * every test, every piped `trylo` — a fixed width is used instead, and it is
 * the same width as before, so nothing that does not opt in changes.
 */
export function lineIoOf(ctx: CliContext): TuiIo {
  const interrupts = ctx.interrupts;
  const size = ctx.terminalSize;

  return {
    readLine: ctx.readLine,
    write: ctx.stderr,
    size: size ?? (() => ({ columns: DEFAULT_WIDTH, rows: DEFAULT_ROWS })),
    ...(interrupts === undefined
      ? {}
      : { onInterrupt: (handler: () => void) => interrupts.observe(handler) }),
  };
}
