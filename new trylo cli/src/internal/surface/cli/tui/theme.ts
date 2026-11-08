import type { TuiTone } from "./state.js";

/**
 * The tone-to-escape-sequence table: the one place that knows what colour a
 * kind of line is.
 *
 * Every mature terminal UI this build was measured against keeps this as an
 * indirection rather than scattering `\x1b[` literals through the renderer —
 * codex has `StatusTone`, gemini-cli has `semantic-tokens`, opencode has a
 * `Theme` type with an ANSI fallback, goose has `accent()/success()/danger()`.
 * The reason is always the same: the renderer says *what* a line means, and
 * this table decides *how* it looks, so a terminal that cannot do colour gets
 * a different answer without the renderer knowing.
 *
 * The palette is deliberately the 16-colour ANSI set, not truecolor. A CLI
 * runs on whatever terminal the person already has, including ones that
 * report eight colours, and 16 is the most that survives that. Bright variants
 * are avoided for the same reason: on several terminals "bright" is really
 * "bold", which would make every tool line shout.
 *
 * Nothing here emits a sequence on its own. A style is a value; `paint` is the
 * only function that puts one around text, so a caller that never paints gets
 * byte-identical output to a build without this file at all.
 */

export type TuiStyle = {
  /** SGR parameters, without the CSI prefix or the `m`. Empty means no change. */
  readonly sgr: string;
};

/** Deliberately styled as nothing: what a terminal that cannot do colour gets. */
export const NO_STYLE: TuiStyle = { sgr: "" };

const TONE_STYLES: Readonly<Record<TuiTone, TuiStyle>> = {
  // The person's own words. Marked by weight, not hue, so it reads as theirs
  // even on a monochrome terminal.
  user: { sgr: "1" },
  // The model's answer: the default. Understating it is the point — it is most
  // of the screen, and colouring it would colour everything.
  assistant: NO_STYLE,
  // Thinking is scaffolding, not answer. Dimmed so the eye skips it on a
  // second read without it being deleted.
  reasoning: { sgr: "2" },
  tool: { sgr: "36" },
  // Quoted tool output. Dimmed because it is the only text on screen that is
  // neither the person's nor the model's: it has to be readable and obviously
  // second-hand at the same time.
  output: { sgr: "2" },
  // A diff is the one place where colour is information rather than emphasis:
  // added and removed are different facts, not louder versions of the same one.
  // Green for added, red for removed — the convention every diff viewer uses,
  // so it needs no legend. 32 and 31 are the standard ANSI green and red.
  added: { sgr: "32" },
  removed: { sgr: "31" },
  warning: { sgr: "33" },
  system: { sgr: "2" },
  // A heading or bold run the answer itself asked for. Weight, not hue, for the
  // same reason `user` is weight: it must survive a monochrome terminal.
  strong: { sgr: "1" },
  // A quoted row. Dimmed like reasoning: it is the model quoting someone else.
  quote: { sgr: "2" },
};

export function styleForTone(tone: TuiTone): TuiStyle {
  return TONE_STYLES[tone];
}

/**
 * How one rendered line becomes terminal text.
 *
 * The contract that matters: `paint` receives a line that has **already been
 * wrapped**, and returns that line with a sequence at each end. Colour is
 * therefore never applied before measuring, and a hard wrap can never cut an
 * escape sequence in half — which is the invariant `frame.ts` existed to hold.
 */
export type TuiPaint = (tone: TuiTone, line: string) => string;

/** The renderer's default: no sequences at all, so existing output is unchanged. */
export const noPaint: TuiPaint = (_tone, line) => line;

export function colorPaint(): TuiPaint {
  return (tone, line) => wrap(line, styleForTone(tone));
}

function wrap(text: string, style: TuiStyle): string {
  if (style.sgr.length === 0 || text.length === 0) {
    return text;
  }
  return `\x1b[${style.sgr}m${text}\x1b[0m`;
}

/**
 * Whether this terminal should be given colour at all.
 *
 * `NO_COLOR` is the cross-tool convention (no-color.org): set and non-empty
 * means "do not", whatever the terminal claims. `TERM=dumb` is the older
 * signal and still appears on CI and on serial consoles.
 *
 * Piped output is excluded here rather than at the renderer: a frame written
 * to a file or to a parent process is data, and escape sequences in data are
 * noise the reader has to strip. `cmd/trylo/main.ts` already knows whether
 * stdin is a terminal, and it is the only file allowed to look.
 */
export function colorsEnabled(
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): boolean {
  if (!isTty) {
    return false;
  }

  if (env.TERM === "dumb") {
    return false;
  }

  const off = env.NO_COLOR;

  return off === undefined || off === "";
}

/** Remove every SGR sequence. Used by tests and by anything measuring width. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * How much colour this terminal can be trusted with.
 *
 * `colorsEnabled` answers "any at all"; this answers "how much". The tones in
 * `TONE_STYLES` stay on the 16-colour set because they carry meaning and 16 is
 * the most that survives an unknown terminal. The brand mark is different: it is
 * the one thing on the screen whose exact colour is the identity, and the site
 * spells it as a hex pair, so it is worth a wider channel where the terminal
 * advertises one.
 *
 * `COLORTERM` is the only signal that exists. Windows Terminal, kitty, alacritty,
 * WezTerm and the VS Code terminal all set `truecolor`; anything that does not
 * say is treated as 16 colours, because guessing high and being wrong produces
 * literal digits on the screen.
 */
export type ColorDepth = "none" | "ansi16" | "truecolor";

export function colorDepthOf(
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): ColorDepth {
  if (!colorsEnabled(env, isTty)) {
    return "none";
  }
  const ct = env.COLORTERM;
  return ct === "truecolor" || ct === "24bit" ? "truecolor" : "ansi16";
}

/**
 * The mark's ramp: the artwork's own bone (`--bone`, #F2EDE1) at the top,
 * deepening into the site's accent gold (`--accent`, #DCC97E) at the bottom.
 *
 * Both stops are tokens the website already defines, which is the only reason
 * they are allowed here. A bone-to-bone ramp was tried first and rendered
 * indistinguishable from the terminal's default grey — the mark is painted
 * precisely so that it stops being grey.
 */
const MARK_TOP = [242, 237, 225] as const;
const MARK_BOTTOM = [220, 201, 126] as const;

/**
 * How the startup mark is painted.
 *
 * On a truecolor terminal this is the brand ramp; on a 16-colour one it is the
 * brightest white the palette has, which at least separates the mark from body
 * text; on a terminal that asked for no colour it is the row itself.
 */
export function markPainterFor(
  depth: ColorDepth,
  rows: number,
): (row: string, at: number) => string {
  if (depth === "none") {
    return (row) => row;
  }

  if (depth === "ansi16") {
    return (row) => (row.length === 0 ? row : `\x1b[97m${row}\x1b[0m`);
  }

  return (row, at) => {
    if (row.length === 0) {
      return row;
    }

    const t = rows <= 1 ? 0 : at / (rows - 1);
    const mix = (from: number, to: number): number => Math.round(from + (to - from) * t);
    const r = mix(MARK_TOP[0], MARK_BOTTOM[0]);
    const g = mix(MARK_TOP[1], MARK_BOTTOM[1]);
    const b = mix(MARK_TOP[2], MARK_BOTTOM[2]);

    return `\x1b[38;2;${r};${g};${b}m${row}\x1b[0m`;
  };
}
