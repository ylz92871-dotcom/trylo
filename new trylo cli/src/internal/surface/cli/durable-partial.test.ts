import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { runTurn } from "../../loop/runner.js";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
} from "../../loop/fakes.js";
import type { ProviderEvent } from "../../ports/provider.js";
import { createTurnRecorder } from "./turn-recorder.js";

/**
 * Durability of a stream that never ended (WP01.2).
 *
 * The case that loses work is not a stream that finished — it is one that was
 * cut: the process killed between two chunks. What the model had already
 * produced is real and must be on disk, without pretending it was an answer.
 */

const FINGERPRINT = {
  schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h",
} as const;

function temp(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-partial-"));
}

/** A stream that opens blocks and then stops without closing any of them. */
function cutStream(events: ProviderEvent[]): ReturnType<typeof createFakeProvider> {
  return createFakeProvider([events]);
}

/**
 * A provider that delivers `prefix` and then dies: the transport fails with the
 * blocks still open.
 *
 * This is the hermetic stand-in for a process killed mid-stream. The loop is
 * inside the stream, no closing event ever arrives, and — unlike a provider
 * that simply hangs — it terminates, so the turn ends and what was written
 * before the cut can be read back.
 */
function dyingProvider(prefix: ProviderEvent[]): ReturnType<typeof createFakeProvider> {
  return {
    ...createFakeProvider([prefix]),

    stream: async function* () {
      for (const event of prefix) yield event;
      throw new Error("connection reset");
    },
  } as ReturnType<typeof createFakeProvider>;
}

test("a text block left open by a killed process is durable, not lost", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const result = await runTurn({
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      progress: recorder.progress,
      provider: dyingProvider([
        { type: "stream_start", providerId: "fixture", model: "m", warnings: [] },
        { type: "text_start", blockId: "b1" },
        { type: "text_delta", blockId: "b1", text: "I was in the middle of saying" },
        { type: "text_delta", blockId: "b1", text: " something when I died" },
      ]),
      tools: createFakeTools([], []),
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "go" });

    assert.equal(result.state.phase, "terminal", "a cut stream ends the turn");

    const recovered = await session.read();

    assert.equal(recovered.ok, true);

    if (!recovered.ok) return;

    assert.deepEqual(
      recovered.session.partials.map(p => p.text),
      ["I was in the middle of saying something when I died"],
      "the received prefix must survive a process killed before the block closed",
    );
    // The durable fact is unfinished: it must NOT have become an answer.
    assert.equal(
      recovered.session.transcript.some(i => i.kind === "assistant_text"),
      false,
      "an unclosed block must never be replayed to a model as a completed answer",
    );
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial tool arguments are preserved but never become an executable call", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const behaviors = [{
      outcome: "result" as const, value: {}, output: "SHOULD-NOT-RUN", truncated: false,
    }];
    const controller = new AbortController();

    void controller;
    const running = runTurn({
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      progress: recorder.progress,
      provider: dyingProvider([
        { type: "stream_start", providerId: "fixture", model: "m", warnings: [] },
        { type: "tool_input_start", toolCallId: "c1", name: "echo" },
        { type: "tool_input_delta", toolCallId: "c1", argumentsText: '{"text":"half' },
      ]),
      tools: createFakeTools([...behaviors], [echoBinding({ needsApproval: false })]),
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "go" });

    await running;

    const records = await session.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) return;

    // Nothing was executed: no intent was ever recorded for an unfinished call.
    assert.equal(
      records.view.records.filter(r => r.type === "effect_issued").length,
      0,
      "unclosed arguments must not be recorded as an issued action",
    );
    const recovered = await session.read();

    assert.equal(recovered.ok, true);

    if (!recovered.ok) return;

    const toolPartial = recovered.session.partials.find(p => p.kind === "tool_input");

    assert.equal(toolPartial?.text, '{"text":"half');
    assert.equal(toolPartial?.name, "echo");
    assert.deepEqual(recovered.session.reconcileRequired, [], "nothing crossed the execution boundary");
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same fact submitted twice is skipped; a changed fact at the same ordinal is refused", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const item = { kind: "user" as const, sequence: 0, text: "once" };

    assert.deepEqual(
      await recorder.progress.flush({ transcript: [item], envelopes: [] }),
      { ok: true },
    );
    // The whole transcript is handed over on every flush; re-submitting it is
    // the port working, not an error.
    assert.deepEqual(
      await recorder.progress.flush({ transcript: [item], envelopes: [] }),
      { ok: true },
      "a re-delivered identical fact must be skipped, not counted as a conflict",
    );
    const records = await session.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) return;

    assert.equal(records.view.records.filter(r => r.type === "transcript_item").length, 1);

    const conflict = await recorder.progress.flush({
      transcript: [{ kind: "user", sequence: 0, text: "DIFFERENT" }],
      envelopes: [],
    });

    assert.equal(conflict.ok, false);

    if (!conflict.ok) {
      assert.equal(conflict.code, "progress_sequence_conflict:transcript_item");
    }
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resumed history re-submitted on the first flush is not a conflict", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const resumed = [{ kind: "user" as const, sequence: 0, text: "earlier" }];
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t2", resumeTranscript: resumed, now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    // The turn replays the whole history it resumed from, then adds its own.
    const flushed = await recorder.progress.flush({
      transcript: [...resumed, { kind: "user", sequence: 1, text: "now" }],
      envelopes: [],
    });

    assert.deepEqual(flushed, { ok: true }, "already-durable history must be recognised, not refused");
    const records = await session.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) return;

    assert.equal(records.view.records.filter(r => r.type === "transcript_item").length, 1, "only the new fact is written");
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stream_partial whose payload is not a partial fails closed on recovery", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const written = await session.append({
      type: "stream_partial",
      sessionId: "s",
      turnId: "t",
      at: "1970-01-01T00:00:01.000Z",
      payload: { kind: "assistant_text", blockId: "b1" },
    });

    assert.equal(written.ok, true);
    const recovered = await session.read();

    assert.equal(recovered.ok, false);

    if (!recovered.ok) {
      assert.equal(recovered.code, "mid_file_corruption");
      assert.match(recovered.detail, /stream_partial/);
    }
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserved text crosses the redaction boundary before it reaches disk", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    await recorder.progress.preserve?.([
      { kind: "assistant_text", blockId: "b1", text: "key is sk-abcdef1234567890 and file /home/x/secret.txt" },
    ]);
    const records = await session.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) return;

    const stored = records.view.records.find(r => r.type === "stream_partial");
    const text = typeof stored?.payload.text === "string" ? stored.payload.text : "";

    assert.equal(text.includes("sk-abcdef1234567890"), false);
    assert.match(text, /\[secret\]/);
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the newest record for one block wins when a stream appends many", async () => {
  const root = temp();
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });

  try {
    await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: FINGERPRINT });
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 })!;

    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });

    for (const text of ["a", "ab", "abc"]) {
      await recorder.progress.preserve?.([{ kind: "assistant_text", blockId: "b1", text }]);
    }

    const recovered = await session.read();

    assert.equal(recovered.ok, true);

    if (!recovered.ok) return;

    assert.deepEqual(recovered.session.partials.map(p => p.text), ["abc"]);
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});

void cutStream;
