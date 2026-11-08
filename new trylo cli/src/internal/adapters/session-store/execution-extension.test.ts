import assert from "node:assert/strict";
import { test } from "node:test";
import { recover } from "./recovery.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";

const start: SessionRecord = { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "s", at: "1970-01-01T00:00:00.000Z",
  payload: { fingerprint: { schemaVersion: "1", providerId: "fixture", model: "default", toolCatalogHash: "h", workspaceId: "w" } } };

function extension(payload: JsonObject): SessionRecord {
  return { formatVersion: "1", sequence: 1, type: "execution_extension", sessionId: "s", at: start.at, payload };
}

test("v1 journals remain readable with absent or valid immutable extension metadata", () => {
  assert.equal(recover([start], false).ok, true);
  const restored = recover([start, extension({ schemaVersion: 1, owner: "workflow", instanceId: "instance-1",
    configuration: { schemaVersion: 1, kind: "adoption" } })], false);

  assert.equal(restored.ok, true);

  if (restored.ok) {
    assert.equal(restored.session.sessionId, "s");
    assert.equal(restored.session.transcript.length, 0, "metadata never becomes model-authored conversation or execution");
  }
});

test("unknown extension schema and malformed metadata fail closed at session recovery", () => {
  for (const payload of [
    { schemaVersion: 2, owner: "workflow", instanceId: "instance-1", configuration: {} },
    { schemaVersion: 1, owner: "workflow", instanceId: "instance-1", configuration: [] },
    { schemaVersion: 1, owner: "workflow", instanceId: "", configuration: {} },
  ]) {
    const result = recover([start, extension(payload)], false);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "mid_file_corruption");
  }
});
