import assert from "node:assert/strict";
import { test } from "node:test";
import { recover } from "./recovery.js";
import type { SessionRecord } from "../../ports/session.js";

test("a V2 suffix cannot borrow the same block id from another turn", () => {
  const records: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, sessionId: "s", at: "now", type: "session_start", payload: {
      fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } } },
    { formatVersion: "1", sequence: 1, sessionId: "s", at: "now", turnId: "a", type: "stream_partial", payload: {
      version: "1", kind: "assistant_text", blockId: "b", text: "abc" } },
    { formatVersion: "1", sequence: 2, sessionId: "s", at: "now", turnId: "a", type: "stream_partial", payload: {
      version: "2", kind: "assistant_text", blockId: "b", offset: 3, textDelta: "def" } },
  ];
  const valid = recover(records, false);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.session.partials[0]?.text, "abcdef");
  const wrongTurn = recover([...records.slice(0, 2), { ...records[2]!, turnId: "b" }], false);
  assert.equal(wrongTurn.ok, false);
  const wrongOffset = recover([...records.slice(0, 2), { ...records[2]!, payload: { ...records[2]!.payload, offset: 9 } }], false);
  assert.equal(wrongOffset.ok, false);
});
