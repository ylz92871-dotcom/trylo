/**
 * Keybindings: the parser, the defaults and the user layer (WP23.2 / L46).
 *
 * The keystroke *grammar* is the legacy build's (`src/keybindings/parser.ts`,
 * git-object `ead1a1a8f99de0322f000fe2706f19a6490be916`): `"ctrl+r"`,
 * `"ctrl+shift+-"`, chords as space-separated sequences. The runtime match is
 * adapted to this build's `KeyEvent` instead of Ink's `Key`, and the user file
 * is read through the injected reader rather than chokidar — same format,
 * same override rule (user bindings append after defaults and win), no file
 * watcher this build (a watcher is a capability this surface does not have
 * yet; the file is re-read when a session opens).
 *
 * Two keys are not rebindable, exactly as legacy's `reservedShortcuts`
 * decides: Ctrl-C and Ctrl-D. A binding file that rebinds them is ignored for
 * those keys, not rejected whole — one bad line should not cost the user
 * their other bindings.
 */

import type { KeyEvent } from "./keys.js";

/** A parsed keystroke: the key plus its modifiers. */
export type Keystroke = {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
};

/** A binding: one keystroke (or chord) mapped to one action. */
export type Binding = {
  readonly strokes: ReadonlyArray<Keystroke>;
  readonly action: ComposerAction;
};

/** What the composer can be told to do. Names are the contract. */
export type ComposerAction =
  | "submit"
  | "history-previous"
  | "history-next"
  | "history-search"
  | "external-editor"
  | "kill-line-before"
  | "kill-line-after"
  | "kill-word"
  | "beginning-of-line"
  | "end-of-line";

/**
 * The grammar: `mod+mod+key`, lower-cased; `esc`/`return`/`space` and the
 * arrow names are accepted aliases. Answers undefined for anything else —
 * an unparsable stroke is dropped, not guessed.
 */
export function parseKeystroke(spec: string): Keystroke | undefined {
  const parts = spec.trim().toLowerCase().split("+").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }

  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | undefined;

  for (const part of parts) {
    if (part === "ctrl" || part === "control") {
      ctrl = true;
      continue;
    }

    if (part === "alt" || part === "opt" || part === "option") {
      alt = true;
      continue;
    }

    if (part === "shift") {
      shift = true;
      continue;
    }

    if (key !== undefined) {
      return undefined;
    }

    key = ALIASES[part] ?? part;
  }

  if (key === undefined || key.length === 0) {
    return undefined;
  }

  return { key, ctrl, alt, shift };
}

const ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  space: " ",
};

function parseBinding(entry: unknown): Binding | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }

  const record = entry as Record<string, unknown>;
  const rawStroke = record["key"];
  const action = record["action"];
  if (typeof rawStroke !== "string" || typeof action !== "string") {
    return undefined;
  }

  const strokes = rawStroke
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map(parseKeystroke);
  if (strokes.length === 0 || strokes.some((stroke) => stroke === undefined)) {
    return undefined;
  }

  if (!isComposerAction(action)) {
    return undefined;
  }

  return { strokes: strokes as ReadonlyArray<Keystroke>, action };
}

function isComposerAction(value: string): value is ComposerAction {
  return COMPOSER_ACTIONS.includes(value as ComposerAction);
}

const COMPOSER_ACTIONS: ReadonlyArray<ComposerAction> = [
  "submit",
  "history-previous",
  "history-next",
  "history-search",
  "external-editor",
  "kill-line-before",
  "kill-line-after",
  "kill-word",
  "beginning-of-line",
  "end-of-line",
];

/**
 * The defaults, before any user file: the readline-ish set a person expects.
 * Interrupt (Ctrl-C) and end-of-input (Ctrl-D) are deliberately absent —
 * they are not rebindable and never reach this table.
 */
export const DEFAULT_BINDINGS: ReadonlyArray<Binding> = [
  binding("enter", "submit"),
  binding("up", "history-previous"),
  binding("down", "history-next"),
  binding("ctrl+r", "history-search"),
  binding("ctrl+g", "external-editor"),
  binding("ctrl+u", "kill-line-before"),
  binding("ctrl+k", "kill-line-after"),
  binding("ctrl+w", "kill-word"),
  binding("ctrl+a", "beginning-of-line"),
  binding("ctrl+e", "end-of-line"),
];

