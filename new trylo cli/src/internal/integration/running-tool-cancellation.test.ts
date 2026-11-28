import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../adapters/session-store/ndjson.js";
import { SESSION_FORMAT_VERSION } from "../ports/session.js";
import { testScratchPath } from "../testing/scratch.js";
import { createTurnRecorder } from "../surface/cli/turn-recorder.js";
import { createFakePermission, createFakeProvider, echoBinding, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

for (const count of [1, 2]) {
  test(`caller cancellation reaches ${count} running tools and leaves the durable session resumable`, async () => {
    const root = mkdtempSync(testScratchPath("running-tool-cancel-"));
    const path = join(root, "session.ndjson");
    const session = createNdjsonSessionStore({ path });
    const fingerprint = { schemaVersion: SESSION_FORMAT_VERSION, workspaceId: "w", providerId: "fake", model: "fake", toolCatalogHash: "h" };
    assert.equal((await session.start({ sessionId: "s", fingerprint, createdAt: "1970-01-01T00:00:00.000Z" })).ok, true);
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
    assert.ok(recorder);
    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const controller = new AbortController();
    const calls = Array.from({ length: count }, (_, index) => `call-${index}`);
    const finish = new Map<string, () => void>();
    const stops: string[] = [];
    let markStarted = (): void => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let requests = 0;
    const running = runTurn({
      profile: emptyProfileLoader(), permission: createFakePermission("approved"), progress: recorder.progress,
      provider: { async *stream() {
        requests += 1;
        for (const toolCallId of calls) yield { type: "tool_call" as const, toolCallId, name: "echo", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } },
      tools: {
        snapshot: () => [echoBinding({ needsApproval: false, parallelSafe: true })],
        async execute(call, signal) {
          await new Promise<void>(resolve => {
            finish.set(call.toolCallId, resolve);
            if (finish.size === count) markStarted();
          });
          assert.equal(signal.aborted, false, "atomic execution signal stays intact");
          return { outcome: "cancelled" };
        },
        async cancel(id) { stops.push(id); finish.get(id)?.(); },
      },
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "interrupt", cancelSignal: controller.signal });
    try {
      await started;
      controller.abort();
      await setImmediate();
      assert.deepEqual([...new Set(stops)].sort(), calls, "stop must reach in-flight calls before they return");
    } finally {
      for (const release of finish.values()) release();
      await running;
      await session.release();
    }
    const result = await running;
    assert.equal(result.state.terminalReason, "cancelled");
    assert.equal(requests, 1, "cancellation never starts a reporting model call");
    const resumed = createNdjsonSessionStore({ path });
    try {
      assert.equal((await resumed.attach()).ok, true);
      const recovered = await resumed.read();
      assert.ok(recovered.ok);
      assert.deepEqual(recovered.session.reconcileRequired, []);
      for (const id of calls) assert.ok(recovered.session.transcript.some(item => item.kind === "tool_result" && item.toolCallId === id && item.outcome === "cancelled"));
      const next = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
        tools: { snapshot: () => [], async execute() { throw new Error("unused"); }, async cancel() {} },
        provider: createFakeProvider([[{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]]),
      }, { sessionId: "s", turnId: "next", correlationId: "next", text: "continue", resumedTranscript: recovered.session.transcript });
      assert.equal(next.state.terminalReason, "completed");
    } finally { await resumed.release(); }
  });
}
