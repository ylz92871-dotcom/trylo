import type { KeyEvent } from "./keys.js";

/**
 * The composer's history and history search (WP23.2 / L40).
 *
 * Split out of `composer.ts` because history is its own small machine: the
 * session's submitted lines, an up/down walk that ends on the draft the person
 * was typing, and the Ctrl-R search whose footer shows the current match.
 * The search semantics follow Codex's `history_search.rs` model — query edits
 * restart from the newest entry, Enter accepts the match as an editable
 * submission, Escape restores the draft — over this build's own history.
 */

/** How much history the session keeps. Generous; it is strings in an array. */
export const HISTORY_LIMIT = 200;

export type HistoryOps = {
  /** The text the person was typing before they walked into history. */
  readonly bufferText: () => string;
  /** Put text in the buffer with the cursor at its end. */
  readonly setBuffer: (text: string) => void;
  /** A redraw is wanted (the footer or buffer changed). */
  readonly draw: () => void;
  /** Submit whatever the buffer now holds. */
  readonly submit: () => void;
};

export type ComposerHistory = {
  /** A submitted line joins the history (blank and duplicate-free). */
  readonly remember: (line: string) => void;
  readonly up: () => void;
  readonly down: () => void;
  /** Whether the search footer is up. */
  readonly searching: () => boolean;
  readonly beginSearch: () => void;
  /** The footer row: the current match, or the failed-search note. */
  readonly footer: () => string | undefined;
  /**
   * One key while searching. Answers `true` when the key belonged to the
   * search; `false` means the search ended and the key should be handled
   * normally.
   */
  readonly key: (event: KeyEvent) => boolean;
  /** Take the search down without accepting; the buffer keeps its draft. */
  readonly endSearch: () => void;
};

export function createComposerHistory(ops: HistoryOps): ComposerHistory {
  let history: string[] = [];
  let historyIndex: number | undefined;
  let draftBeforeHistory: string | undefined;
  let search: { readonly query: string; readonly index: number } | undefined;

  const remember = (line: string): void => {
    if (line.trim().length === 0 || history[history.length - 1] === line) {
      return;
    }
    history = [...history, line].slice(-HISTORY_LIMIT);
  };

  /** The newest entry at or before `from` containing the query. */
  const searchMatch = (query: string, from: number): string | undefined => {
    if (query.length === 0) {
      return history[from] ?? history[history.length - 1];
    }

    for (let index = Math.min(from, history.length - 1); index >= 0; index -= 1) {
      const candidate = history[index] ?? "";
      if (candidate.includes(query)) {
        return candidate;
      }
    }

    return undefined;
  };

  const footer = (): string | undefined => {
    if (search === undefined) {
      return undefined;
    }
    const match = searchMatch(search.query, search.index);
    return match === undefined ? `(failed search) ${search.query}` : match;
  };

  const up = (): void => {
    if (history.length === 0) {
      return;
    }

    if (historyIndex === undefined) {
      draftBeforeHistory = ops.bufferText();
      historyIndex = history.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return;
    }

    ops.setBuffer(history[historyIndex] ?? "");
    ops.draw();
  };

  const down = (): void => {
    if (historyIndex === undefined) {
      return;
    }

    historyIndex += 1;

    if (historyIndex >= history.length) {
      historyIndex = undefined;
      ops.setBuffer(draftBeforeHistory ?? "");
      draftBeforeHistory = undefined;
    } else {
      ops.setBuffer(history[historyIndex] ?? "");
    }

    ops.draw();
  };

  const endSearch = (): void => {
    search = undefined;
  };

  const key = (event: KeyEvent): boolean => {
    const current = search;
    if (current === undefined) {
      return false;
    }

    switch (event.kind) {
      case "char":
        search = { query: current.query + event.text, index: current.index };
        ops.draw();
        return true;
      case "backspace":
        search = { query: current.query.slice(0, -1), index: current.index };
        ops.draw();
        return true;
      case "ctrl":
        if (event.name === "r") {
          const older = searchMatch(current.query, current.index - 1);
          search = { query: current.query, index: older === undefined ? current.index : current.index - 1 };
          ops.draw();
          return true;
        }
        endSearch();
        return false;
      case "enter": {
        const accepted = footer();

        endSearch();

        if (accepted !== undefined) {
          ops.setBuffer(accepted);
          ops.submit();
        }

        ops.draw();

        return true;
      }
      case "escape":
        endSearch();
        ops.draw();
        return true;
      default:
        endSearch();
        return false;
    }
  };

  return {
    remember,
    up,
    down,
    searching: () => search !== undefined,
    beginSearch: () => {
      search = { query: "", index: history.length - 1 };
    },
    footer,
    key,
    endSearch,
  };
}
