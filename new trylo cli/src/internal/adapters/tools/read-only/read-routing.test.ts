import assert from "node:assert/strict";
import { test } from "node:test";
import { executeReadFile } from "./read-file.js";
import { DEFAULT_READ_ONLY_LIMITS, type FileSystemReader } from "./limits.js";
import type { JsonObject } from "../../../protocol/envelope.js";

function readerFor(text: string) {
  const calls: string[] = [];
  const reader: FileSystemReader = {
    readFileUtf8: async () => {
      calls.push("whole");
      return text;
    },
    readFileChunks: async function* () {
      calls.push("stream");
      yield Buffer.from(text);
    },
    readDir: async () => [], statBytes: async () => Buffer.byteLength(text),
  };

  return { reader, calls };
}

test("an adopted route changes the real reader while preserving range content", async () => {
  const input = readerFor("one\ntwo\nthree\n");
  const recorded: unknown[] = [];
  const config = { workspaceRoot: "D:/workspace", reader: input.reader,
    readRouting: {
      choose: async () => ({ path: "whole" as const, reason: "learned_cost", versionId: "route-v1" }),
      record: async (value: unknown) => { recorded.push(value); },
    },
  };
  const output = await executeReadFile(config, DEFAULT_READ_ONLY_LIMITS,
    { name: "read_file", toolCallId: "read-1", arguments: { path: "file.txt", offset: 1, limit: 1 } }, new AbortController().signal);

  assert.equal(output.outcome, "result");

  if (output.outcome !== "result") return;

  assert.equal(output.value.content, "two\n");
  assert.deepEqual(input.calls, ["whole"]);
  assert.equal(recorded.length, 1);
  const report = output.value.routing;

  assert.ok(report && typeof report === "object" && !Array.isArray(report));
  assert.equal("actualPath" in report ? report.actualPath : undefined, "whole");
  assert.equal(recorded.length, 1);
});

function routeConfig(reader: FileSystemReader, path: "whole" | "stream", records: unknown[] = []) {
  return { workspaceRoot: "D:/workspace", reader,
    readRouting: {
      choose: async () => ({ path, reason: "trial", versionId: "route-v1" }),
      record: async (value: unknown) => { records.push(value); },
    },
    nowMs: () => 100,
  };
}

async function read(config: ReturnType<typeof routeConfig>, args: JsonObject = { path: "file.txt" }, signal = new AbortController().signal) {
  return executeReadFile(config, DEFAULT_READ_ONLY_LIMITS,
    { name: "read_file", toolCallId: "read-test", arguments: args }, signal);
}

test("large whole decisions are rejected visibly before the unbounded reader runs", async () => {
  const input = readerFor("large-file-first-line\n");

  input.reader.statBytes = async () => 262145;
  const result = await read(routeConfig(input.reader, "whole"));

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.deepEqual(input.calls, ["stream"]);
  const route = result.value.routing;

  assert.ok(route && typeof route === "object" && "fallbackReason" in route);
  assert.equal(route.fallbackReason, "whole_file_limit");
});

test("a failed adapted reader retries the existing path once and records cost and actual path", async () => {
  const input = readerFor("one\ntwo\n");

  input.reader.readFileUtf8 = async () => {
    input.calls.push("whole");
    throw new Error("whole unavailable");
  };
  const records: unknown[] = [];
  const result = await read(routeConfig(input.reader, "whole", records));

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.equal(result.value.content, "one\ntwo\n");
  assert.deepEqual(input.calls, ["whole", "stream"]);
  assert.equal(records.length, 1);
  const route = result.value.routing;

  assert.ok(route && typeof route === "object" && "fallbackReason" in route);
  assert.equal(route.fallbackReason, "adapted_path_failed");
});

test("missing stream capability returns to the existing whole path", async () => {
  const input = readerFor("one\n");

  delete input.reader.readFileChunks;
  const result = await read(routeConfig(input.reader, "stream"));

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.deepEqual(input.calls, ["whole"]);
  const route = result.value.routing;

  assert.ok(route && typeof route === "object" && "fallbackReason" in route);
  assert.equal(route.fallbackReason, "stream_unavailable");
});

test("routing failures degrade visibly while the original read remains available", async () => {
  const input = readerFor("one\n");
  const config = { ...routeConfig(input.reader, "whole"), readRouting: {
    choose: async (): Promise<never> => { throw new Error("board unavailable"); },
    record: async (): Promise<never> => { throw new Error("board unavailable"); },
  } };
  const result = await read(config);

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.equal(result.value.content, "one\n");
  assert.deepEqual(input.calls, ["stream"]);
  const route = result.value.routing;

  assert.ok(route && typeof route === "object" && "diagnostics" in route);
  assert.deepEqual(route.diagnostics, ["routing_choose_failed", "routing_record_failed"]);
});

