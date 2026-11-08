import type { SessionRecord } from "../../../../../ports/session.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import type { SkillSourceContext, SkillUserAttribution } from "../contracts.js";
import { journalExperiencePrefix, type JournalExperienceSource } from "./journal-delegation.js";

const INTERPRETATION = "User roles are transport. Unavailable or absent human attribution does not prove a human correction or permission. Independent tool evidence remains usable.";

/** Project only canonical source markers, never labels or text inside a message. */
export function journalSourceContext(input: {
  readonly records: readonly SessionRecord[]; readonly history: Transcript;
  readonly source: JournalExperienceSource; readonly maxChars?: number;
}): SkillSourceContext {
  const records = journalExperiencePrefix(input.records, input.source), markers = new Map<string, SkillUserAttribution>();

  for (const record of records) {
    if (record.type !== "turn_start" || record.turnId === undefined || !Object.hasOwn(record.payload, "userSourceAvailable")) continue;
    const attribution = record.payload.userSourceAvailable === false ? "unverified" : "unknown";
    // A malformed marker cannot be repaired into a trusted source by a later header.
    if (markers.get(record.turnId) !== "unknown") markers.set(record.turnId, attribution);
  }

  const currentUserAttribution = markers.get(input.source.turnId) ?? "not_recorded";
  const userSequences = new Set(input.history.filter(item => item.kind === "user").map(item => item.sequence));
  const entries = records.flatMap(record => {
    const attribution = record.turnId === undefined ? undefined : markers.get(record.turnId);
    const sequence = record.payload.sequence;
    return record.type === "transcript_item" && record.payload.kind === "user" && typeof sequence === "number"
      && userSequences.has(sequence) && attribution !== undefined ? [{ sequence, attribution }] : [];
  });
  const retained = entries.slice(-32);
  let omittedUserSourceEntries = entries.length - retained.length;
  const result = (): SkillSourceContext => ({ currentUserAttribution,
    unverifiedUserSequences: retained.filter(item => item.attribution === "unverified").map(item => item.sequence),
    unknownUserSequences: retained.filter(item => item.attribution === "unknown").map(item => item.sequence),
    omittedUserSourceEntries, interpretation: INTERPRETATION });
  const maxChars = input.maxChars ?? 2000;
  if (!Number.isSafeInteger(maxChars) || JSON.stringify({ currentUserAttribution }).length > maxChars) {
    throw new Error("hermes_source_context_budget_invalid");
  }

  while (retained.length > 0 && JSON.stringify(result()).length > maxChars) {
    retained.shift();
    omittedUserSourceEntries++;
  }

  if (JSON.stringify(result()).length <= maxChars) return result();

  const compact = { currentUserAttribution, omittedUserSourceEntries };
  if (JSON.stringify(compact).length <= maxChars) return compact;

  // The caller reserves this minimal source fact before optional history or hints.
  return { currentUserAttribution };
}
