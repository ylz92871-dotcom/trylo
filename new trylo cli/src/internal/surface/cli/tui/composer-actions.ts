import type { KeyEvent } from "./keys.js";
import { resolveAction, strokeOf, type Binding, type ComposerAction, type Keystroke } from "./keybindings.js";
import type { ComposerBuffer } from "./composer-buffer.js";
import type { ComposerHistory } from "./composer-history.js";

/**
 * The bound-key path (WP23.2 / L46): the binding table between keys and
 * actions.
 *
 * Chords first — a stroke that only begins a sequence is remembered (with a
 * timeout) rather than applied — then the table, and a key no binding claims
 * falls through to the composer's own default handling. Ctrl-C and Ctrl-D
 * never reach this module: the shell owns them before the table is consulted,
 * and the loader refuses user bindings for them anyway.
 */

/** How long a half-typed chord stays alive (legacy's chord timeout). */
const CHORD_TIMEOUT_MS = 1000;

export type ActionOps = {
  readonly buffer: ComposerBuffer;
  readonly history: ComposerHistory;
  readonly submit: () => void;
  /** Open the external editor (the `external-editor` action). */
  readonly editor: () => void;
  /** An unbound key's default handling. */
  readonly defaultKey: (event: KeyEvent) => void;
  readonly now: () => number;
};

export function createActionDispatch(bindings: ReadonlyArray<Binding>, ops: ActionOps): (event: KeyEvent) => void {
  let chord: ReadonlyArray<Keystroke> = [];
  let chordAtMs = 0;

  const applyControl = (name: string): void => {
    switch (name) {
      case "u":
        ops.buffer.killBefore();
        return;
      case "k":
        ops.buffer.killAfter();
        return;
      case "w":
        ops.buffer.killWord();
        return;
      default:
        return;
    }
  };

  const dispatchAction = (action: ComposerAction): void => {
    switch (action) {
      case "submit":
        ops.submit();
        return;
      case "history-previous":
        ops.history.up();
        return;
      case "history-next":
        ops.history.down();
        return;
      case "history-search":
        ops.history.beginSearch();
        return;
      case "external-editor":
        ops.editor();
        return;
      case "kill-line-before":
        applyControl("u");
        return;
      case "kill-line-after":
        applyControl("k");
        return;
      case "kill-word":
        applyControl("w");
        return;
      case "beginning-of-line":
        ops.buffer.lineHome();
        return;
      case "end-of-line":
        ops.buffer.lineEnd();
        return;
    }
  };

  return (event: KeyEvent): void => {
    const atMs = ops.now();
    if (chord.length > 0 && atMs - chordAtMs > CHORD_TIMEOUT_MS) {
      chord = [];
    }

    const verdict = resolveAction(event, bindings, chord);
    if (verdict.kind === "chord") {
      const stroke = strokeOf(event);
      if (stroke !== undefined) {
        chord = [...chord, stroke];
        chordAtMs = atMs;
      }
      return;
    }

    chord = [];

    if (verdict.kind === "action") {
      dispatchAction(verdict.action);
      return;
    }

    ops.defaultKey(event);
  };
}
