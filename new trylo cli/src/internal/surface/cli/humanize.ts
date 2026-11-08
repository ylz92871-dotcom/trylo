/**
 * Human-facing formatting for the list commands.
 *
 * A journal file and a checkpoint are read by a person who wants to know
 * *which one* and *how old*, not how many bytes or which millisecond. These
 * commands used to print `1790376095491`-style ids next to
 * `2026-09-25T22:42:46.439Z` and `304023 bytes`, which is precise and unreadable:
 * every row was the same width of noise, so nothing stood out.
 *
 * Deliberately small and pure. `now` is passed in rather than read, because
 * "3 min ago" computed from a clock nobody injected is a test that cannot be
 * written and a value that cannot be pinned.
 *
 * Alignment here measures UTF-16 length, not terminal columns: everything these
 * commands format is ASCII (ids, times, byte counts). Anything that can carry
 * CJK or emoji belongs to `tui/frame.ts`, which has the real width table.
 */

/** Byte counts, to the unit a person would say out loud. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * How long ago, to the coarsest unit that still tells the truth.
 *
 * "3 min ago" rather than "3 minutes ago" because these sit in a column: the
 * row already has an id, a size and a label, and long time words push the eye
 * around. Anything older than a week stops being relative — after that
 * "7 days ago" and a date are equally unhelpful, and the date is comparable
 * with the other dates in the list.
 */
export function relativeTime(atMs: number, nowMs: number): string {
  const seconds = Math.round((nowMs - atMs) / 1000);
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }

  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days} d ago`;
  }

  return isoDate(atMs);
}

/** `YYYY-MM-DD`. Used for anything too old to be useful as a relative time. */
export function isoDate(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Rows to lines, each column padded to its widest cell.
 *
 * Ragged columns are the reason a list of sessions is hard to scan: the size
 * column starts at a different place on every row, so the eye has to re-find
 * it each time.
 */
export function aligned(rows: ReadonlyArray<ReadonlyArray<string>>, gap = "  "): ReadonlyArray<string> {
  if (rows.length === 0) {
    return [];
  }

  const width = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: width }, (_, at) =>
    Math.max(...rows.map((row) => (row[at] ?? "").length)),
  );
  // A column nobody filled is dropped rather than padded: a caller that leaves
  // a cell empty because it had nothing to say (a provider kind equal to its
  // id, say) would otherwise get a run of spaces where a column was.
  const kept = widths.flatMap((wide, at) => (wide > 0 ? [at] : []));

  return rows.map((row) =>
    kept
      .map((at) => (row[at] ?? "").padEnd(widths[at] ?? 0))
      .join(gap)
      .replace(/\s+$/, ""),
  );
}

/**
 * The first `max` items and how many were left behind.
 *
 * A home directory accumulates sessions the way a mailbox accumulates mail:
 * a list that prints all of them is a list whose beginning has already
 * scrolled away. `--json` still returns everything, so nothing is unreachable.
 */
export function limited<T>(
  items: ReadonlyArray<T>,
  max: number,
): { readonly shown: ReadonlyArray<T>; readonly hidden: number } {
  if (items.length <= max) {
    return { shown: items, hidden: 0 };
  }
  return { shown: items.slice(0, max), hidden: items.length - max };
}

/** The most sessions or checkpoints a plain listing prints before it summarises. */
export const LIST_LIMIT = 20;

/**
 * A long opaque id, cut to something a person can compare at a glance.
 *
 * Only for ids that are *looked at*, never for ids that are *copied*: a status
 * row exists to answer "which account am I on", and eight characters answer
 * that. `auth list` deliberately does not use this, because its ids are what a
 * person types into `auth switch`.
 *
 * The ellipsis is part of the contract — a shortened id must never look like a
 * complete one.
 */
export function shortenId(id: string, keep = 8): string {
  if (id.length <= keep) {
    return id;
  }
  return `${id.slice(0, keep)}…`;
}
