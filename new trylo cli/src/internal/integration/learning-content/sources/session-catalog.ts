import type { SessionRecordView } from "../../../ports/session.js";
import { sessionContentAddress, type SessionContentLocator } from "./session-address.js";
import { sessionContentRecordView } from "./session-decode.js";
import type { SessionMaterialCatalog } from "./session-contract.js";

/** The source's own page index: previews locate original material and never replace its full answer requirements. */
export function sessionMaterialCatalog(view: SessionRecordView, locators: readonly SessionContentLocator[], sessionId: string,
  request: { readonly start?: number; readonly maximumItems?: number } = {},
  projection: { readonly scope: string; readonly secrets?: readonly string[]; readonly excludeToolNames?: readonly string[] }): SessionMaterialCatalog | undefined {
  const start = request.start ?? 0, maximumItems = request.maximumItems ?? 8;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 32) return undefined;

  const rows = locators.flatMap(locator => {
    const record = view.records[locator.journalSequence]!;
    const projected = sessionContentRecordView(record, projection.scope, projection.secrets, projection.excludeToolNames, locator.publicText);
    return projected === undefined ? [] : [{ locator, record, projected, text: projected.record.text }];
  });
  const entries = rows.slice(start, start + maximumItems).map(({ locator, record, projected, text }) => ({ ref: projected.record.ref,
    ...(projected.changed ? { originalRef: projected.original.ref, originalSourceHash: projected.original.sourceHash } : {}),
    address: sessionContentAddress({ sessionId, journalSequence: locator.journalSequence }), journalSequence: locator.journalSequence,
    ...(record.turnId === undefined ? {} : { turnId: record.turnId }), role: record.type === "transcript_item" ? String(record.payload.kind) : record.type,
    totalChars: text.length, preview: text.slice(0, 256), previewOmittedChars: Math.max(0, text.length - 256) }));

  return { sessionId, available: rows.length, start, nextStart: start + entries.length < rows.length ? start + entries.length : null, entries };
}
