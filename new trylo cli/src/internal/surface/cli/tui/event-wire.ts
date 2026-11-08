import { isCliStreamEventType, type CliStreamEvent } from "../../../protocol/cli-stream.js";
import type { CliSink } from "../render.js";

/**
 * The TUI's wire reader.
 *
 * The shell does not build a projection of its own — `tui/discipline.test.ts`
 * scans for exactly that. It runs the one run host with the `stream-json`
 * format and reads back the lines the host writes, so the shell is just
 * another consumer of the same event stream a parent process would read, and
 * `collectedSink` is where those lines become events again.
 *
 * The reader hands each event over the moment it is parsed rather than
 * collecting them for later (WP D1/D3): the shell advances its state and
 * repaints as the turn runs, instead of after it has finished.
 */

/** The sink the turn writes through: stream-json lines in, events and notes out. */
export function collectingSink(
  notes: string[],
  onEvent: (event: CliStreamEvent) => void,
): CliSink {
  return {
    stdout: (text) => {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const parsed = parseEventLine(trimmed);
        if (parsed === undefined) {
          notes.push(`unrecognized event line: ${trimmed.slice(0, 60)}`);
        } else {
          onEvent(parsed);
        }
      }
    },

    stderr: (text) => {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          notes.push(trimmed);
        }
      }
    },
  };
}

function parseEventLine(line: string): CliStreamEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      isCliStreamEventType(String((value as { type: unknown }).type))
    ) {
      return value as CliStreamEvent;
    }

    return undefined;
  } catch {
    return undefined;
  }
}
