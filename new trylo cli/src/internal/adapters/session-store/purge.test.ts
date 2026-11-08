import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SESSION_FORMAT_VERSION, type SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { Transcript, TranscriptItem } from "../../protocol/transcript.js";
import { createNdjsonSessionStore, encodeLine } from "./ndjson.js";
import { allToolCallsSettled, purgeUnsettledToolCalls } from "./transcript-purge.js";

/**
 * 读时净化：未闭合的 tool 请求不得进入 resume 之后的对话（WP §3）。
 *
 * goose 思想（D4 §3）：修对话，不编造结果。崩溃落在工具调用之后、结果之前时，
 * resume 读回的 transcript 必须只留下已 settle 的部分——删掉悬空的请求，
 * 绝不补一个「工具已取消」式的假结果。
 *
 * 落点在 store 的读路径上：落盘字节原样保留（这不是 repair），净化只发生在
 * 投影里，所以这里同时钉住「journal 没有被改写」。
 */

function tempFile(): { readonly path: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trylo-purge-"));
  return { path: join(dir, "session.ndjson"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `Omit` does not distribute over a union, so the item bodies get their own helper. */
type ItemBody = TranscriptItem extends infer T ? (T extends { sequence: number } ? Omit<T, "sequence"> : never) : never;

function item(sequence: number, body: ItemBody): TranscriptItem {
  return { sequence, ...body } as TranscriptItem;
}

function journalLine(sequence: number, record: Omit<SessionRecord, "formatVersion" | "sequence">): string {
  return encodeLine(sequence, { ...record, formatVersion: SESSION_FORMAT_VERSION, sequence });
}

const FINGERPRINT = {
  schemaVersion: SESSION_FORMAT_VERSION,
  providerId: "fixture",
  model: "m",
  toolCatalogHash: "h",
  workspaceId: "w",
};

function sessionStart(sequence: number): string {
  return journalLine(sequence, {
    type: "session_start",
    sessionId: "s",
    at: "1970-01-01T00:00:00.000Z",
    payload: { fingerprint: FINGERPRINT },
  });
}

function transcriptItem(sequence: number, value: TranscriptItem): string {
  return journalLine(sequence, {
    type: "transcript_item",
    sessionId: "s",
    at: "1970-01-01T00:00:00.000Z",
    payload: value as unknown as JsonObject,
  });
}

test("a journal that crashed after a tool call resumes without the unfinished request", async () => {
  const fx = tempFile();
  try {
    mkdirSync(join(fx.path, ".."), { recursive: true });
    const lines = [
      sessionStart(0),
      transcriptItem(1, item(0, { kind: "user", text: "write the file" })),
      transcriptItem(
        2,
        item(1, { kind: "assistant_text", blockId: "b1", text: "writing now" }),
      ),
      transcriptItem(
        3,
        item(2, {
          kind: "tool_call",
          toolCallId: "call-torn",
          name: "write_file",
          arguments: { path: "out.txt", content: "x" },
        }),
      ),
    ];

    writeFileSync(fx.path, lines.join("\n") + "\n");

    const store = createNdjsonSessionStore({ path: fx.path });
    const attached = await store.attach();

    assert.equal(attached.ok, true);
    const recovered = await store.read();

    await store.release();
    assert.equal(recovered.ok, true);

    if (!recovered.ok) {
      return;
    }

    // The request is gone, and nothing was invented in its place.
    const kinds = recovered.session.transcript.map((entry) => entry.kind);

    assert.deepEqual(kinds, ["user", "assistant_text"]);
    assert.equal(
      recovered.session.transcript.some((entry) => entry.kind === "tool_result"),
      false,
      "a missing tool result must never be synthesised",
    );
  } finally {
    fx.cleanup();
  }
});

test("the purge is read-time only: the stored journal keeps every byte", async () => {
  const fx = tempFile();
  try {
    const lines = [
      sessionStart(0),
      transcriptItem(1, item(0, { kind: "user", text: "go" })),
      transcriptItem(
        2,
        item(1, { kind: "tool_call", toolCallId: "call-torn", name: "read_file", arguments: {} }),
      ),
    ];

    writeFileSync(fx.path, lines.join("\n") + "\n");
    const before = lines.length;

    const store = createNdjsonSessionStore({ path: fx.path });
    const attached = await store.attach();

    assert.equal(attached.ok, true);
    await store.read();
    const records = await store.readRecords();

    await store.release();
    assert.equal(records.ok, true);

    if (!records.ok) {
      return;
    }

    assert.equal(records.view.records.length, before, "the journal is a record, not a projection");
  } finally {
    fx.cleanup();
  }
});

test("a settled tool call survives the read", async () => {
  const fx = tempFile();
  try {
    const lines = [
      sessionStart(0),
      transcriptItem(1, item(0, { kind: "user", text: "read it" })),
      transcriptItem(
        2,
        item(1, { kind: "tool_call", toolCallId: "call-ok", name: "read_file", arguments: {} }),
      ),
      transcriptItem(
        3,
        item(2, {
          kind: "tool_result",
          toolCallId: "call-ok",
          name: "read_file",
          output: "contents",
          truncated: false,
          outcome: "succeeded",
        }),
      ),
      transcriptItem(
        4,
        item(3, { kind: "tool_call", toolCallId: "call-torn", name: "write_file", arguments: {} }),
      ),
    ];

    writeFileSync(fx.path, lines.join("\n") + "\n");

    const store = createNdjsonSessionStore({ path: fx.path });
    const attached = await store.attach();

    assert.equal(attached.ok, true);
    const recovered = await store.read();

    await store.release();
    assert.equal(recovered.ok, true);

    if (!recovered.ok) {
      return;
    }

    const ids = recovered.session.transcript
      .filter((entry): entry is Extract<TranscriptItem, { kind: "tool_call" }> => entry.kind === "tool_call")
      .map((entry) => entry.toolCallId);

    assert.deepEqual(ids, ["call-ok"], "only the settled call is kept");
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The pure policy, pinned directly (the store tests above exercise it end to end)
// ---------------------------------------------------------------------------

test("a cancelled result still settles its call: only a missing result is torn", () => {
  const transcript: Transcript = [
    item(0, { kind: "tool_call", toolCallId: "c1", name: "write_file", arguments: {} }),
    item(1, {
      kind: "tool_result",
      toolCallId: "c1",
      name: "write_file",
      output: "cancelled",
      truncated: false,
      outcome: "cancelled",
    }),
  ];
  const purged = purgeUnsettledToolCalls(transcript);

  assert.equal(purged, transcript, "a settled history is returned untouched");
});

test("an unsettled call anywhere in the transcript is dropped, never answered", () => {
  const transcript: Transcript = [
    item(0, { kind: "user", text: "one" }),
    item(1, { kind: "tool_call", toolCallId: "torn-old", name: "read_file", arguments: {} }),
    item(2, { kind: "assistant_text", blockId: "b1", text: "later" }),
    item(3, { kind: "tool_call", toolCallId: "torn-new", name: "write_file", arguments: {} }),
  ];
  const purged = purgeUnsettledToolCalls(transcript);
  const kinds = purged.map((entry) => entry.kind);

  assert.deepEqual(kinds, ["user", "assistant_text"]);
  assert.equal(
    purged.some((entry) => entry.kind === "tool_result"),
    false,
    "no result may be fabricated for a dropped request",
  );
});

test("an empty transcript purges to an empty transcript", () => {
  assert.deepEqual([...purgeUnsettledToolCalls([])], []);
  assert.equal(allToolCallsSettled([]), true);
});
