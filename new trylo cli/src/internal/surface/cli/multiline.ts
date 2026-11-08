/**
 * Multi-line input: a trailing backslash joins the next line.
 *
 * A person pastes a prompt, or writes one long enough to wrap, and a REPL that
 * submits on every newline turns both into three half-sentences. The terminal
 * convention this build follows is backslash-then-Enter (Shift+Enter needs a
 * raw-mode keybinding this surface deliberately does not take).
 *
 * Two details that are easy to get wrong:
 * - `\\` at end of line is an escaped backslash, not a continuation — the
 *   person asked for a literal backslash at the end of their text.
 * - A continuation as the *last* thing read (EOF right after) still submits:
 *   the person pressed Enter, the backslash just gets dropped.
 *
 * Shared by both REPLs — a line that submits in one and continues in the other
 * would make the two surfaces disagree about what the person said.
 */

/** Whether this line asks for another one. */
function isContinuation(line: string): boolean {
  return line.endsWith("\\") && !line.endsWith("\\\\");
}

export async function readMultiLine(
  read: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const first = await read();
  if (first === undefined) {
    return undefined;
  }

  let text = first;

  while (isContinuation(text)) {
    text = text.slice(0, -1);
    const next = await read();
    if (next === undefined) {
      break;
    }
    text += `\n${next}`;
  }

  return text;
}
