import type { SessionRecordView } from "../../../ports/session.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { fields, identity, sequence } from "../../../validation/json-shape.js";
import type { SessionContentAddress, SessionContentLocator } from "./session-address.js";
import { sessionContentAddress } from "./session-address.js";
import type { SessionContentInput, SessionContentPage } from "./session-contract.js";
import { sessionContentRecordView } from "./session-decode.js";
import { pageContentMaterial } from "./artifact-read.js";
import { projectContentSourceText } from "./source-text-view.js";

const PREFIX = "session-public-turn:";
// Preserve room for the existing central-page offset prefix within its 512-character address limit.
const MAX_REF_CHARS = 512 - "central-page:9007199254740991:".length;

export interface SessionPublicTurnAddress {
  readonly sessionId: string;
  readonly turnId: string;
  readonly through: number;
  readonly sourceHash: string;
}

const addressOf = (value: SessionPublicTurnAddress): string => `${PREFIX}${canonicalJson(value)}`;

export function readSessionPublicTurnAddress(ref: string): SessionPublicTurnAddress | undefined {
  if (!ref.startsWith(PREFIX) || ref.length > MAX_REF_CHARS) return undefined;

  let value: unknown;

  try { value = JSON.parse(ref.slice(PREFIX.length)); }
  catch { return undefined; }

  if (!fields(value, ["sessionId", "turnId", "through", "sourceHash"]) || !identity(value.sessionId) || !identity(value.turnId)
    || !sequence(value.through) || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)) return undefined;

  const address = { sessionId: value.sessionId, turnId: value.turnId, through: value.through, sourceHash: value.sourceHash };

  return addressOf(address) === ref ? address : undefined;
}

export function isPureSessionTurnAddress(address: SessionContentAddress | undefined): address is SessionContentAddress & { readonly turnId: string } {
  return address?.turnId !== undefined && address.journalSequence === undefined && address.eventId === undefined
    && address.attemptId === undefined && address.toolCallId === undefined;
}

/** A public collection of original rows, not another observation or a bounded decoded packet. */
export function readSessionPublicTurnMaterial(input: Pick<SessionContentInput, "scope" | "secrets" | "excludeToolNames"> & {
  readonly view: SessionRecordView; readonly locators: readonly SessionContentLocator[];
  readonly sessionId: string; readonly turnId: string; readonly requestedRef: string;
  readonly frozen?: SessionPublicTurnAddress;
}, start: number, maximumChars: number): SessionContentPage | { readonly ok: false; readonly reason: string } {
  if (input.frozen === undefined && start !== 0) return { ok: false, reason: "content_material_frozen_address_required" };

  const turn = input.view.records.filter(row => row.turnId === input.turnId), through = input.frozen?.through ?? turn.at(-1)?.sequence;
  if (through === undefined || !sequence(through) || input.view.records[through]?.turnId !== input.turnId) {
    return { ok: false, reason: "content_material_missing" };
  }

  if (turn.some(row => row.sequence <= through && row.type === "turn_start" && row.payload.userSourceAvailable === false)) {
    return { ok: false, reason: "content_material_scope" };
  }

  const records = input.locators.filter(row => row.turnId === input.turnId && row.journalSequence <= through).flatMap(locator => {
    const row = input.view.records[locator.journalSequence]!;
    const projected = sessionContentRecordView(row, input.scope, input.secrets, input.excludeToolNames, locator.publicText);
    if (projected === undefined || !projected.record.text.trim()) return [];

    return [{ ref: projected.record.ref, originalRef: projected.original.ref, sourceHash: contentHashOf(projected.record.text),
      originalSourceHash: projected.original.sourceHash, journalSequence: row.sequence,
      coordinate: { runId: projected.record.runId, sequence: projected.record.sequence },
      originalCoordinate: { runId: projected.original.runId, sequence: projected.original.sequence },
      origin: projected.record.origin, role: row.type === "transcript_item" ? row.payload.kind : row.type,
      readRef: sessionContentAddress({ sessionId: input.sessionId, journalSequence: row.sequence }), text: projected.record.text }];
  });
  if (records.length === 0) return { ok: false, reason: "content_material_missing" };

  const joined = canonicalJson({ header: { schemaVersion: 1, role: "source_owned_public_turn_collection_not_independent_evidence",
    sessionId: input.sessionId, turnId: input.turnId, through, availableRecords: records.length,
    interpretation: "Original public rows in journal order. Each row retains its own origin and source identity; this collection adds no independent observation. A partial page does not deliver the remaining text." }, records });
  // Joining already public rows can expose escaped metadata to the shared
  // redactor. Freeze the actual final public bytes, not the pre-projection JSON.
  const text = projectContentSourceText({ ref: input.requestedRef, runId: input.sessionId, sequence: through,
    scope: input.scope, origin: "execution_result", text: joined }, input.secrets).record.text;
  const address = { sessionId: input.sessionId, turnId: input.turnId, through, sourceHash: contentHashOf(text) }, ref = addressOf(address);
  if (ref.length > MAX_REF_CHARS) return { ok: false, reason: "content_material_capacity" };

  if (input.frozen !== undefined && addressOf(input.frozen) !== ref) return { ok: false, reason: "content_material_conflict" };

  const page = pageContentMaterial({ ref, requestedRef: input.requestedRef, text, originalScope: input.scope,
    sourceRefs: records.map(row => row.ref), admissibility: "source_record", origin: "execution_result",
    coordinate: { runId: ref, sequence: 0 } }, start, maximumChars);
  if (!page.ok) return page;

  if (page.value.ref !== ref || page.value.contentHash !== address.sourceHash) return { ok: false, reason: "content_material_conflict" };

  return { ok: true, value: { ref, sessionId: input.sessionId, journalSequence: through, sourceHash: page.value.contentHash,
    start: page.value.start, end: page.value.end, totalChars: page.value.totalChars, text: page.value.text,
    origin: "execution_result", originalScope: input.scope, sourceRecordType: "public_turn_collection", coordinate: page.value.coordinate } };
}
