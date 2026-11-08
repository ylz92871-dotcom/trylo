/**
 * Terminal input, decoded (WP23.2 / C81, L39).
 *
 * The prompt editor cannot sit on `node:readline`'s line mode: a readline
 * `question()` submits on every newline, which is exactly the paste disaster
 * this package exists to fix, and it offers no history search, no vim modes
 * and no paste events. So the composer reads *keys*, and this module is the
 * boundary between bytes and meaning: one chunk of terminal input in, the key
 * events it contains out.
 *
 * It is pure and stateful only across chunk boundaries — an escape sequence
 * split by the terminal between two reads is held until its tail arrives.
 * Bracketed paste (`ESC [ 200 ~ … ESC [ 201 ~`) is honoured first because it
 * is the one input a person cannot fake by typing fast; the burst machine in
 * `paste-burst.ts` covers terminals that do not send it.
 */

export type KeyEvent =
  | { readonly kind: "char"; readonly text: string }
  | { readonly kind: "enter" }
  | { readonly kind: "tab" }
  | { readonly kind: "backspace" }
  | { readonly kind: "delete" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "home" }
  | { readonly kind: "end" }
  | { readonly kind: "escape" }
  | { readonly kind: "ctrl"; readonly name: CtrlName }
  /** The terminal told us this text was pasted; trust it above all heuristics. */
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "ignored" };

/**
 * A control key's letter (`"c"`, `"r"`, `"t"`, …). Open-ended on purpose:
 * Ctrl-C and Ctrl-D are the shell's, but the *user* may bind any other, so
 * the decoder does not preemptively narrow what a binding may use.
 */
export type CtrlName = string;

/**
 * One decoder for the life of the session. `push` consumes a chunk (already
 * UTF-8 decoded by the source) and returns the complete key events it held.
 */
export type KeyDecoder = {
  readonly push: (chunk: string) => ReadonlyArray<KeyEvent>;
};

export function createKeyDecoder(): KeyDecoder {
  let held = "";
  const decoder = {
    push(chunk: string): ReadonlyArray<KeyEvent> {
      const events: KeyEvent[] = [];
      let source = held + chunk;

      held = "";

      while (source.length > 0) {
        const consumed = decodeOne(source, events);
        if (consumed === 0) {
          // The tail is an incomplete sequence; hold it for the next chunk.
          held = source;
          break;
        }

        source = source.slice(consumed);
      }

      return events;
    },
  };

  return decoder;
}

/**
 * Decode the first key at the front of `source`; append its event and answer
 * how many characters it consumed. Zero means "incomplete, hold".
 */
function decodeOne(source: string, events: KeyEvent[]): number {
  const head = source.codePointAt(0) ?? 0;
  if (head === 0x1b) {
    return decodeEscape(source, events);
  }

  if (head === 0x0d || head === 0x0a) {
    events.push({ kind: "enter" });
    return 1;
  }

  if (head === 0x7f || head === 0x08) {
    events.push({ kind: "backspace" });
    return 1;
  }

  if (head === 0x09) {
    events.push({ kind: "tab" });
    return 1;
  }

  if (head < 0x20) {
    // Every C0 control from Ctrl-A through Ctrl-Z becomes a ctrl event, so a
    // user binding can reach any of them; the ones with line-editing meaning
    // (Enter, Backspace) and Tab were handled above.
    if (head >= 0x01 && head <= 0x1a && head !== 0x09) {
      events.push({ kind: "ctrl", name: String.fromCharCode(head + 96) });
      return 1;
    }

    events.push({ kind: "ignored" });

    return 1;
  }

  // One code point per event keeps the composer's cursor arithmetic honest:
  // a surrogate pair is two units but one key.
  const character = String.fromCodePoint(head);

  events.push({ kind: "char", text: character });

  return character.length;
}

/**
 * Escape-sequence decoding: bracketed paste first, then the CSI cursor keys a
 * terminal actually sends, then a bare ESC.
 *
 * An unknown CSI sequence is swallowed whole rather than leaked as characters —
 * a leaked `[19~` is worse than an ignored F-key.
 */
function decodeEscape(source: string, events: KeyEvent[]): number {
  // Bracketed paste: the marker is plain text, so find its end literally.
  if (source.startsWith("\x1b[200~")) {
    const end = source.indexOf("\x1b[201~", 6);
    if (end === -1) {
      return 0; // paste not finished arriving
    }

    const text = source.slice(6, end).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    events.push({ kind: "paste", text });

    return end + 6;
  }

  const csi = /^((?:\x1b\[)?)([0-9;]*)([A-Za-z~])/.exec(source);
  if (csi !== null && csi[1] !== undefined && csi[1].length > 0) {
    const params = csi[2] ?? "";
    const final = csi[3] ?? "";
    const event = CSI_EVENT(final, params);
    events.push(event);
    return csi[0].length;
  }

  // A lone ESC is the Esc key. An ESC starting an unknown sequence whose next
  // character has not arrived yet is held; anything else after ESC that is not
  // CSI is ignored whole (alt-combos this build does not bind).
  if (source.length === 1) {
    events.push({ kind: "escape" });
    return 1;
  }

  const next = source[1] ?? "";
  if (next === "[" || next === "O") {
    return 0; // incomplete CSI/SS3: hold for the rest
  }

  events.push({ kind: "ignored" });

  return 2;
}

function CSI_EVENT(final: string, params: string): KeyEvent {
  switch (final) {
    case "A":
      return { kind: "up" };
    case "B":
      return { kind: "down" };
    case "C":
      return { kind: "right" };
    case "D":
      return { kind: "left" };
    case "H":
      return { kind: "home" };
    case "F":
      return { kind: "end" };
    case "~":
      return TILDE_EVENT(params);
    default:
      return { kind: "ignored" };
  }
}

function TILDE_EVENT(params: string): KeyEvent {
  switch (params) {
    case "1":
    case "7":
      return { kind: "home" };
    case "3":
      return { kind: "delete" };
    case "4":
    case "8":
      return { kind: "end" };
    default:
      return { kind: "ignored" };
  }
}
