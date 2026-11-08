import type { MemoryMatchMode } from "../../../ports/memory.js";

/**
 * Deciding whether a line matches a query set.
 *
 * Reuse: Codex `codex-rs/ext/memories/src/local/search.rs:SearchMatcher` and its
 * `SearchComparison` — three match modes (any substring, all on one line, all
 * within a line window), optional case folding, and an optional normalisation
 * that drops everything non-alphanumeric so `read-file` and `read file` are one
 * query. The algorithms are ported rather than wrapped because they are pure
 * string comparison with no I/O, and a wrapper would have added an adapter
 * without removing a boundary.
 *
 * Two properties are preserved deliberately because they are what make the result
 * checkable:
 *
 *  - **normalisation is not fuzziness.** It only removes characters; it never
 *    reorders, never approximates, and never matches a line that does not contain
 *    the query. A matcher that guessed would put a memory in a model's context
 *    that was never written by anybody;
 *  - **the matched queries travel with the hit.** `matchedQueries` says which of
 *    the caller's queries this line answered, so a `all_within_lines` result can
 *    be read as "these two things appear near each other" rather than "something
 *    matched".
 */

export type MatchWindow =
  | { readonly kind: "any" }
  | { readonly kind: "all_on_same_line" }
  | { readonly kind: "all_within_lines"; readonly lineCount: number };

export function windowFor(mode: MemoryMatchMode, requestedLineCount?: number): MatchWindow {
  if (mode !== "all_within_lines") {
    return { kind: mode };
  }
  const lineCount = requestedLineCount ?? 5;
  return { kind: "all_within_lines", lineCount: Math.max(1, Math.floor(lineCount)) };
}

export type Matcher = {
  /** Which of the prepared queries this line contains, in query order. */
  readonly flagsFor: (line: string) => ReadonlyArray<boolean>;
  /** The original (untrimmed-of-case) queries that matched, in query order. */
  readonly matchedQueries: (flags: ReadonlyArray<boolean>) => ReadonlyArray<string>;
  readonly queries: ReadonlyArray<string>;
};

export function createMatcher(input: {
  readonly queries: ReadonlyArray<string>;
  readonly window: MatchWindow;
  readonly caseSensitive: boolean;
  readonly normalized: boolean;
}): Matcher {
  const prepare = prepareValue(input.caseSensitive, input.normalized);
  const prepared = input.queries.map(prepare);

  return {
    queries: input.queries,
    flagsFor(line) {
      const haystack = prepare(line);
      return prepared.map((needle) => haystack.includes(needle));
    },
    matchedQueries(flags) {
      return input.queries.filter((_query, index) => flags[index] === true);
    },
  };
}

/**
 * Fold one string for comparison.
 *
 * The `caseSensitive && !normalized` case returns the original string rather
 * than a copy: that is the common configuration and copying every line of every
 * record to discover it needs no folding would be pure waste.
 */
function prepareValue(caseSensitive: boolean, normalized: boolean): (value: string) => string {
  if (caseSensitive && !normalized) {
    return (value) => value;
  }
  return (value) => {
    const cased = caseSensitive ? value : value.toLowerCase();
    return normalized ? cased.replace(/[^\p{L}\p{N}]/gu, "") : cased;
  };
}

/** One hit: a line range within a document, plus why it matched. */
export type RawHit = {
  readonly matchStartIndex: number;
  readonly matchEndIndex: number;
  readonly matchedQueries: ReadonlyArray<string>;
};

/**
 * Every hit in one document's lines.
 *
 * `all_within_lines` returns the *minimal* window covering the queries rather
 * than every window that contains it. A five-line window that holds all three
 * queries yields one hit, not the twelve overlapping ranges inside it — otherwise
 * one fact would occupy the result page twelve times and the pagination cursor
 * would advance by a number the caller never chose.
 */
export function hitsInDocument(
  lines: ReadonlyArray<string>,
  matcher: Matcher,
  window: MatchWindow,
): ReadonlyArray<RawHit> {
  const flags = lines.map((line) => matcher.flagsFor(line));
  switch (window.kind) {
    case "any":
      return collectWhere(lines.length, (index) => someTrue(flags[index] ?? []), flags, matcher);
    case "all_on_same_line":
      return collectWhere(
        lines.length,
        (index) => (flags[index] ?? []).length > 0 && (flags[index] ?? []).every((flag) => flag),
        flags,
        matcher,
      );
    case "all_within_lines":
      return withinLineHits(flags, matcher, window.lineCount);
  }
}

function collectWhere(
  lineCount: number,
  matches: (index: number) => boolean,
  flags: ReadonlyArray<ReadonlyArray<boolean>>,
  matcher: Matcher,
): ReadonlyArray<RawHit> {
  const hits: RawHit[] = [];

  for (let index = 0; index < lineCount; index += 1) {
    if (matches(index)) {
      hits.push({
        matchStartIndex: index,
        matchEndIndex: index,
        matchedQueries: matcher.matchedQueries(flags[index] ?? []),
      });
    }
  }

  return hits;
}

function withinLineHits(
  flags: ReadonlyArray<ReadonlyArray<boolean>>,
  matcher: Matcher,
  lineCount: number,
): ReadonlyArray<RawHit> {
  const found: RawHit[] = [];

  for (let start = 0; start < flags.length; start += 1) {
    if (!someTrue(flags[start] ?? [])) {
      continue;
    }

    const last = Math.min(start + lineCount - 1, flags.length - 1);
    const seen = (flags[start] ?? []).map(() => false);
    let end = -1;

    for (let index = start; index <= last; index += 1) {
      (flags[index] ?? []).forEach((flag, query) => {
        if (flag) {
          seen[query] = true;
        }
      });
      if (seen.every((flag) => flag)) {
        end = index;
        break;
      }
    }

    if (end < 0) {
      continue;
    }

    // Shrink to the tightest range inside what we scanned: a hit reported from
    // its first line to `last` when the last query was on the second would drag
    // three lines of unrelated context into every result.
    while (end > start && !(flags[end] ?? []).some((flag) => flag)) {
      end -= 1;
    }

    found.push({
      matchStartIndex: start,
      matchEndIndex: end,
      matchedQueries: matcher.matchedQueries(seen),
    });
  }

  return found;
}

function someTrue(flags: ReadonlyArray<boolean>): boolean {
  return flags.some((flag) => flag);
}
