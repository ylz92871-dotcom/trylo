import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { createReadOnlyTools } from "./index.js";
import { DEFAULT_READ_ONLY_LIMITS, type FileSystemReader } from "./limits.js";

function textReader(text: string): FileSystemReader {
  return { readFileUtf8: async () => text, readDir: async () => [{ name: "victim.txt", isDirectory: false }], statBytes: async () => Buffer.byteLength(text) };
}

test("range reads use the streaming port and never request a whole-file allocation", async () => {
  const tools = createReadOnlyTools({ workspaceRoot: tmpdir(), reader: {
    ...textReader(""), readFileUtf8: async () => { throw new Error("whole_file_read_forbidden"); },
    async *readFileChunks() { yield Buffer.from("first\nsecond\nthird\n"); },
  } });
  const result = await tools.execute({ name: "read_file", toolCallId: "stream", arguments: { path: "victim.txt", offset: 1, limit: 1 } }, new AbortController().signal);
  assert.equal(result.outcome, "result", JSON.stringify(result));
  if (result.outcome !== "result") return;
  assert.equal(result.value.content, "second\n");
  assert.equal(result.value.totalLines, 3);
  assert.equal(result.value.nextOffset, 2);
});

test("streamed UTF8, CRLF, oversized lines and legacy reads agree across byte chunk boundaries", async () => {
  const fixtures = ["", "\n", "\r\n", "a\nb\nc", "a\nb\nc\n", "中😀\r\nB\n最后", "one\n" + "界".repeat(40) + "\ntail", "x".repeat(120)];
  let cases = 0;
  for (const text of fixtures) for (const maxBytes of [0, 1, 3, 7, 19, 200]) for (const maxLines of [1, 3]) {
    const reader = textReader(text);
    const data = Buffer.from(text);
    const limits = { ...DEFAULT_READ_ONLY_LIMITS, maxBytes, maxLines };
    const original = createReadOnlyTools({ workspaceRoot: tmpdir(), reader, limits });
    for (const chunkSize of [1, 7, 65_536]) {
      const streamed = createReadOnlyTools({ workspaceRoot: tmpdir(), reader: { ...reader,
        async *readFileChunks() { for (let i = 0; i < data.length; i += chunkSize) yield data.subarray(i, i + chunkSize); },
      }, limits });
      for (const args of [{ path: "victim.txt" }, { path: "victim.txt", offset: 0 }, { path: "victim.txt", offset: 1, limit: 2 }, { path: "victim.txt", offset: 12 }]) {
        const call = { name: "read_file", toolCallId: "equivalence", arguments: args };
        const signal = new AbortController().signal;
        assert.deepEqual(await streamed.execute(call, signal), await original.execute(call, signal), JSON.stringify({ text, maxBytes, maxLines, chunkSize, args }));
        cases += 1;
      }
    }
  }
  assert.equal(cases, 1152);
});

test("a catastrophic regex times out and a subsequent ordinary search remains healthy", async () => {
  const tools = createReadOnlyTools({ workspaceRoot: tmpdir(), reader: textReader("a".repeat(40) + "!") });
  const result = await tools.execute({ name: "search_text", toolCallId: "budget", arguments: { pattern: "(a+)+$", mode: "regex" } }, new AbortController().signal);
  assert.equal(result.outcome, "error", JSON.stringify(result));
  if (result.outcome === "error") assert.equal(result.code, "regex_timeout");
  const healthy = await tools.execute({ name: "search_text", toolCallId: "healthy", arguments: { pattern: "a+", mode: "regex" } }, new AbortController().signal);
  assert.equal(healthy.outcome, "result", JSON.stringify(healthy));
  if (healthy.outcome === "result") assert.equal(healthy.value.matchCount, 1);
});

test("cancelling a catastrophic regex interrupts execution and releases the worker", async () => {
  const tools = createReadOnlyTools({ workspaceRoot: tmpdir(), reader: textReader("a".repeat(40) + "!") });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await tools.execute({ name: "search_text", toolCallId: "cancel", arguments: { pattern: "(a+)+$", mode: "regex" } }, controller.signal);
    assert.equal(result.outcome, "cancelled");
  } finally { clearTimeout(timer); }
});
