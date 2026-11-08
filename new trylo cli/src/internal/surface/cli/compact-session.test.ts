import assert from "node:assert/strict";
import { test } from "node:test";
import { compactNote, compactSession } from "./compact-session.js";
import type { CliContext } from "./context.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import { compactionWiring } from "./compaction-wiring.js";

/**
 * `/compact` on demand.
 *
 * The important case is the empty one: a fresh session has nothing to
 * summarise, and the command has to say so in the store's own words rather
 * than pretending it did something.
 */

function fakeCtx(): CliContext {
  return {
    env: {},
    homeDir: "/home",
    cwd: "/ws",
    nodeVersion: "v22",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => false,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => Date.parse("2026-09-29T12:00:00.000Z"),
    newId: (prefix) => `${prefix}-1`,
  };
}

test("a session with no history says so instead of reporting a compaction", async () => {
  const done = await compactSession(fakeCtx(), "s1", [], undefined);
  assert.equal(done.ok, false);
  assert.match(done.ok ? "" : done.problem, /nothing to compact/i);
});

test("the note names what the window stands in for, and says it was written", () => {
  const note = compactNote(
    {
      windowId: "w1",
      replacedFromSequence: 1,
      replacedToSequence: 9,
      summary: "s",
      formatVersion: "1",
    },
    true,
  );
  assert.equal(note, "compacted 1-9 into w1");
});

test("a single-sequence window is not written as a range", () => {
  const note = compactNote(
    {
      windowId: "w2",
      replacedFromSequence: 3,
      replacedToSequence: 3,
      summary: "s",
      formatVersion: "1",
    },
    false,
  );
  assert.equal(note, "compacted 3 into w2 (this process only: no journal to write to)");
});

test("a journal that refuses the append is reported, not swallowed", async () => {
  const records: ReadonlyArray<SessionRecord> = [
    {
      formatVersion: "1",
      sequence: 0,
      type: "session_start",
      sessionId: "s1",
      at: "2026-09-29T12:00:00.000Z",
      payload: {},
    },
  ];
  const refusing: SessionPort = {
    append: async () => ({ ok: false, code: "locked" }),
    readRecords: async () => ({
      ok: true,
      view: { records, horizonSequence: undefined },
    }),
  } as unknown as SessionPort;
  const done = await compactSession(fakeCtx(), "s1", records, refusing);

  // Either it compressed and could not write, or it had nothing to compress —
  // both are answers. What matters is that neither is a silent success.
  if (done.ok) {
    assert.equal(done.wrote, false, "a refused append must not be reported as written");
  } else {
    assert.match(done.problem, /\w/);
  }
});

test("a non-reducing maintenance draft is refused before the journal append", async () => {
  const records: readonly SessionRecord[] = [{ formatVersion: "1", sequence: 0, sessionId: "s1", type: "transcript_item",
    at: "2026-10-16T00:00:00Z", payload: { kind: "user", sequence: 0, text: "simple task" } }];
  let writes = 0, judged = false;
  const writer: Pick<SessionPort, "append"> = { append: async () => {
    writes += 1;
    return { ok: true, sequence: 1 };
  } };
  const done = await compactSession(fakeCtx(), "s1", records, writer, { accept: () => {
    judged = true;
    return false;
  } });

  assert.equal(judged, true);
  assert.equal(writes, 0);
  assert.deepEqual(done, { ok: false, problem: "nothing_to_reduce" });
});

test("cancellation during authoring never commits the resulting draft", async () => {
  const records: readonly SessionRecord[] = [{ formatVersion: "1", sequence: 0, sessionId: "s1", type: "transcript_item",
    at: "2026-10-16T00:00:00Z", payload: { kind: "user", sequence: 0, text: "simple task" } }];
  const cancel = new AbortController();
  let writes = 0;
  const writer: Pick<SessionPort, "append"> = { append: async () => {
    writes += 1;
    return { ok: true, sequence: 1 };
  } };
  const wiring = compactionWiring({ nowMs: 0, summarize: () => {
    cancel.abort();
    return "safe summary";
  } });
  const done = await compactSession(fakeCtx(), "s1", records, writer, { wiring, signal: cancel.signal });

  assert.deepEqual(done, { ok: false, problem: "cancelled" });
  assert.equal(writes, 0);
});
