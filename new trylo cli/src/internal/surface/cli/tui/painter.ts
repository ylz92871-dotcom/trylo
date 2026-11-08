import { displayWidth, renderTurnBody } from "./frame.js";
import { renderComposer } from "./composer-view.js";
import type { TuiIo } from "./io.js";
import type { TuiState } from "./state.js";
import { noPaint, stripAnsi, type TuiPaint } from "./theme.js";
import { fitText } from "./text.js";

/**
 * The turn's live region (WP D3).
 *
 * Until this existed the shell collected every event and wrote the new lines
 * once, after the turn had ended, so a long answer appeared all at once. The
 * region is now redrawn as events arrive: the cursor moves back over the lines
 * this turn has already drawn (`\x1b[{n}A`), everything from there down is
 * cleared (`\x1b[J`), and the content is written again with the status bar
 * under it.
 *
 * Two properties are what make that safe. Nothing is dropped — a deferred
 * repaint draws the *latest* state, and `settle` draws once more whatever is
 * still pending, so the final paint always holds the whole turn. And the line
 * count is remembered exactly: the next paint moves up by the number of lines
 * the previous one wrote, not by the number it meant to write.
 *
 * Nothing here runs outside a terminal. The shell is only entered when stdin
 * is a TTY (`handleReplEntry`); a piped `trylo` is the line REPL itself, which
 * emits no cursor movement at all (WP D3, criterion A6).
 */

/** How long a repaint may be deferred: about thirty frames a second (WP D3). */
export const PAINT_INTERVAL_MS = 33;

export type Painter = {
  readonly refresh?: () => void;
  readonly dispose?: () => void;
  /** Redraw the turn's content so far. Coalesced; the text is never dropped. */
  readonly request: (state: TuiState) => void;
  /** One last redraw, without the status bar, and then nothing more. */
  readonly settle: (state: TuiState) => void;
  /** Pause repainting so an approval panel can own the terminal without being erased. */
  readonly pause: () => void;
  /** Resume repainting from the latest state. */
  readonly resume: () => void;
};

export function createPainter(io: TuiIo, before: number, paint: TuiPaint = noPaint): Painter {
  const schedule = io.schedule ?? defaultSchedule;
  let painted = 0;
  let pending = false;
  let closed = false;
  let paused = false;
  let latest: TuiState | undefined;
  let from = before;
  let previousRows: ReadonlyArray<string> = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  // Advanced on every repaint, which is what makes the spinner move: the frame
  // is redrawn about thirty times a second, and a screen that changes is a
  // screen nobody assumes has hung.
  let tick = 0;

  const draw = (state: TuiState, withStatus: boolean): void => {
    tick += 1;
    const width = io.size().columns;
    const input = withStatus ? io.captureView?.() : undefined;
    const inputRows = input === undefined ? [] : renderComposer(input, width).rows.slice(-5);
    const room = Math.max(3, io.size().rows - inputRows.length - 3);

    if (painted > 0) {
      painted = previousRows.reduce((count, row) => count + Math.max(1, Math.ceil(displayWidth(stripAnsi(row)) / Math.max(1, width))), 0);
      io.write(`\x1b[${painted}A`);
    }

    io.write("\x1b[J");
    // Completed text can enter native scrollback. Open reasoning may still be
    // folded, and a streaming message may be reformatted, so neither is committed.
    const stableEnd = state.reasoning?.from ?? state.lines.length;
    const stable = renderTurnBody({ ...state, lines: state.lines.slice(0, stableEnd), pending: undefined }, from, width, false, paint, tick);
    if (withStatus && stable.length > 0 && stable.split("\n").length > room) {
      io.write(`${stable}\n`);
      from = stableEnd;
    }

    const turnBody = renderTurnBody(state, from, width, withStatus, paint, tick);
    const rows = turnBody.split("\n");
    const visible = withStatus && rows.length > room
      ? [fitText("… 正在生成，完成后保留完整内容", width - 1), ...rows.slice(-(room - 1))]
      : rows;
    const body = [...visible, ...inputRows].join("\n");

    io.write(`${body}\n`);
    painted = withStatus ? body.split("\n").length : 0;
    previousRows = withStatus ? body.split("\n") : [];
  };

  return {
    refresh() { if (!paused && !closed && latest !== undefined) draw(latest, true); },

    dispose() {
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
    },

    request(state) {
      latest = state;

      if (io.schedule === undefined && heartbeat === undefined && state.running) {
        heartbeat = setInterval(() => {
          if (!paused && !closed && !pending && latest !== undefined) draw(latest, true);
        }, 120);
        heartbeat.unref();
      }

      if (paused || pending || closed) {
        return;
      }

      pending = true;
      schedule(() => {
        pending = false;
        if (!paused && !closed && latest !== undefined) {
          draw(latest, true);
        }
      }, PAINT_INTERVAL_MS);
    },

    settle(state) {
      closed = true;

      if (heartbeat !== undefined) clearInterval(heartbeat);

      pending = false;

      if (paused) {
        return;
      }

      draw(state, false);
    },

    pause() {
      paused = true;
      pending = false;
    },

    resume() {
      if (!paused) {
        return;
      }

      paused = false;

      if (!closed && latest !== undefined) {
        draw(latest, true);
      }
    },
  };
}

function defaultSchedule(flush: () => void, milliseconds: number): void {
  // A repaint must never be the reason the process is still alive.
  setTimeout(flush, milliseconds).unref();
}
