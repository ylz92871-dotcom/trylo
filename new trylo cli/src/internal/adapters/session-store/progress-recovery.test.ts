import assert from "node:assert/strict";
import test from "node:test";
import { recover } from "./recovery.js";
import type { SessionRecord } from "../../ports/session.js";

function record(type: SessionRecord["type"], turnId: string, key: string, sequence: number): SessionRecord {
  return { type, turnId, sessionId: "s", formatVersion: "1", at: "2026-10-04T00:00:00Z", sequence, payload: { key } };
}

const start: SessionRecord = {
  type: "session_start", sessionId: "s", formatVersion: "1", at: "2026-10-04T00:00:00Z", sequence: 0,
  payload: { fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } },
};

test("durable recovery: a prior turn commit cannot settle a later repeated call id", () => {
  const outcome = recover([start, record("effect_issued", "t1", "tool:c", 1), record("effect_committed", "t1", "tool:c", 2), record("effect_issued", "t2", "tool:c", 3)], false);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.session.reconcileRequired, ["tool:c"]);
});

test("durable recovery: known failure settles, unknown remains unresolved", () => {
  const outcome = recover([start, record("effect_issued", "t", "known", 1), record("effect_failed", "t", "known", 2), record("effect_issued", "t", "unknown", 3), record("effect_unknown", "t", "unknown", 4)], false);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.session.reconcileRequired, ["unknown"]);
});

test("durable recovery: malformed effect identity fails closed", () => {
  const outcome = recover([start, { ...record("effect_issued", "t", "k", 1), payload: {} }], false);
  assert.equal(outcome.ok, false);
});
