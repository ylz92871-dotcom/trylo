import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionProgressError } from "../../ports/execution-progress.js";
import type { SessionPort } from "../../ports/session.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { createSubagentJournalSink } from "./subagent-sink.js";

type AppendRecord = Parameters<SessionPort["append"]>[0];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withAppend(append: SessionPort["append"]): SessionPort {
  const unused = async (): Promise<never> => { throw new Error("unexpected session operation"); };
  return { append, start: unused, attach: unused, read: unused, readRecords: unused,
    repairTornTail: unused, release: unused };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function slowSession() {
  const gate = deferred();
  const started = deferred();
  const records: AppendRecord[] = [];
  let active = 0;
  let peak = 0;
  const session = withAppend(async record => {
    active += 1;
    peak = Math.max(peak, active);
    started.resolve();
    await gate.promise;
    records.push(record);
    active -= 1;
    return { ok: true, sequence: records.length };
  });
  return { session, records, started: started.promise, release: gate.resolve, peak: () => peak };
}

function persistedEnvelope(record: AppendRecord): JsonObject {
  const envelope = record.payload.envelope;
  assert.ok(isObject(envelope));
  return envelope;
}

function observation(member: string, text: string, kind = "text", round = 1, id = "block") {
  return { subagentId: member, round, observation: { id, round, kind, text } };
}

function expectFailure(error: unknown, code: string): boolean {
  assert.ok(error instanceof ExecutionProgressError);
  assert.equal(error.stage, "subagent");
  assert.equal(error.code, code);
  return true;
}

for (const kind of ["text", "thinking"]) {
  test(`slow storage preserves the complete latest ${kind} snapshot across 1000 updates`, async () => {
    const storage = slowSession();
    const sink = createSubagentJournalSink({ session: storage.session, sessionId: "session", turnId: "turn", now: () => 0 });
    const rendered: Envelope[] = [];
    sink.setRenderer({ onEnvelope: envelope => { rendered.push(envelope); } });
    sink.onEvent("subagent_update", observation("a", "x", kind), "root");
    await storage.started;
    for (let length = 2; length <= 1000; length += 1) {
      sink.onEvent("subagent_update", observation("a", "x".repeat(length), kind), "root");
    }
    sink.onEvent("subagent_end", { subagentId: "a", status: "completed" }, "root");
    let flushed = false;
    const flushing = sink.flush().then(() => { flushed = true; });
    await Promise.resolve();
    assert.equal(flushed, false, "flush must await the slow append and its queued successors");
    storage.release();
    await flushing;
    const observations = storage.records.map(persistedEnvelope).filter(envelope => envelope.kind === "subagent_update");
    const last = observations.at(-1)?.payload;
    assert.ok(isObject(last));
    const block = last.observation;
    assert.ok(isObject(block));
    assert.equal(block.text, "x".repeat(1000));
    assert.equal(persistedEnvelope(storage.records.at(-1)!).kind, "subagent_end");
    assert.equal(rendered.length, 1001, "renderer must receive every original event");
    assert.equal(storage.peak(), 1, "only one journal append may run at a time");
  });
}

test("interleaved members keep snapshot, tool, report, and lifecycle causality", async () => {
  const storage = slowSession();
  const sink = createSubagentJournalSink({ session: storage.session, sessionId: "session", turnId: "turn", now: () => 0 });
  const rendered: Envelope[] = [];
  sink.setRenderer({ onEnvelope: envelope => { rendered.push(envelope); } });
  sink.onEvent("subagent_spawn", { subagentId: "a" }, "root");
  await storage.started;
  sink.onEvent("subagent_spawn", { subagentId: "b" }, "root");
  sink.onEvent("subagent_update", observation("a", "A1"), "root");
  sink.onEvent("subagent_update", observation("b", "B1"), "root");
  sink.onEvent("subagent_update", observation("a", "A2"), "root");
  sink.onEvent("subagent_update", observation("b", "B2"), "root");
  sink.onEvent("subagent_update", { subagentId: "a", activity: { id: "tool", kind: "tool", tool: "read" } }, "root");
  sink.onEvent("subagent_update", observation("a", "A3"), "root");
  sink.onEvent("subagent_update", observation("b", "B3"), "root");
  sink.onEvent("subagent_update", { subagentId: "b", round: 1,
    observation: { id: "report", round: 1, kind: "report", text: "report", reportState: "progress" } }, "root");
  sink.onEvent("subagent_update", observation("b", "B4"), "root");
  sink.onEvent("subagent_update", { subagentId: "a", activity: { id: "tool", kind: "result", ok: true } }, "root");
  sink.onEvent("subagent_update", observation("a", "A4"), "root");
  sink.onEvent("subagent_end", { subagentId: "a", status: "completed" }, "root");
  sink.onEvent("subagent_end", { subagentId: "b", status: "failed", error: { code: "child_failed" } }, "root");
  storage.release();
  await sink.flush();
  const envelopes = storage.records.map(persistedEnvelope);
  const sequences = envelopes.map(envelope => envelope.sequence);
  assert.ok(sequences.every((sequence, index) => index === 0 || Number(sequence) > Number(sequences[index - 1])),
    "durable envelope sequences must strictly increase");
  const labels = envelopes.map(envelope => {
    const payload = envelope.payload;
    assert.ok(isObject(payload));
    const event = payload.observation ?? payload.activity;
    return isObject(event)
      ? `${payload.subagentId}:${event.text ?? event.kind}` : `${payload.subagentId}:${envelope.kind}`;
  });
  for (const label of ["a:A2", "b:B2", "a:tool", "a:A3", "b:report", "b:B4", "a:result", "a:A4", "a:subagent_end", "b:subagent_end"]) {
    assert.ok(labels.includes(label), `necessary event survives: ${label}`);
  }
  assert.ok(labels.indexOf("a:A2") < labels.indexOf("a:tool"));
  assert.ok(labels.indexOf("a:tool") < labels.indexOf("a:A3"));
  assert.ok(labels.indexOf("a:A3") < labels.indexOf("a:result"));
  assert.ok(labels.indexOf("a:result") < labels.indexOf("a:A4"));
  const barriers = rendered.filter(envelope => {
    const block = envelope.payload.observation;
    return !isObject(block) || !["text", "thinking"].includes(String(block.kind));
  });
  assert.deepEqual(envelopes.filter(envelope => barriers.some(barrier => barrier.eventId === envelope.eventId)).map(envelope => envelope.eventId), barriers.map(envelope => envelope.eventId));
  assert.equal(storage.peak(), 1);
});

test("member, round, observation id, kind, and root attempt isolate snapshot identities", async () => {
  const storage = slowSession();
  const sink = createSubagentJournalSink({ session: storage.session, sessionId: "session", turnId: "turn", now: () => 0 });
  sink.onEvent("subagent_spawn", { subagentId: "a" }, "root");
  await storage.started;
  for (const [member, text, kind, round, id, root] of [
    ["a", "text", "text", 1, "one", "root"], ["b", "member", "text", 1, "one", "root"],
    ["a", "round", "text", 2, "one", "root"], ["a", "id", "text", 1, "two", "root"],
    ["a", "thinking", "thinking", 1, "one", "root"], ["a", "attempt", "text", 1, "one", "other"],
  ] as const) sink.onEvent("subagent_update", observation(member, text, kind, round, id), root);
  storage.release();
  await sink.flush();
  assert.equal(storage.records.length, 7);
});

test("128 independent pending events still exhaust the bounded queue explicitly", async () => {
  const storage = slowSession();
  const sink = createSubagentJournalSink({ session: storage.session, sessionId: "session", turnId: "turn", now: () => 0 });
  for (let index = 0; index < 129; index += 1) sink.onEvent("subagent_update", { subagentId: "a", message: `independent ${index}` }, "root");
  storage.release();
  await assert.rejects(sink.flush(), error => expectFailure(error, "subagent_write_queue_full"));
  assert.equal(storage.records.length, 128, "already accepted events must drain even after overflow");
});

test("append result failure remains an ExecutionProgressError and flush drains accepted events", async () => {
  let appends = 0;
  const session = withAppend(async () => { appends += 1; return { ok: false, code: "disk_full" }; });
  const sink = createSubagentJournalSink({ session, sessionId: "session", turnId: "turn", now: () => 0 });
  sink.onEvent("subagent_spawn", { subagentId: "a" }, "root");
  sink.onEvent("subagent_end", { subagentId: "a", status: "failed" }, "root");
  await assert.rejects(sink.flush(), error => expectFailure(error, "disk_full"));
  await assert.rejects(sink.flush(), error => expectFailure(error, "disk_full"));
  assert.equal(appends, 2);
});

test("real filesystem append rejection remains an explicit session_append_threw failure", async t => {
  const directory = await mkdtemp(join(tmpdir(), "trylo-subagent-sink-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const session = withAppend(async () => { await appendFile(directory, "cannot append to a directory"); return { ok: true, sequence: 1 }; });
  const sink = createSubagentJournalSink({ session, sessionId: "session", turnId: "turn", now: () => 0 });
  sink.onEvent("subagent_end", { subagentId: "a", status: "failed" }, "root");
  await assert.rejects(sink.flush(), error => expectFailure(error, "session_append_threw"));
});

test("a synchronous append throw is captured for flush rather than escaping the observer", async () => {
  const session = withAppend(() => { throw new Error("synchronous storage failure"); });
  const sink = createSubagentJournalSink({ session, sessionId: "session", turnId: "turn", now: () => 0 });
  assert.doesNotThrow(() => sink.onEvent("subagent_end", { subagentId: "a", status: "failed" }, "root"));
  await assert.rejects(sink.flush(), error => expectFailure(error, "session_append_threw"));
});

test("events arriving as a writer becomes idle are included in flush", async () => {
  for (let yields = 0; yields <= 8; yields += 1) {
    const records: AppendRecord[] = [];
    const session = withAppend(async record => { records.push(record); return { ok: true, sequence: records.length }; });
    const sink = createSubagentJournalSink({ session, sessionId: "session", turnId: "turn", now: () => 0 });
    sink.onEvent("subagent_spawn", { subagentId: "a" }, "root");
    for (let index = 0; index < yields; index += 1) await Promise.resolve();
    sink.onEvent("subagent_end", { subagentId: "a", status: "completed" }, "root");
    await sink.flush();
    assert.equal(records.length, 2, `flush includes the event after ${yields} microtask yields`);
  }
});
