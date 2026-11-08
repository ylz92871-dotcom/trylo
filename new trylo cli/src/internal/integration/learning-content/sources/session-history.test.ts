import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionRecord, SessionRecordView } from "../../../ports/session.js";
import { readSessionContent, sessionContentAddress, sessionContentRecordRef } from "./session.js";
import { retrieveContentPacket } from "../../../learning/central/content/material-source.js";

function journal(sessionId: string, turns: readonly Omit<SessionRecord, "sessionId" | "sequence" | "formatVersion">[]): SessionRecordView {
  return { tornTail: false, records: [
    { formatVersion: "1", sequence: 0, sessionId, type: "session_start", at: "2026-11-04T12:00:00Z", payload: {
      fingerprint: { schemaVersion: "1", providerId: "local", model: "contract", toolCatalogHash: "catalog", workspaceId: "workspace:a" } } },
    ...turns.map((row, index) => ({ ...row, sessionId, sequence: index + 1, formatVersion: "1" })),
  ] };
}

const at = "2026-11-04T12:01:00Z";

test("focus raw event address recovers original turn requirements; long sources page exactly and registry addresses recover original remote sessions", async () => {
  const longText = `${"A".repeat(40000)}original-tail`;
  const view = journal("session:1", [
    { type: "transcript_item", turnId: "original", at, payload: { kind: "user", sequence: 0, text: "Find the complete original ownership proof." } },
    { type: "transcript_item", turnId: "original", at, payload: { kind: "tool_result", sequence: 1, toolCallId: "call:old", name: "Read", output: longText, truncated: false, outcome: "succeeded" } },
    { type: "envelope", turnId: "original", at, payload: { envelope: { protocolVersion: "0.0", eventId: "event:old", sequence: 91,
      timestamp: at, sessionId: "session:1", turnId: "original", attemptId: "attempt:old", producerId: "loop", producerSequence: 91,
      kind: "tool_result", payload: { toolCallId: "call:old", status: "succeeded" } } } },
    { type: "transcript_item", turnId: "current", at, payload: { kind: "user", sequence: 2, text: "Continue the investigation." } },
  ]);
  const remote = journal("session:remote", [{ type: "transcript_item", turnId: "remote-turn", at,
    payload: { kind: "user", sequence: 0, text: "Original remote source requirement." } }]);
  let lookups = 0;
  const read = await readSessionContent({ session: { async readRecords() { return { ok: true, view }; } },
    sessionId: "session:1", turnId: "current", scope: "repo:a", subsystem: "tool", enabled: () => true,

    async lookupSession(id) {
      lookups++;
      return id === "session:remote" ? { async readRecords() { return { ok: true, view: remote }; } } : undefined;
    } }, new AbortController().signal);

  assert.ok(read.ok);
  assert.equal(read.value.batch.requirements[0]?.requirement, "Continue the investigation.");
  const packet = await retrieveContentPacket({ ...read.value.batch, scope: "repo:a", domain: "tool", boardSequence: 0,
    requestedRefs: ["event:old"] }, read.value.source, new AbortController().signal);
  assert.ok(packet.ok);
  assert.ok(packet.value.requirements.some(row => row.requirement === "Find the complete original ownership proof."));
  assert.ok(packet.value.records.some(row => row.ref.includes(":chunk:") && row.text.length <= 8192));
  assert.ok(!packet.value.retrieval.missingRefs.includes("event:old"));
  assert.ok(packet.value.records.some(row => row.text.includes('"eventSequence":91') && row.text.includes('"journalSequence":3')));
  const page = await read.value.source.readMaterial(sessionContentRecordRef("session:1", 2), new AbortController().signal, 40000, 100);

  assert.ok(page.ok);
  assert.equal(page.value.text, "original-tail");
  assert.equal(page.value.totalChars, longText.length);
  const remoteRef = sessionContentAddress({ sessionId: "session:remote", turnId: "remote-turn" });
  const recovered = await read.value.source.retrieve({ scope: "repo:a", domain: "tool", boardSequence: 0,
    issueIds: [], topicIds: [], artifactRefs: [], sourceRefs: [remoteRef] }, new AbortController().signal);
  assert.ok(recovered.ok);
  assert.ok(recovered.value.requirements.some(row => row.requirement === "Original remote source requirement."));
  const index = await read.value.source.listMaterials(new AbortController().signal, { maximumItems: 2 });
  assert.ok(index.ok);
  assert.equal(index.value.entries[0]?.turnId, "original");
  assert.equal(index.value.nextStart, 2);
  const remotePage = await read.value.source.readMaterial(sessionContentRecordRef("session:remote", 1), new AbortController().signal);

  assert.ok(remotePage.ok);
  assert.equal(remotePage.value.text, "Original remote source requirement.");
  assert.equal(lookups, 1);
});
