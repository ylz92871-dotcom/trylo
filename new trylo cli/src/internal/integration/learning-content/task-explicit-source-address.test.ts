import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { sessionContentAddress } from "./sources/session.js";

test("an explicit PA report birth address recovers its original requirement without guessing its session taskId as a turn or scanning an unrelated broken journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-explicit-source-birth-"));
  const session = createNdjsonSessionStore({ path: join(root, "current.ndjson") });
  const broken = createNdjsonSessionStore({ path: join(root, "unrelated.ndjson") });
  const at = "2026-11-04T22:30:00Z", scope = "repo:explicit-source", sessionId = "source-birth-session";
  const original = "Preserve the complete original requirement from the report's actual source turn.";
  const signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId: "original-turn", at,
      payload: { kind: "user", sequence: 0, text: original } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId: "current-turn", at,
      payload: { kind: "user", sequence: 1, text: "Continue investigating the original report." } })).ok);
    await writeFile(join(root, "unrelated.ndjson"), "not-valid-journal-json\n", "utf8");
    const bad = await broken.readRecords();
    assert.equal(bad.ok, false);
    const boardRoot = join(root, "board"), sourceAddress = sessionContentAddress({ sessionId, turnId: "original-turn" });
    let registryScans = 0;
    const runtime = createNormalTaskContentRuntime({ boardRoot, scope, domain: "collaboration", session, sessionId,
      turnId: "current-turn", enabled: () => true, now: () => Date.parse(at),

      async lookupSessionsForTask() {
        registryScans++;
        const read = await broken.readRecords();
        if (!read.ok) throw new Error(`central_source_registry_unavailable:${read.code}`);
        return [];
      } });

    for (const [issueId, taskId, evidenceRefs] of [["issue:birth", sessionId, [sourceAddress]], ["issue:legacy", "original-turn", []]] as const) {
      const report = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `report:${issueId}`, issuedAt: at,
        action: { kind: "report", scope, issueId, problemKey: issueId, report: { reportId: `report:${issueId}`,
          source: { teamRunId: "team:personal-agent", taskId, memberId: "personal_agent" }, facts: ["Inspect the original source requirement."], evidenceRefs } } }));
      assert.ok(report.ok);
      const focus = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `focus:${issueId}`, issuedAt: at,
        action: { kind: "decide", issueId, expectedRevision: 1, decision: "focused_learning", reason: "Investigate the original requirement.", sourceRefs: [] } }));
      assert.ok(focus.ok);
      const prepared = await runtime.prepare({ issueId }, signal);
      assert.ok(prepared.ok, JSON.stringify({ issueId, prepared }));
      assert.ok(prepared.value.packet.requirements.some(row => row.requirement === original));
      assert.equal(registryScans, 0, "A precise birth address, or the legacy known current-session turn, needs no unrelated registry scan.");
    }
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
