import type { CliContext } from "../context.js";
import { lineIoOf, type TuiIo } from "./io.js";
import type { Painter } from "./painter.js";
import type { InterruptHub } from "./interrupt-hub.js";
import { tuiApprovalCallbacks } from "./approval-ui.js";
import { createComposer, type Composer, type ComposerInterrupt } from "./composer.js";
import { loadUserBindings, resolveBindings } from "./keybindings.js";
import { tryloHome } from "../session-paths.js";

/**
 * Session assembly for the composer (WP23.2).
 *
 * Split out of `entry.ts` because the entry is the shell's shape — the loop
 * and the slash table — while this is wiring: build the composer when the
 * composition root lends a key stream, and make every reader that is not the
 * composer (the approval panel, the menus, the echo-off secret reader) borrow
 * the terminal for the duration of its read. Borrowing is the whole
 * soundness argument: the composer's key listener and a foreign reader never
 * hold the same stream at once.
 */

export type ComposerWiring = {
  /** The line IO the shell and every panel read through. */
  readonly io: TuiIo;
  /** The context the shell runs under, with borrowed readers bound in. */
  readonly ctx: CliContext;
  readonly composer: Composer | undefined;
  readonly hubRef: { current?: InterruptHub | undefined };
};

export function wireComposer(ctx: CliContext, painterRef: { current?: Painter | undefined }): ComposerWiring {
  const io0 = lineIoOf(ctx);
  /**
   * The user's keybindings (WP23.2 / L46), read once when the session opens.
   * A file that does not parse leaves the defaults in place and says so once,
   * here, before the first prompt.
   */
  const loadedBindings = loadUserBindings(ctx.readFile, ctx.homeDir, tryloHome(ctx.homeDir, ctx.env));
  const hubRef: { current?: InterruptHub | undefined } = {};
  const forwardInterrupt = (): ComposerInterrupt => {
    const hub = hubRef.current;
    if (hub === undefined) {
      return { kind: "none" };
    }

    const action = hub.notify();

    return action.kind === "clear_input"
      ? { kind: "clear_input", note: action.note }
      : { kind: "none" };
  };
  /**
   * The composer (WP23.2) when the composition root lends a key stream: it
   * owns the prompt line, paste protection, history and the history search.
   * Its Ctrl-C is routed to the shell's interrupt machine through the
   * forwarder above, which the hub fills in once it exists.
   */
  const composer = ctx.keys === undefined ? undefined : createComposer({
    io: { write: io0.write, columns: () => io0.size().columns },
    keys: ctx.keys,
    ...(ctx.platform === undefined ? {} : { platform: ctx.platform }),
    now: ctx.now,
    ...(ctx.editInEditor === undefined ? {} : { editInEditor: async (text: string) => {
      const painter = painterRef.current;
      painter?.pause();
      try { return await ctx.editInEditor?.(text); }
      finally { painter?.resume(); }
    } }),
    bindings: resolveBindings(loadedBindings.bindings),
    onInterrupt: forwardInterrupt,
    onCaptureChange: () => painterRef.current?.refresh?.(),
  });

  if (loadedBindings.problem !== undefined) {
    io0.write(`${loadedBindings.problem}\n`);
  }

  const borrowedReadLine = composer === undefined
    ? io0.readLine
    : (prompt?: string) => composer.borrowTerminal(() => io0.readLine(prompt));
  const borrowedReadSecret = composer === undefined
    ? ctx.readSecret
    : () => composer.borrowTerminal(() => ctx.readSecret());
  const io: TuiIo = composer === undefined ? io0 : { ...io0, readLine: borrowedReadLine, choose: composer.choose, captureView: composer.captureView };
  const wiredCtx: CliContext = {
    ...ctx,
    readLine: borrowedReadLine,
    readSecret: borrowedReadSecret,
    approval: tuiApprovalCallbacks(io, painterRef),
  };

  return { io, ctx: wiredCtx, composer, hubRef };
}