test("cancelled adapted reads never retry and retain cancelled feedback", async () => {
  const input = readerFor("one\n");
  const controller = new AbortController();

  input.reader.readFileUtf8 = async () => {
    input.calls.push("whole");
    controller.abort();
    throw new Error("aborted");
  };
  const records: unknown[] = [];
  const result = await read(routeConfig(input.reader, "whole", records), { path: "file.txt" }, controller.signal);

  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(input.calls, ["whole"]);
  assert.equal(records.length, 1);
  assert.ok(typeof records[0] === "object" && records[0] !== null && "outcome" in records[0]);
  assert.equal(records[0].outcome, "cancelled");
});

test("path and range validation happens before routing or stat sampling", async () => {
  let sampled = 0;
  const input = readerFor("one\n");

  input.reader.statBytes = async () => {
    sampled += 1;
    return 4;
  };
  const config = { ...routeConfig(input.reader, "whole"), readRouting: {
    choose: async () => {
      sampled += 1;
      return { path: "whole" as const, reason: "trial", versionId: "route-v1" };
    },
    record: async () => { sampled += 1; },
  } };

  assert.equal((await read(config, { path: "../escape.txt" })).outcome, "error");
  assert.equal((await read(config, { path: "file.txt", offset: -1 })).outcome, "error");
  assert.equal(sampled, 0);
});

test("a file growing after stat falls back without unbounded allocation and counts both attempts", async () => {
  const input = readerFor("one\n");

  input.reader.readFileUtf8Bounded = async (_path, maxBytes) => {
    input.calls.push(`bounded:${maxBytes}`);
    return undefined;
  };
  const result = await read(routeConfig(input.reader, "whole"));

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.deepEqual(input.calls, ["bounded:262144", "stream"]);
  const route = result.value.routing;

  assert.ok(route && typeof route === "object" && "fallbackReason" in route && "bytesRead" in route);
  assert.equal(route.fallbackReason, "whole_file_grew");
  assert.equal(route.bytesRead, 262145 + 4);
});

test("stat sensor failure preserves an existing readable file and skips policy adoption", async () => {
  const input = readerFor("one\n");

  input.reader.statBytes = async () => { throw new Error("stat unavailable"); };
  const result = await read(routeConfig(input.reader, "whole"));

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.deepEqual(input.calls, ["stream"]);
  const route = result.value.routing;

  assert.ok(route && typeof route === "object" && "diagnostics" in route);
  assert.deepEqual(route.diagnostics, ["routing_conditions_unavailable"]);
});

test("default path failure does not loop and failed execution is recorded", async () => {
  const input = readerFor("one\n");

  input.reader.readFileChunks = async function* () {
    input.calls.push("stream");
    throw new Error("disk failure");
  };
  const records: unknown[] = [];
  const result = await read(routeConfig(input.reader, "stream", records));

  assert.equal(result.outcome, "error");
  assert.deepEqual(input.calls, ["stream"]);
  assert.equal(records.length, 1);
  assert.ok(typeof records[0] === "object" && records[0] !== null && "outcome" in records[0]);
  assert.equal(records[0].outcome, "failed");

  if (result.outcome === "error") assert.match(result.message, /routing:/);
});

test("a text-only reader preserves its established whole path for large files", async () => {
  const input = readerFor("one\n");

  delete input.reader.readFileChunks;
  input.reader.statBytes = async () => 1_000_000;
  const records: unknown[] = [];
  const result = await read(routeConfig(input.reader, "whole", records));

  assert.equal(result.outcome, "result");
  assert.deepEqual(input.calls, ["whole"]);
  assert.equal(records.length, 1);
});

test("route selection preserves original Unicode, newline and truncation semantics", async () => {
  const samples = ["", "single", "one\r\ntwo\r\n", "甲🙂\nβ\n", "long".repeat(100) + "\nlast"];
  for (const text of samples) {
    for (const args of [{ path: "file.txt" }, { path: "file.txt", offset: 0, limit: 1 }, { path: "file.txt", offset: 1, limit: 2 }]) {
      const oldReader = readerFor(text);
      const limits = { ...DEFAULT_READ_ONLY_LIMITS, maxBytes: 13, maxLines: 2 };
      const call = { name: "read_file", toolCallId: "compare", arguments: args };
      const original = await executeReadFile({ workspaceRoot: "D:/workspace", reader: oldReader.reader }, limits, call, new AbortController().signal);
      const adapted = await executeReadFile(routeConfig(readerFor(text).reader, "whole"), limits, call, new AbortController().signal);

      assert.equal(adapted.outcome, "result");
      assert.equal(original.outcome, "result");

      if (adapted.outcome !== "result" || original.outcome !== "result") continue;

      const { routing: _routing, ...value } = adapted.value;

      assert.deepEqual(value, original.value);
      assert.equal(adapted.output, original.output);
    }
  }
});
