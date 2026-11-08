/**
 * The composer's buffer: text, cursor and the paste store (WP23.2 / C81).
 *
 * Split out of `composer.ts` because the buffer is a machine of its own — a
 * text, a cursor, and the placeholders a large paste leaves behind — while the
 * composer is a routing machine over keys, bursts and modes. The cursor moves
 * by code points (`trimOne`), so a surrogate pair is never cut in half; the
 * paste store keeps full pasted texts keyed by their placeholder, and
 * `expandPlaceholders` restores them at submission time.
 */

import { pastePlaceholder, pastePlaceholderId } from "./composer-view.js";

/** The token a large paste leaves in the buffer (see `composer-view.ts`). */
const PLACEHOLDER_PATTERN = /\[Pasted text #\d+ \+\d+ lines\]/g;

export type ComposerBuffer = {
  /** The whole buffer, newlines included. */
  readonly text: () => string;
  /** The cursor, as a UTF-16 offset into `text()`. */
  readonly cursor: () => number;
  readonly insert: (inserted: string) => void;
  readonly backspace: () => void;
  readonly deleteForward: () => void;
  readonly left: () => void;
  readonly right: () => void;
  readonly home: () => void;
  readonly end: () => void;
  readonly killBefore: () => void;
  readonly killAfter: () => void;
  readonly killWord: () => void;
  readonly lineHome: () => void;
  readonly lineEnd: () => void;
  /** A paste arrived: in full, or as a placeholder it remembers. */
  readonly acceptPaste: (pastedText: string) => void;
  /** Every placeholder replaced by the text it stands for. */
  readonly expandPlaceholders: (line: string) => string;
  readonly clear: () => void;
  readonly clearPasted: () => void;
  /** Whether the buffer ends with a one-line continuation backslash. */
  readonly endsWithContinuation: () => boolean;
  /** Drop that continuation backslash and close the line instead. */
  readonly takeContinuation: () => void;
};

export function createComposerBuffer(): ComposerBuffer {
  let text = "";
  let cursor = 0;
  const pasted = new Map<number, string>();
  let pastedCount = 0;

  const trimOne = (value: string): string => {
    const characters = Array.from(value);
    return characters.length === 0 ? value : value.slice(0, value.length - characters[characters.length - 1]!.length);
  };

  /** The mirror of `trimOne`: drop the *first* code point, for the keys that look forward. */
  const trimFirst = (value: string): string => {
    const characters = Array.from(value);
    return characters.length === 0 ? value : value.slice(characters[0]!.length);
  };

  return {
    text: () => text,
    cursor: () => cursor,

    insert(inserted) {
      text = text.slice(0, cursor) + inserted + text.slice(cursor);
      cursor += inserted.length;
    },

    backspace() {
      if (cursor > 0) {
        const before = trimOne(text.slice(0, cursor));
        text = before + text.slice(cursor);
        cursor = before.length;
      }
    },

    deleteForward() {
      text = text.slice(0, cursor) + trimFirst(text.slice(cursor));
    },

    left() {
      cursor = trimOne(text.slice(0, cursor)).length;
    },

    right() {
      cursor = text.length - trimFirst(text.slice(cursor)).length;
    },

    home() {
      this.lineHome();
    },

    end() {
      this.lineEnd();
    },

    killBefore() {
      text = text.slice(cursor);
      cursor = 0;
    },

    killAfter() {
      text = text.slice(0, cursor);
    },

    killWord() {
      const before = text.slice(0, cursor);
      const cut = before.replace(/\S*\s*$/, "");
      text = cut + text.slice(cursor);
      cursor = cut.length;
    },

    lineHome() {
      cursor = text.lastIndexOf("\n", cursor - 1) + 1;
    },

    lineEnd() {
      const next = text.indexOf("\n", cursor);
      cursor = next === -1 ? text.length : next;
    },

    acceptPaste(pastedText) {
      pastedCount += 1;
      const placeholder = pastePlaceholder(pastedCount, pastedText);
      if (placeholder === undefined) {
        this.insert(pastedText);
        return;
      }

      pasted.set(pastedCount, pastedText);
      this.insert(placeholder);
    },

    expandPlaceholders(line) {
      let expanded = line;

      for (const token of line.match(PLACEHOLDER_PATTERN) ?? []) {
        const id = pastePlaceholderId(token);
        const stored = id === undefined ? undefined : pasted.get(id);
        if (stored !== undefined) {
          expanded = expanded.replace(token, stored);
        }
      }

      return expanded;
    },

    clear() {
      text = "";
      cursor = 0;
    },

    clearPasted() {
      pasted.clear();
    },

    endsWithContinuation() {
      return /(^|[^\\])\\$/.test(text) || text === "\\";
    },

    takeContinuation() {
      text = `${text.slice(0, -1)}\n`;
      cursor = text.length;
    },
  };
}
