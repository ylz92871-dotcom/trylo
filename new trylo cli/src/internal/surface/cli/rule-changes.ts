import type { SessionRecord } from "../../ports/session.js";
import type { ProjectInstructionSource } from "./host.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Did the project's own rules change between two runs of one session?
 *
 * A resumed run adopts whatever `AGENTS.md` says *now*, while the journal
 * records what it said last time. Both are facts and neither is wrong, so the
 * only honest thing to do is say so — silently adopting the new text would
 * leave a user comparing two runs unable to explain why the model started
 * ignoring a convention it followed yesterday, and silently keeping the old text
 * would have the run acting on rules the repository no longer contains.
 *
 * Compare by hash, not by prose: the point is to name *that a file changed*, and
 * reading two rule sets side by side to decide whether they differ would make
 * the diagnostic as expensive as the thing it reports.
 *
 * Nothing here writes. The old records stay exactly as they were written — a
 * journal that had been rewritten to match the present would stop being evidence
 * of anything (WP-CLI-B1 §6).
 */

/** One fact about a rule file's drift, phrased for a person reading stderr. */
export type RuleChange =
  | { readonly kind: "added"; readonly relativePath: string }
  | { readonly kind: "removed"; readonly relativePath: string }
  | { readonly kind: "changed"; readonly relativePath: string };

/**
 * The rule sources recorded by the **last** turn that recorded any.
 *
 * A session has one `turn_start` per turn and each repeats the list, so the last
 * one is the most recent statement — earlier turns exist to be compared against,
 * not to be summed. A journal written before project rules existed has none, and
 * that is reported as "no record", not as "everything was added".
 */
function lastRecordedSources(
  records: ReadonlyArray<SessionRecord>,
): ReadonlyArray<ProjectInstructionSource> | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "turn_start") {
      continue;
    }

    const raw = record.payload["projectInstructions"];
    if (!Array.isArray(raw)) {
      continue;
    }

    return raw.flatMap((entry) => (isSourceLike(entry) ? [entry] : []));
  }
  return undefined;
}

/**
 * Narrows one untrusted journal entry.
 *
 * The payload is `JsonObject` because it is whatever the writer put there, so
 * every field is checked. A journal is a file on disk: readable, hand-editable,
 * and possibly written by an older build whose shape differs. A malformed entry
 * is skipped rather than trusted, and skipping is safe here precisely because
 * this function only ever *adds* caution to what it reports.
 */
function isSourceLike(entry: unknown): entry is ProjectInstructionSource {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const candidate = entry as Record<string, unknown>;

  return (
    typeof candidate["relativePath"] === "string" &&
    typeof candidate["scopePath"] === "string" &&
    typeof candidate["contentHash"] === "string" &&
    (candidate["scope"] === "workspace_root" || candidate["scope"] === "directory")
  );
}

/** Local rules are facts on tool-result envelopes, discovered only when their target is read. */
export function recordedLocalSources(records: ReadonlyArray<SessionRecord> | undefined): ReadonlyArray<ProjectInstructionSource> {
  const sources = new Map<string, ProjectInstructionSource>();

  for (const record of records ?? []) {
    if (record.type !== "envelope") continue;

    const envelope = record.payload.envelope;
    if (!isObject(envelope)) continue;

    const payload = envelope.payload;
    if (!isObject(payload)) continue;

    const value = payload.value;
    if (!isObject(value) || !Array.isArray(value.localRules)) continue;

    for (const source of value.localRules) if (isSourceLike(source)) sources.set(source.relativePath, source);
  }

  return [...sources.values()];
}

/**
 * What changed between the recorded rules and the ones this run adopts.
 *
 * An empty array means "the same rules", which is the common case and must stay
 * silent — a resume that printed a line every time would train users to ignore
 * the one run where the line mattered.
 */
export function ruleChangesBetween(
  records: ReadonlyArray<SessionRecord> | undefined,
  current: ReadonlyArray<ProjectInstructionSource> | undefined,
): ReadonlyArray<RuleChange> {
  if (records === undefined) {
    // Not a resume from a journal we can read: nothing to compare against, and
    // claiming a change would be inventing one.
    return [];
  }

  const recorded = lastRecordedSources(records);
  if (recorded === undefined || current === undefined) {
    return [];
  }

  const before = new Map(recorded.map((source) => [source.relativePath, source.contentHash]));
  const after = new Map(current.map((source) => [source.relativePath, source.contentHash]));
  const changes: RuleChange[] = [];

  for (const [relativePath, hash] of after) {
    const previous = before.get(relativePath);
    if (previous === undefined) {
      changes.push({ kind: "added", relativePath });
    } else if (previous !== hash) {
      changes.push({ kind: "changed", relativePath });
    }
  }

  for (const relativePath of before.keys()) {
    if (!after.has(relativePath)) {
      changes.push({ kind: "removed", relativePath });
    }
  }

  return changes;
}

/**
 * The sentence a resumed run prints before it starts working.
 *
 * `undefined` — not an empty string — when nothing changed, because the caller
 * writes `undefined` to stderr and writes nothing at all. That distinction is
 * the difference between a resume that is silent and one that prints a blank
 * line the user has to wonder about.
 */
export function ruleChangeNotice(changes: ReadonlyArray<RuleChange>): string | undefined {
  if (changes.length === 0) {
    return undefined;
  }

  const describe = (change: RuleChange): string => {
    switch (change.kind) {
      case "added":
        return `${change.relativePath} (new)`;
      case "removed":
        return `${change.relativePath} (gone)`;
      case "changed":
        return `${change.relativePath} (edited)`;
    }
  };

  return (
    `note: this session's project rules changed since the recorded run — ` +
    `${changes.map(describe).join(", ")}. This run uses the current files; ` +
    `the earlier turns used the versions in the journal.`
  );
}

/**
 * The one call a turn makes, so there is one place that decides to speak.
 *
 * The host used to compute this in three steps at the call site. That put the
 * policy — when a resumed run is allowed to interrupt a user with a note — in a
 * file about ports and sessions, and it made the "nothing changed" case a
 * three-line dance repeated at every future caller. Here it is one name, and the
 * silence case is expressed once.
 */
export function ruleChangeNoticeFor(
  records: ReadonlyArray<SessionRecord> | undefined,
  current: ReadonlyArray<ProjectInstructionSource> | undefined,
): string | undefined {
  return ruleChangeNotice(ruleChangesBetween(records, current));
}
