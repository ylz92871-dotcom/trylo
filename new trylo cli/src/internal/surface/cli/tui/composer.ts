import { createKeyDecoder, type KeyDecoder, type KeyEvent } from "./keys.js";
import { createPasteBurst } from "./paste-burst.js";
import { renderComposer, type ComposerView } from "./composer-view.js";
import { resolveBindings, type Binding } from "./keybindings.js";
import { createComposerBuffer } from "./composer-buffer.js";
import { createComposerHistory } from "./composer-history.js";
import { applyBurstDecisions, applyBurstEnter } from "./composer-paste.js";
import { createActionDispatch } from "./composer-actions.js";
import { createChoice, type ChoiceRequest } from "./choice.js";
import { createCommandMenu } from "./composer-commands.js";
import { createComposerScreen } from "./composer-screen.js";
import { applyComposerKey } from "./composer-key.js";

/**
 * The prompt composer (WP23.2 / C81, L39, L40).
 *
 * The raw key source feeds it; it owns the one echo of what the person is
 * typing, and routes keys to the machines that do the work: the buffer
 * (`composer-buffer.ts`) for text and pastes, history (`composer-history.ts`)
 * for the walk and the Ctrl-R search, the binding table (`keybindings.ts`)
 * for everything a person may rebind. What it does *not* own is where lines
 * go after Enter — at the prompt the caller resolves the composed text,
 * mid-run the input queue stages it (`mid-run-input.ts`), and a foreign
 * reader (the approval panel, a menu, the echo-off secret reader) is wrapped
 * by `borrowTerminal`, which suspends this composer so two readers never hold
 * the same stream.
 *
 * Paste protection has two layers and trusts them in this order: a bracketed
 * paste the terminal announced is a paste, full stop; everything else runs
 * through the burst machine (`paste-burst.ts`), whose semantics are ported
 * from Codex. A paste arrives as one string with its newlines inside — one
 * submission, never one command per line.
 *
 * Ctrl-C is not decided here: the key is routed to the shell's interrupt
 * machine (`interrupt.ts`), which already owns the once-cancels, twice-exits
 * contract; this module only carries out the "clear the line" action it is
 * told about.
 */

export type ComposerIo = {
  readonly write: (text: string) => void;
  readonly columns: () => number;
};

/**
 * The terminal, as the composer may use it. `start` delivers decoded chunks
 * and takes raw mode; `suspend` detaches the listener and leaves raw mode, so
 * a foreign reader owns the stream alone; `resume` undoes `suspend`; `stop`
 * is final. Raw mode follows the listener because with it on the terminal
 * sends bytes instead of lines.
 */
export type ComposerKeys = {
  readonly start: (onChunk: (chunk: string) => void) => void;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly stop: () => void;
};

/** What the interrupt machine decided; the composer only obeys it. */
export type ComposerInterrupt = { readonly kind: "none" } | { readonly kind: "clear_input"; readonly note: string };

export type ComposerOptions = {
  readonly io: ComposerIo;
  readonly keys: ComposerKeys;
  readonly platform?: string;
  /** Asked once per Ctrl-C; the shell's machine, not this file, decides. */
  readonly onInterrupt?: () => ComposerInterrupt;
  /** Open the buffer in the user's editor; absent means the action does nothing. */
  readonly editInEditor?: (text: string) => Promise<string | undefined>;
  /** The effective binding table; absent means the defaults. */
  readonly bindings?: ReadonlyArray<Binding>;
  /** Milliseconds since the epoch, for the burst machine's intervals. */
  readonly now?: () => number;
  /** An idle flush releases the last typed character without a second key. */
  readonly schedule?: (flush: () => void, milliseconds: number) => () => void;
  readonly onCaptureChange?: () => void;
};

export type Composer = {
  readonly choose: (request: ChoiceRequest) => Promise<string | undefined>;
  readonly captureView: () => ComposerView | undefined;
  /**
   * Compose one line at the prompt. Resolves with the submitted text (a paste
   * may contain newlines), or `undefined` at end of input.
   */
  readonly compose: (prompt?: string) => Promise<string | undefined>;
  /** Capture mid-run submissions; the painter displays the draft through captureView. */
  readonly beginCapture: (onLine: (line: string) => void) => void;
  readonly endCapture: () => void;
  /** True once the person ended input (Ctrl-D on an empty buffer). */
  readonly isEof: () => boolean;
  /**
   * A line submitted when nobody was composing and nothing was capturing —
   * typeahead between the prompts. Served before the next composition, in
   * order; words are never dropped because they arrived between two readers.
   */
  readonly takePending: () => string | undefined;
  /**
   * Lend the terminal to another reader: the composer stops listening and
   * leaves raw mode, the borrowed read runs, and listening resumes after.
   */
  readonly borrowTerminal: <T>(read: () => Promise<T>) => Promise<T>;
  /** Stop for good: detach from the key source and leave raw mode. */
  readonly stop: () => void;
};

