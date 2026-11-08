import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, emptyProfileLoader } from "../../loop/fakes.js";
import type { ExecutionProgressPort } from "../../ports/execution-progress.js";
import type { Envelope } from "../../protocol/envelope.js";
import { createTurnRecorder } from "./turn-recorder.js";

test("a failed warning append cannot suppress the next turn on the same provider", async () => {
  const model = "glm-5.3";
  const provider = createOpenAiCompatibleProvider({ model, endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", apiKey: "synthetic-only",
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') });

  for (const fail of [true, false]) {
    const turnId = fail ? "failed" : "retry";

    provider.continuation?.restore({ sessionId: "s", turnId, records: [{ formatVersion: "1", sequence: 1, type: "envelope", sessionId: "s", turnId: "old", at: "fixture",
      payload: { envelope: { kind: "stream_end" }, providerContinuation: { version: 2, binding: "foreign", scope: JSON.stringify(["s", "old"]), state: "absent", identity: { text: "old", calls: [] } } } }] });
    const notices: Envelope[] = [];
    const progress: ExecutionProgressPort = { flush: async (snapshot) => fail && snapshot.envelopes.some((envelope) => envelope.payload["code"] === "native_continuation_unavailable")
      ? { ok: false, code: "injected_warning_append_failure" } : { ok: true }, issue: async () => ({ ok: true }), settle: async () => ({ ok: true }) };
    const task = runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"), progress,
      tools: { snapshot: () => [], execute: async () => ({ outcome: "unknown", code: "none", message: "none" }), cancel: async () => undefined } },
    { sessionId: "s", turnId, correlationId: "c", text: "continue", model, budget: { maxIterations: 2 }, onEnvelope: (envelope) => notices.push(envelope),
      resumedTranscript: [{ kind: "user", sequence: 0, text: "before" }, { kind: "assistant_text", blockId: "old-text", sequence: 1, text: "old" }] });

    if (fail) await assert.rejects(task, /execution_progress_failed/u); else await task;

    assert.equal(notices.filter((envelope) => envelope.payload["code"] === "native_continuation_unavailable").length, 1);
  }
});

test("the recorder acknowledges a native notice only after its durable append succeeds", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-notice-ack-"));
  try {
    const store = createNdjsonSessionStore({ path: path.join(root, "session.ndjson") });

    assert.equal((await store.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } })).ok, true);
    let fail = true;
    const recorder = createTurnRecorder({ session: { ...store, append: (record) => fail && record.type === "envelope"
      ? Promise.resolve({ ok: false as const, code: "injected_append_failure", message: "fixture" }) : store.append(record) }, sessionId: "s", turnId: "t", now: () => 0 });

    assert.ok(recorder);
    const acknowledged: string[] = [];

    await recorder.start({ startedAt: 0, toolCatalogHash: "h", continuation: { capture: () => undefined, restore: () => undefined, acknowledgeNotice: (id) => acknowledged.push(id) } });
    const envelope: Envelope = { protocolVersion: "0.0", eventId: "e1", sequence: 1, timestamp: "1970-01-01T00:00:00.000Z", kind: "observation", producerId: "p", producerSequence: 1,
      payload: { component: "provider", diagnostic: { noticeId: "notice-1" } } };

    assert.equal((await recorder.progress.flush({ transcript: [], envelopes: [envelope] })).ok, false);
    assert.equal(acknowledged.length, 0);
    fail = false;
    assert.equal((await recorder.progress.flush({ transcript: [], envelopes: [envelope] })).ok, false, "the failed writer remains terminal");
    const retry = createTurnRecorder({ session: store, sessionId: "s", turnId: "retry", now: () => 0 });

    assert.ok(retry);
    await retry.start({ startedAt: 0, toolCatalogHash: "h", continuation: { capture: () => undefined, restore: () => undefined, acknowledgeNotice: (id) => acknowledged.push(id) } });
    assert.equal((await retry.progress.flush({ transcript: [], envelopes: [envelope] })).ok, true);
    await retry.progress.flush({ transcript: [], envelopes: [envelope] });
    assert.deepEqual(acknowledged, ["notice-1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
