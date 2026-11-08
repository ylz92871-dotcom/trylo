/**
 * The paste-burst machine (WP23.2 / C81, L39).
 *
 * A terminal that does not send bracketed paste delivers a paste as a burst of
 * ordinary characters, and a line editor that submits on Enter would fire the
 * first line of the paste as a command before the rest arrived. This machine
 * is the port of Codex's `bottom_pane/paste_burst.rs` semantics (source HEAD
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`), reduced to what a burst needs:
 *
 * - the first character is held briefly (`RetainFirstChar`) so ordinary typing
 *   never sees a flicker;
 * - a second character inside the char interval begins a buffer and *retro*
 *   -grabs the held one;
 * - the buffer flushes as one paste once characters stop arriving;
 * - an Enter inside the suppress window after a flush is the paste's final
 *   newline, not a submit.
 *
 * Constants are Codex's: 3 chars minimum, 8 ms char interval (60 ms idle flush
 * on Windows — a Windows console coalesces reads differently), 120 ms Enter
 * suppression. Events carry the caller's timestamps: this module owns no
 * clock, so the machine stays testable without one.
 */

/** A burst must reach this many characters to be called a paste. */
export const PASTE_BURST_MIN_CHARS = 3;
/** Maximum gap between two characters of one burst. */
export const PASTE_BURST_CHAR_INTERVAL_MS = 8;
/** Off-Windows idle flush window; Windows is decided from the injected platform. */
export const PASTE_BURST_FLUSH_IDLE_MS = 8;
/** On Windows the console delivers reads in its own rhythm; flush waits longer. */
export const PASTE_BURST_FLUSH_IDLE_WINDOWS_MS = 60;
/** An Enter this soon after a flush belongs to the paste, not to the submit. */
export const PASTE_ENTER_SUPPRESS_WINDOW_MS = 120;

export type BurstDecision =
  | { readonly kind: "pass"; readonly text: string }
  | { readonly kind: "held" }
  | { readonly kind: "buffered" }
  | { readonly kind: "flushed"; readonly text: string; readonly isPaste: boolean }
  /** An Enter the machine did not claim: it submits the line. */
  | { readonly kind: "submit" };

export type PasteBurst = {
  /** One printable character (or run of characters) arrived. */
  readonly char: (text: string, atMs: number) => ReadonlyArray<BurstDecision>;
  /** Enter arrived. */
  readonly enter: (atMs: number) => ReadonlyArray<BurstDecision>;
  /** End of input: what was held or buffered still belongs to the person. */
  readonly flush: () => ReadonlyArray<BurstDecision>;
};

/**
 * The platform is injected (the composition root's fact), because a console
 * that coalesces reads differently is a platform fact and this module must
 * stay free of `process`.
 */
export function createPasteBurst(platform: string = "posix"): PasteBurst {
  const flushIdleMs = platform === "win32" ? PASTE_BURST_FLUSH_IDLE_WINDOWS_MS : PASTE_BURST_FLUSH_IDLE_MS;
  let held: string | undefined;
  let buffer: string | undefined;
  let lastAtMs: number | undefined;
  let suppressEnterUntil = 0;

  /**
 * Whether a flushed burst deserves paste treatment (Codex's
 * `decide_begin_buffer` rule): text with whitespace in it — newlines above
 * all — is what a person cannot type quickly by hand, and so is any run long
 * enough that replaying it keystroke-by-keystroke would be absurd.
 */
function pasteLike(text: string): boolean {
  return /\s/.test(text) || text.length >= 16;
}

const idleFlush = (atMs: number): ReadonlyArray<BurstDecision> => {
    if (buffer === undefined || lastAtMs === undefined) {
      return [];
    }

    const idle = atMs - lastAtMs;
    const window = flushIdleMs;
    if (idle <= window) {
      return [];
    }

    const text = buffer;

    buffer = undefined;
    lastAtMs = undefined;

    return [{ kind: "flushed", text, isPaste: pasteLike(text) }];
  };

  return {
    char(text, atMs) {
      const decisions: BurstDecision[] = [];

      if (buffer !== undefined) {
        if (atMs - (lastAtMs ?? atMs) > PASTE_BURST_CHAR_INTERVAL_MS) {
          decisions.push(...idleFlush(atMs));
        }
      }

      if (buffer !== undefined) {
        buffer += text;
        lastAtMs = atMs;
        decisions.push({ kind: "buffered" });
        return decisions;
      }

      if (held === undefined) {
        held = text;
        lastAtMs = atMs;
        return [{ kind: "held" }];
      }

      if (atMs - (lastAtMs ?? atMs) <= PASTE_BURST_CHAR_INTERVAL_MS) {
        buffer = held + text;
        held = undefined;
        lastAtMs = atMs;
        return [...decisions, { kind: "buffered" }];
      }

      const released = held;

      held = text;
      lastAtMs = atMs;

      return [...decisions, { kind: "pass", text: released }];
    },

    enter(atMs) {
      const decisions: BurstDecision[] = [];

      if (held !== undefined) {
        decisions.push({ kind: "pass", text: held });
        held = undefined;
      }

      if (buffer !== undefined) {
        const text = buffer;

        buffer = undefined;
        lastAtMs = undefined;
        const paste = pasteLike(text);
        if (paste) {
          suppressEnterUntil = atMs + PASTE_ENTER_SUPPRESS_WINDOW_MS;
        }

        decisions.push({ kind: "flushed", text, isPaste: paste });

        return decisions;
      }

      if (atMs < suppressEnterUntil) {
        suppressEnterUntil = 0;
        // The Enter belonged to the paste that just flushed: it is the paste's
        // trailing newline, not a command to run. An empty `flushed` tells the
        // caller exactly that.
        decisions.push({ kind: "flushed", text: "", isPaste: true });
        return decisions;
      }

      decisions.push({ kind: "submit" });

      return decisions;
    },

    flush() {
      const decisions: BurstDecision[] = [];

      if (held !== undefined) {
        decisions.push({ kind: "pass", text: held });
        held = undefined;
      }

      if (buffer !== undefined) {
        decisions.push({ kind: "flushed", text: buffer, isPaste: pasteLike(buffer) });
        buffer = undefined;
      }

      return decisions;
    },
  };
}
