import assert from "node:assert/strict";
import test from "node:test";
import { recover } from "./recovery.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { StreamPartialKind } from "../../protocol/stream-partial.js";

type Row = Pick<SessionRecord, "type" | "payload" | "turnId">;

const start: SessionRecord = {
  formatVersion: "1", sequence: 0, sessionId: "closed-partials", at: "now", type: "session_start",
  payload: { fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } },
};

function row(type: SessionRecord["type"], payload: JsonObject, turnId = "turn-a"): Row {
  return { type, turnId, payload };
}

function partial(kind: StreamPartialKind, turnId = "turn-a", text = "synthetic prefix"): Row {
  return row("stream_partial", { version: "1", kind, blockId: "shared", text,
    ...(kind === "assistant_reasoning" ? { redacted: false } : {}),
    ...(kind === "tool_input" ? { name: "echo" } : {}) }, turnId);
}

function completed(kind: StreamPartialKind, turnId = "turn-a"): Row {
  return row("transcript_item", kind === "tool_input"
    ? { sequence: 0, kind: "tool_call", toolCallId: "shared", name: "echo", arguments: {} }
    : { sequence: 0, kind, blockId: "shared", text: "synthetic completion",
      ...(kind === "assistant_reasoning" ? { redacted: false } : {}) }, turnId);
}

function records(rows: readonly Row[]): SessionRecord[] {
  return [start, ...rows.map((item, index): SessionRecord => ({
    ...item, formatVersion: "1", sequence: index + 1, sessionId: start.sessionId, at: "now",
  }))];
}

function recovered(rows: readonly Row[]) {
  const result = recover(records(rows), false);
  assert.ok(result.ok);
  return result.session;
}

for (const kind of ["assistant_text", "assistant_reasoning", "tool_input"] as const) {
  test(`durable ${kind} completion removes only its matching open partial`, () => {
    const rows = [partial(kind), completed(kind)];
    const session = recovered(rows);
    assert.deepEqual(session.partials, []);
    assert.deepEqual(session.transcript, [rows[1]?.payload]);
  });
  test(`genuinely interrupted ${kind} remains available beside the transcript`, () => {
    const session = recovered([partial(kind)]);
    assert.equal(session.partials.length, 1);
    assert.equal(session.partials[0]?.text, "synthetic prefix");
    assert.deepEqual(session.transcript, []);
  });
  test(`same ${kind} block id in two interrupted turns retains both prefixes`, () => {
    const session = recovered([partial(kind, "old", "old prefix"), partial(kind, "new", "new prefix")]);
    assert.deepEqual(session.partials.map(item => item.text), ["old prefix", "new prefix"]);
  });
}

test("invalid tool arguments close tool_input through the canonical failed result alone", () => {
  const session = recovered([partial("tool_input"), row("transcript_item", {
    sequence: 0, kind: "tool_result", toolCallId: "shared", name: "echo",
    output: "invalid_arguments:synthetic invalid JSON", outcome: "failed", truncated: false,
  })]);
  assert.deepEqual(session.partials, []);
  assert.equal(session.transcript[0]?.kind, "tool_result");
});

test("a completion in another turn cannot close an interrupted block", () => {
  const session = recovered([partial("assistant_text", "old"), completed("assistant_text", "new")]);
  assert.equal(session.partials.length, 1);
});

test("an old completion cannot erase a later turn's same block identity", () => {
  const session = recovered([completed("tool_input", "old"), partial("tool_input", "new")]);
  assert.equal(session.partials.length, 1);
});

test("same block id in another family is not a completion", () => {
  const session = recovered([partial("assistant_reasoning"), partial("tool_input"), completed("assistant_text")]);
  assert.deepEqual(session.partials.map(item => item.kind), ["assistant_reasoning", "tool_input"]);
});

test("a later full snapshot can reopen a completed same-turn identity", () => {
  const session = recovered([partial("assistant_text"), completed("assistant_text"), partial("assistant_text", "turn-a", "new prefix")]);
  assert.equal(session.partials.length, 1);
  assert.equal(session.partials[0]?.text, "new prefix");
});

test("a valid V2 suffix is validated before the completed block is removed", () => {
  const session = recovered([partial("assistant_text", "turn-a", "abc"), row("stream_partial", {
    version: "2", kind: "assistant_text", blockId: "shared", offset: 3, textDelta: "def",
  }), completed("assistant_text")]);
  assert.deepEqual(session.partials, []);
});

test("a closed block does not bypass validation of a later corrupt V2 suffix", () => {
  const outcome = recover(records([partial("assistant_text", "turn-a", "abc"), completed("assistant_text"),
    row("stream_partial", { version: "2", kind: "assistant_text", blockId: "shared", offset: 99, textDelta: "bad" })]), false);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "mid_file_corruption");
});

test("a late valid V2 suffix is checked without reopening a completed block", () => {
  const session = recovered([partial("assistant_text", "turn-a", "abc"), completed("assistant_text"),
    row("stream_partial", { version: "2", kind: "assistant_text", blockId: "shared", offset: 3, textDelta: "def" })]);
  assert.deepEqual(session.partials, []);
});

test("a terminal record alone does not claim an unclosed block completed", () => {
  const session = recovered([partial("assistant_text"), partial("assistant_reasoning"), partial("tool_input"),
    row("terminal", { reason: "completed", finishReason: "stop" })]);
  assert.equal(session.partials.length, 3);
});

test("legacy records without turn ids still close matching canonical blocks", () => {
  const pending = partial("assistant_text"), closed = completed("assistant_text");
  const rows: Row[] = [{ type: pending.type, payload: pending.payload }, { type: closed.type, payload: closed.payload }];
  assert.deepEqual(recovered(rows).partials, []);
});
