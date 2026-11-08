import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, createFakeProvider, createFakeTools, echoBinding, emptyProfileLoader } from "../../loop/fakes.js";
import { createTurnRecorder } from "./turn-recorder.js";
import { createSubagentJournalSink } from "./subagent-sink.js";

test("a durable unknown result stops the live turn and remains available for reconciliation", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-unknown-"));
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z",
      fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" },
    });
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const result = await runTurn({
      profile: emptyProfileLoader(), permission: createFakePermission("approved"), progress: recorder.progress,
      provider: createFakeProvider([[
        { type: "tool_call", toolCallId: "c", name: "echo", arguments: {} },
        { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
      ], [
        { type: "text_delta", blockId: "explanation", text: "The action's result is uncertain; further actions stopped and the work is unfinished." },
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ]]),
      tools: createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]),
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "work" });
    assert.equal(result.state.terminalReason, "failed");
    assert.equal(result.iterations, 2, "the explanation uses the same loop with no execution tools");
    const recovered = await session.read();

    assert.equal(recovered.ok, true);

    if (recovered.ok) {
      assert.deepEqual(recovered.session.reconcileRequired, ["tool:c"]);
      assert.equal(recovered.session.transcript.some(item => item.kind === "tool_result" && item.outcome === "unknown"), true);
    }
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent event persistence is bounded and reports overflow rather than silently dropping facts", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-subagent-buffer-"));
  const store = createNdjsonSessionStore({ path: join(root, "s.ndjson") });
  let writes = 0;
  const session = { ...store, async append() {
    writes++;
    return { ok: true, sequence: writes } as const;
  } };
  const sink = createSubagentJournalSink({ session, sessionId: "s", turnId: "t", now: () => 0 });

  try {
    for (let i = 0; i < 1000; i++) sink.onEvent("subagent_spawn", { childAttemptId: "c" + i }, "a");
    assert.ok(writes <= 128, "sync event bursts must not create an unbounded promise queue");
    await assert.rejects(sink.flush(), /execution_progress_failed.*subagent_write_queue_full/);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});