function binding(stroke: string, action: ComposerAction): Binding {
  const parsed = parseKeystroke(stroke);
  if (parsed === undefined) {
    throw new Error(`built-in binding ${stroke} does not parse`);
  }
  return { strokes: [parsed], action };
}

/**
 * The user layer: `<home>/.trylo/keybindings.json`, an array of
 * `{ "key": "ctrl+r", "action": "history-search" }`. A missing file is the
 * common case and means defaults only; a malformed file means defaults plus a
 * note, never a broken composer.
 */
export function loadUserBindings(
  readFile: (absolutePath: string) => string | undefined,
  homeDir: string,
  profileDir = `${homeDir}/.trylo`,
): { readonly bindings: ReadonlyArray<Binding>; readonly problem?: string } {
  const text = readFile(`${profileDir}/keybindings.json`);
  if (text === undefined) {
    return { bindings: [] };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { bindings: [], problem: "keybindings.json is not valid JSON; defaults are in use" };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["bindings"])
      ? ((parsed as Record<string, unknown>)["bindings"] as unknown[])
      : undefined;
  if (list === undefined) {
    return { bindings: [], problem: "keybindings.json must be an array of {key, action}; defaults are in use" };
  }

  const bindings: Array<Binding> = [];

  for (const entry of list) {
    const parsed = parseBinding(entry);
    if (parsed !== undefined) {
      bindings.push(parsed);
    }
  }

  return { bindings };
}

/** Whether a user binding claims a reserved key: it is then refused. */
function isReserved(stroke: Keystroke): boolean {
  return stroke.ctrl && !stroke.alt && !stroke.shift && (stroke.key === "c" || stroke.key === "d");
}

/** The effective table: user bindings win, defaults fill the rest. */
export function resolveBindings(user: ReadonlyArray<Binding>): ReadonlyArray<Binding> {
  const defaulted = user.filter((entry) => entry.strokes.every((stroke) => !isReserved(stroke)));
  return [...defaulted, ...DEFAULT_BINDINGS];
}

/**
 * Match one key event against the table. Chords are supported: an event that
 * begins a chord answers `"chord"` and the caller keeps its state; a later
 * event completes it. One-key bindings match immediately.
 */
export function resolveAction(
  event: KeyEvent,
  bindings: ReadonlyArray<Binding>,
  chord: ReadonlyArray<Keystroke> = [],
): { readonly kind: "action"; readonly action: ComposerAction } | { readonly kind: "chord" } | { readonly kind: "none" } {
  const stroke = strokeOf(event);
  if (stroke === undefined) {
    return { kind: "none" };
  }

  const sequence = [...chord, stroke];
  let matchedChord = false;

  for (const entry of bindings) {
    if (entry.strokes.length < sequence.length) {
      continue;
    }

    const prefixMatch = sequence.every((stroke, index) => strokesEqual(stroke, entry.strokes[index] ?? stroke));
    if (!prefixMatch) {
      continue;
    }

    if (entry.strokes.length === sequence.length) {
      return { kind: "action", action: entry.action };
    }

    matchedChord = true;
  }

  return matchedChord ? { kind: "chord" } : { kind: "none" };
}

function strokesEqual(a: Keystroke, b: Keystroke): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

/** This build's key event, in the grammar's terms. */
export function strokeOf(event: KeyEvent): Keystroke | undefined {
  switch (event.kind) {
    case "char":
      return { key: event.text, ctrl: false, alt: false, shift: false };
    case "enter":
      return { key: "enter", ctrl: false, alt: false, shift: false };
    case "tab":
      return { key: "tab", ctrl: false, alt: false, shift: false };
    case "backspace":
      return { key: "backspace", ctrl: false, alt: false, shift: false };
    case "delete":
      return { key: "delete", ctrl: false, alt: false, shift: false };
    case "left":
      return { key: "left", ctrl: false, alt: false, shift: false };
    case "right":
      return { key: "right", ctrl: false, alt: false, shift: false };
    case "up":
      return { key: "up", ctrl: false, alt: false, shift: false };
    case "down":
      return { key: "down", ctrl: false, alt: false, shift: false };
    case "home":
      return { key: "home", ctrl: false, alt: false, shift: false };
    case "end":
      return { key: "end", ctrl: false, alt: false, shift: false };
    case "escape":
      return { key: "escape", ctrl: false, alt: false, shift: false };
    case "ctrl":
      return { key: event.name, ctrl: true, alt: false, shift: false };
    default:
      return undefined;
  }
}