export function createComposer(options: ComposerOptions): Composer {
  const io = options.io;
  const keys = options.keys;
  const now = options.now ?? Date.now;
  const burst = createPasteBurst(options.platform);
  const decoder: KeyDecoder = createKeyDecoder();
  const bindings = options.bindings ?? resolveBindings([]);
  const buf = createComposerBuffer();

  let prompt = "";
  /** The prompt's own waiter, when one is composing. */
  let composing: ((line: string | undefined) => void) | undefined;
  let onCaptureLine: ((line: string) => void) | undefined;
  let eof = false;
  let stopped = false;
  let loans = 0;
  let cancelFlush: (() => void) | undefined;
  const screen = createComposerScreen(io);
  const commandMenu = createCommandMenu();
  let panel: { readonly model: ReturnType<typeof createChoice>; readonly resolve: (id: string | undefined) => void } | undefined;
  const schedule = options.schedule ?? scheduleFlush;
  /** Lines submitted when no reader was listening; served in order, first. */
  const pending: string[] = [];

  const live = (): boolean => composing !== undefined;

  const commands = () => live() ? commandMenu.matches(buf.text()) : [];

  const draw = (): void => {
    if (loans > 0 || stopped) {
      return;
    }

    if (panel !== undefined) {
      const rows = panel.model.rows(io.columns());
      screen.draw(rows, rows.length - 1, 0);
      return;
    }

    if (!live()) {
      if (onCaptureLine !== undefined) options.onCaptureChange?.();
      return;
    }

    const view: ComposerView = { text: buf.text(), cursor: buf.cursor(), prompt, footer: hist.footer() };
    const composed = renderComposer(view, io.columns());

    screen.draw([...composed.rows, ...commandMenu.rows(buf.text(), io.columns())], composed.cursorRow, composed.cursorColumn);
  };

  const hist = createComposerHistory({
    bufferText: () => buf.text(),

    setBuffer: (text) => {
      buf.clear();
      buf.insert(text);
    },

    draw,
    submit: () => submit(),
  });

  const pasteOps = { buffer: buf, submit: () => submit() };

  const submit = (): void => {
    // The buffer may never have been drawn (a burst the Enter itself flushed),
    // so echo what is there before sending it — a submission that appears on
    // screen only as its answer would be a submission nobody saw.
    commandMenu.hide(buf.text());
    draw();
    const expanded = buf.expandPlaceholders(buf.text()).replace(/\n$/, "");

    buf.clear();
    buf.clearPasted();
    hist.endSearch();
    hist.remember(expanded);
    const resolve = composing;

    composing = undefined;

    if (resolve !== undefined || onCaptureLine === undefined) io.write("\r\n");

    screen.reset();

    if (resolve !== undefined) {
      resolve(expanded);
    } else if (onCaptureLine !== undefined) {
      onCaptureLine(expanded);
    } else {
      pending.push(expanded);
    }
  };

  const endCompose = (line: string | undefined): void => {
    const resolve = composing;
    composing = undefined;
    buf.clear();
    hist.endSearch();
    resolve?.(line);
  };

  const applyBound = createActionDispatch(bindings, {
    buffer: buf,
    history: hist,
    submit: () => submit(),
    editor: () => void openInEditor(),
    defaultKey: (event) => applyComposerKey(event, { buffer: buf, history: hist, menu: commandMenu, submit }),
    now,
  });

  keys.start((chunk) => {
    if (stopped || loans > 0) {
      return;
    }

    const atMs = now();

    cancelFlush?.();
    cancelFlush = undefined;

    for (const event of decoder.push(chunk)) {
      if (panel !== undefined) {
        const step = panel.model.key(event);
        if (step.kind === "done") {
          const resolve = panel.resolve;
          panel = undefined;
          screen.clear();
          resolve(step.id);
        }

        continue;
      }

      if (event.kind === "char" && hist.searching()) {
        // While searching, what the person types is the query, not the line.
        hist.key(event);
        continue;
      }

      if (event.kind === "char") {
        // Typed characters go through the burst machine: a fast run of them
        // that a terminal never announced is how a paste looks without
        // bracketed paste.
        applyBurstDecisions(burst.char(event.text, atMs), pasteOps);
      } else if (event.kind === "enter") {
        if (hist.searching()) {
          hist.key(event);
          continue;
        }

        if (commands().length > 0) {
          applyBurstDecisions(burst.flush(), pasteOps);
          const selected = commandMenu.selected(buf.text());
          if (selected !== undefined && selected.name !== buf.text()) {
            buf.clear();
            buf.insert(selected.name + (selected.arg?.startsWith("<") === true ? " " : ""));
            commandMenu.hide(buf.text());
            if (selected.arg?.startsWith("<") !== true) submit();
            continue;
          }
        }

        applyBurstEnter(burst.enter(atMs), pasteOps);
      } else {
        // A control or navigation key ends any burst in progress first: the
        // chars it holds belong in the buffer before the key edits it — and
        // before Ctrl-C wipes it.
        applyBurstDecisions(burst.flush(), pasteOps);

        if (commands().length > 0 && (event.kind === "up" || event.kind === "down")) {
          commandMenu.move(buf.text(), event.kind === "up" ? -1 : 1);
          continue;
        }

        // Ctrl-C / Ctrl-D belong to the shell before the table.
        if (shellKey(event)) {
          continue;
        }

        if (hist.searching()) {
          hist.key(event);
          continue;
        }

        applyBound(event);
      }
    }

    draw();

    if (panel === undefined) {
      cancelFlush = schedule(() => {
        cancelFlush = undefined;
        if (stopped || loans > 0) return;
        applyBurstDecisions(burst.flush(), pasteOps);
        draw();
      }, options.platform === "win32" ? 60 : 10);
    }
  });

  const controlInterrupt = (): void => {
    const action = options.onInterrupt?.() ?? { kind: "none" as const };
    if (action.kind === "clear_input") {
      buf.clear();
      io.write(`\r\n${action.note}\n`);
      draw();
    }
  };

  const openInEditor = async (): Promise<void> => {
    const edit = options.editInEditor;
    if (edit === undefined) {
      return;
    }

    const edited = await borrowTerminalDuring(async () => {
      io.write("\r\n");
      return edit(buf.expandPlaceholders(buf.text()));
    });
    if (edited !== undefined) {
      buf.clear();
      buf.insert(edited.replace(/\n$/, ""));
    }

    draw();
  };

  return {
    captureView: () => onCaptureLine === undefined ? undefined : {
      text: buf.text(), cursor: buf.cursor(), prompt: "追加 › ", footer: "Enter 追加到本轮 · 未及时送达的消息会进入下一轮",
    },

    choose(request) {
      if (panel !== undefined || composing !== undefined) return Promise.reject(new Error("terminal_selector_busy"));

      cancelFlush?.();
      applyBurstDecisions(burst.flush(), pasteOps);

      return new Promise(resolve => {
        panel = { model: createChoice(request), resolve };
        draw();
      });
    },

    compose(nextPrompt) {
      prompt = nextPrompt ?? "";

      if (eof) {
        return Promise.resolve(undefined);
      }

      return new Promise<string | undefined>((resolve) => {
        composing = resolve;
        commandMenu.show();
        draw();
      });
    },

    beginCapture(next) {
      onCaptureLine = next;
    },
    endCapture() {
      onCaptureLine = undefined;
    },
    isEof() {
      return eof;
    },
    takePending() {
      return pending.shift();
    },
    async borrowTerminal(read) {
      return borrowTerminalDuring(read);
    },

    stop() {
      stopped = true;
      cancelFlush?.();
      panel?.resolve(undefined);
      panel = undefined;
      endCompose(undefined);
      keys.stop();
    },
  };

  async function borrowTerminalDuring<T>(read: () => Promise<T>): Promise<T> {
    cancelFlush?.();
    applyBurstDecisions(burst.flush(), pasteOps);
    loans++;

    if (loans === 1) keys.suspend();

    try {
      return await read();
    } finally {
      loans--;
      if (!stopped && loans === 0) {
        keys.resume();
        draw();
      }
    }
  }

  // Ctrl-C and Ctrl-D are the two keys whose meaning belongs to the shell, so
  // they are intercepted before the buffer sees them — and they are not
  // rebindable (`keybindings.ts` refuses them at load, this file refuses them
  // at dispatch). Answers whether the key was consumed.
  function shellKey(event: KeyEvent): boolean {
    if (event.kind !== "ctrl") {
      return false;
    }

    if (event.name === "c") {
      controlInterrupt();
      return true;
    }

    if (event.name === "d") {
      if (buf.text().length === 0) {
        eof = true;
        endCompose(undefined);
      }
      return true;
    }

    return false;
  }
}

function scheduleFlush(flush: () => void, milliseconds: number): () => void {
  const timer = setTimeout(flush, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}
