import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createSubagentCheckpointJournal } from "../../adapters/subagent-checkpoints/journal.js";
import type { SubagentCheckpoint } from "../../subagent/checkpoint.js";
import { createSubagentJournalSink } from "./subagent-sink.js";
import { projectEnvelopeSequence } from "./stream-projection.js";

test("checkpoint chunks survive a real locked journal reopen without entering the visible event stream", async t => {
  const directory = await mkdtemp(join(tmpdir(), "trylo-team-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.ndjson");
  const session = createNdjsonSessionStore({ path }); t.after(() => session.release());
  assert.deepEqual(await session.start({ sessionId: "session", createdAt: "2026-10-28T00:00:00Z",
    fingerprint: { schemaVersion: "1", providerId: "fixture", model: "test", toolCatalogHash: "tools", workspaceId: "workspace" } }), { ok: true });
  const sink = createSubagentJournalSink({ session, sessionId: "session", turnId: "turn", now: () => 1 });
  let visible = 0; sink.setRenderer({ onEnvelope: () => { visible++; } });
  const store = createSubagentCheckpointJournal([], "session", async payload => { sink.onEvent("observation", payload, "attempt"); await sink.flush(); });
  const checkpoint: SubagentCheckpoint = { version: 1, taskId: "task", agentId: "execution", round: 3, phase: "round_ready",
    nickname: "实现", instruction: "中文文件名".repeat(20_000), role: "worker", roleBinding: "binding",
    allowedTools: ["read_file"], dependencies: [], idleTimeoutMs: 30_000, cursor: 2,
    budget: { tokenLimit: 1000, tokensUsed: 100, tokensRemaining: 900, timeoutMs: 60_000, timeRemainingMs: 50_000, timeoutMode: "active" },
    transcript: [{ kind: "user", sequence: 0, text: "先核对文件" }, { kind: "assistant_text", sequence: 1, blockId: "text", text: "已经读回" }], forkMessages: [] };
  await store.save(checkpoint);
  assert.equal(visible, 0);
  await session.release();
  const reopened = createNdjsonSessionStore({ path }); t.after(() => reopened.release());
  assert.deepEqual(await reopened.attach(), { ok: true });
  const records = await reopened.readRecords(); assert.equal(records.ok, true); if (!records.ok) return;
  const restored = createSubagentCheckpointJournal(records.view.records, "session", async () => { throw new Error("read must not write"); });
  assert.deepEqual(restored.read("execution"), { kind: "ready", checkpoint });
  const raw = await readFile(path, "utf8"); assert.ok(raw.includes("checkpointPart"));
  assert.equal(projectEnvelopeSequence([{ protocolVersion: "0.0", eventId: "private", sequence: 1, timestamp: "now",
    kind: "observation", producerId: "subagent", producerSequence: 1,
    payload: { component: "checkpoint", status: "ok", scope: "subagent", subagentId: "execution", checkpointPart: {} } }]).length, 0);
});
