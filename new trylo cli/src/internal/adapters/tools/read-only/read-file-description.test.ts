import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { testScratchPath } from "../../../testing/scratch.js";
import { READ_ONLY_BINDINGS } from "./bindings.js";
import { DEFAULT_READ_ONLY_LIMITS, type ReadOnlyToolLimits } from "./limits.js";
import { createNodeFileSystemReader } from "./node-fs.js";
import { executeReadFile } from "./read-file.js";

function fixture(t: TestContext, source: string) {
  const root = mkdtempSync(testScratchPath("read-description-"));

  t.after(() => {
    assert.equal(path.dirname(root), testScratchPath());
    assert.ok(path.basename(root).startsWith("read-description-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(path.join(root, "source.txt"), source, "utf8");

  return async (args: JsonObject = {}, limits: ReadOnlyToolLimits = DEFAULT_READ_ONLY_LIMITS) => {
    const result = await executeReadFile({ workspaceRoot: root, reader: createNodeFileSystemReader() }, limits,
      { name: "read_file", toolCallId: "description-contract", arguments: { path: "source.txt", ...args } }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") throw new Error("fixture_read_failed");
    return result;
  };
}

test("the mounted description distinguishes complete default plain text from structured positions", async t => {
  const source = "alpha\nbeta\ngamma\n", read = fixture(t, source), result = await read();

  assert.equal(result.output, source, "complete nonempty legacy reads have no positioning header");
  assert.equal(result.truncated, false);
  assert.deepEqual([result.value.startLine, result.value.endLine, result.value.totalLines], [1, 3, 3]);
  const binding = READ_ONLY_BINDINGS.find(candidate => candidate.name === "read_file");
  assert.ok(binding);
  assert.doesNotMatch(binding.description, /The output starts with positioning metadata/,
    "an unconditional header promise contradicts the actual plain legacy result");
  assert.match(binding.description, /Structured results carry positioning metadata/);
  assert.match(binding.description, /complete nonempty default read has no positioning header/);
  assert.match(binding.description, /explicit offset\/limit, a truncated source selection or an empty result/);
});

test("explicit ranges retain their existing positioning header and pure structured source", async t => {
  const read = fixture(t, "alpha\nbeta\ngamma\n"), result = await read({ offset: 1, limit: 1 });
  const newline = result.output.indexOf("\n"), header: unknown = JSON.parse(result.output.slice(0, newline));
  assert.ok(typeof header === "object" && header !== null && "startLine" in header && "endLine" in header);
  assert.equal(header.startLine, 2);
  assert.equal(header.endLine, 2);
  assert.equal(result.output.slice(newline + 1), "beta\n");
  assert.equal(result.value.content, "beta\n");
});

test("a truncated default source selection retains its existing header", async t => {
  const read = fixture(t, "alpha\nbeta\ngamma\n"), result = await read({}, { ...DEFAULT_READ_ONLY_LIMITS, maxLines: 1 });
  const header: unknown = JSON.parse(result.output.slice(0, result.output.indexOf("\n")));
  assert.ok(typeof header === "object" && header !== null && "truncatedLines" in header);
  assert.equal(header.truncatedLines, true);
  assert.equal(result.truncated, true);
  assert.equal(result.value.content, "alpha");
});

test("an empty default result retains its existing positioning header", async t => {
  const read = fixture(t, ""), result = await read();
  const header: unknown = JSON.parse(result.output.slice(0, result.output.indexOf("\n")));
  assert.ok(typeof header === "object" && header !== null && "startLine" in header && "endLine" in header);
  assert.equal(header.startLine, 0);
  assert.equal(header.endLine, 0);
  assert.equal(result.value.content, "");
  assert.equal(result.truncated, false);
});
