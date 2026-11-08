import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { ContentDomainFeedback, ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { readOrganizationNativeFeedbackUnit } from "./organization-feedback-sources.js";
import { nativeFeedbackUnitCanonicalRow } from "./native-feedback-unit-canonical-row.js";

const strings = (value: JsonValue | undefined): readonly string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const rowRefs = (row: JsonObject) => [row.factRef, row.recordRef, row.sourceRef, row.receiptId]
  .filter((value): value is string => typeof value === "string");
const rowKey = (row: JsonObject) => canonicalJson([row.kind ?? null, rowRefs(row)[0] ?? row]);
const changeKey = (change: ContentDomainFeedbackChange) => canonicalJson([
  change.domain, change.issueId, change.factRef, change.unitRef, change.revisionRef, change.kind]);

/** Merge presentations of the same original fact, never observations from
 * different facts. Native locators remain navigation, separate from payload. */
function merge(previous: JsonObject | undefined, next: JsonObject): JsonObject {
  if (previous === undefined) return next;

  const result: Record<string, JsonValue> = { ...previous, ...next };
  const refs = unique([...strings(previous.sourceRefs), ...strings(next.sourceRefs)]);
  if (refs.length > 0) result.sourceRefs = refs;

  if (previous.relevantVersionIds !== undefined || next.relevantVersionIds !== undefined) {
    result.relevantVersionIds = unique([...strings(previous.relevantVersionIds), ...strings(next.relevantVersionIds)]);
  }

  const units = new Map<string, JsonValue>();

  for (const value of [previous.nativeUnits, next.nativeUnits]) if (Array.isArray(value)) {
    for (const unit of value) units.set(canonicalJson(unit), unit);
  }

  if (units.size > 0) result.nativeUnits = [...units].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);

  return result;
}

/** Pure typed presentation of one already verified owner frame. The caller
 * owns its single per-issue read and original issue/grant/decision indexing.
 * Existing execution/dispatch/use rows supply closure; metadata never supplies
 * a missing receipt, approval, outcome or behavioral-use claim. */
export function projectOrganizationExactFeedbackFrame(frame: ContentDomainFeedback | undefined,
  changes: readonly ContentDomainFeedbackChange[]): ContentDomainFeedback | undefined {
  if (frame === undefined || changes.length === 0) return frame;

  const byRef = new Map<string, JsonObject[]>(), positions = new Map<JsonObject, number>();

  for (const [index, row] of frame.records.entries()) {
    positions.set(row, index);
    for (const ref of new Set(rowRefs(row))) {
      const rows = byRef.get(ref) ?? [];
      rows.push(row);
      byRef.set(ref, rows);
    }
  }

  const normalized = new Map<string, JsonObject>(), normalizedPositions = new Map<string, number>();
  const replaced = new Set<JsonObject>(), sourceRefs = new Set(frame.sourceRefs);
  const selected = new Map(changes.map(change => [changeKey(change), change]));

  for (const [, change] of [...selected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const candidates = byRef.get(change.factRef) ?? [];
    const unit = readOrganizationNativeFeedbackUnit({ ...frame, records: candidates }, change);
    if (unit.kind !== "found") continue;

    const row = nativeFeedbackUnitCanonicalRow({ recordKind: unit.recordKind, payload: unit.payload,
      factRef: change.factRef, unitRef: change.unitRef, revisionRef: change.revisionRef }, change.domain === "prompt" ? "method" : change.domain);
    if (row === undefined) continue;

    const typed: JsonObject = { ...row, factRef: change.factRef, unitRef: change.unitRef, revisionRef: change.revisionRef,
      sourceRefs: unique([...strings(row.sourceRefs), ...unit.sourceRefs]),
      nativeUnits: [{ factRef: change.factRef, unitRef: change.unitRef, revisionRef: change.revisionRef, changeKind: change.kind }] };
    const key = rowKey(typed);
    normalized.set(key, merge(normalized.get(key), typed));
    const position = candidates.reduce((first, candidate) => Math.min(first, positions.get(candidate) ?? frame.records.length), frame.records.length);

    normalizedPositions.set(key, Math.min(normalizedPositions.get(key) ?? position, position));

    for (const ref of unit.sourceRefs) sourceRefs.add(ref);

    for (const candidate of candidates) if (candidate.factRef === change.factRef && candidate.unitRef === change.unitRef
      && candidate.revisionRef === change.revisionRef) replaced.add(candidate);
  }

  if (normalized.size === 0) return frame;

  const records = new Map<string, JsonObject>(), recordPositions = new Map<string, number>();

  for (const row of frame.records) if (!replaced.has(row)) {
    const key = rowKey(row);
    records.set(key, merge(records.get(key), row));
    const position = positions.get(row)!;
    recordPositions.set(key, Math.min(recordPositions.get(key) ?? position, position));
  }

  for (const [key, row] of normalized) {
    records.set(key, merge(records.get(key), row));
    const position = normalizedPositions.get(key)!;
    recordPositions.set(key, Math.min(recordPositions.get(key) ?? position, position));
  }

  // Owner arrival order determines which real revision is current. Metadata
  // hashes only deduplicate locators; they never order feedback revisions.
  const ordered = [...records].sort(([a], [b]) => recordPositions.get(a)! - recordPositions.get(b)!
    || (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);

  // Keep the real owner's read coordinate. This is a typed presentation of that
  // source, not a newly minted source frame or a replacement authoritative fact.
  return { sourceRef: frame.sourceRef, sourceRefs: [...sourceRefs].sort(), records: ordered };
}
