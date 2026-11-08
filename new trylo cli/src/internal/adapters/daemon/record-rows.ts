import { readScheduleFile, writeScheduleFile } from "../schedule-store/index.js";
import type { Schedule } from "../../ports/schedule.js";

/**
 * Replacing the watch rows in the shared record (WP26 / A06 + A07).
 *
 * ## What this file exists to make safe
 *
 * The scheduler's record holds two kinds of thing in one `schedules` array: cron
 * rows and watch rows, plus a separate `occurrences` array saying what has already
 * been settled. A writer that rebuilt the file from the rows it was handed would
 * delete every settled occurrence — and those occurrences are precisely the
 * record that makes a repeated fire detectable after a restart. Losing them
 * silently re-enables the duplicate notification the whole design exists to
 * prevent.
 *
 * So the shape here is deliberately narrow: **watch rows in, nothing else
 * touched.** The cron rows and the occurrences come from the file, not from the
 * caller. A caller cannot accidentally rewrite a schedule it does not understand,
 * because it has no way to pass one.
 *
 * ## Why it is not atomic against another process
 *
 * It is a read-modify-write followed by a rename. The rename is atomic, so no
 * reader ever sees half a file — but a second process writing between the read
 * and the rename would still lose this one's change. That is not defended here
 * because it is defended one level up: every call happens inside a tick that
 * already holds the scheduler lease, and the lease is why there is one writer per
 * host. This function's job is to not be a second writer.
 */
export function writeWatchRows(
  file: string,
  watchRows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): boolean {
  const record = readScheduleFile(file);
  if (!record.ok) {
    // Refusing rather than overwriting: the file exists and could not be parsed,
    // and replacing it with the watch rows would destroy whatever it holds.
    return false;
  }

  const schedules = [
    ...record.value.schedules.filter((row) => !isWatchRow(row)),
    ...watchRows,
  ];

  return writeScheduleFile(file, {
    version: 1,
    // The row union is wider than `Schedule` on purpose — a watch row is not a
    // schedule, and pretending otherwise is what would let a watch be read as an
    // unset cron row. The cast is confined to this one boundary where the two
    // shapes share a file, and it is a widening, never a narrowing.
    schedules: schedules as ReadonlyArray<Schedule>,
    occurrences: record.value.occurrences,
  });
}

/** Whether a stored row is a watch, without assuming anything else about it. */
function isWatchRow(row: Readonly<Record<string, unknown>>): boolean {
  return (row as Readonly<Record<string, unknown>>)["kind"] === "watch";
}
