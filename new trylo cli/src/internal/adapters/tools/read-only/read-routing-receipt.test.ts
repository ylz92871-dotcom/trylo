import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodeFileSystemReader } from "./node-fs.js";
import { executeReadFile } from "./read-file.js";
import { DEFAULT_READ_ONLY_LIMITS } from "./limits.js";
import type { ReadRoutingRecord } from "../../../ports/read-routing.js";
import { projectRoutingReceipt } from "../../../protocol/routing-receipt.js";

test("a rejected whole-file request retains a valid fallback wire receipt for an actual large read", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "read-routing-receipt-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "large.txt"), "x".repeat(262145) + "\n");
  const records: ReadRoutingRecord[] = [];
  const result = await executeReadFile({ workspaceRoot: root, reader: createNodeFileSystemReader(), readRouting: {
    choose: async () => ({ path: "whole", reason: "learned_policy", versionId: "invalidated-whole-policy" }),
    record: async input => { records.push(input); },
  } }, DEFAULT_READ_ONLY_LIMITS, { name: "read_file", toolCallId: "large-fallback", arguments: { path: "large.txt" } }, new AbortController().signal);

  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") return;

  const receipt = projectRoutingReceipt("read_file", result.value);

  assert.ok(receipt, "guarded fallback must remain visible through the real stream projector");
  assert.deepEqual(receipt.candidateIds, ["stream"]);
  assert.equal(receipt.selectedPath, "stream");
  assert.equal(receipt.actualPath, "stream");
  assert.equal(receipt.reason, "whole_file_limit");
  assert.equal(receipt.versionId, "invalidated-whole-policy");
  assert.ok(receipt.diagnostics.includes("requested_path:whole"));
  assert.equal(records[0]?.decision.path, "whole", "canonical execution fact retains the rejected requested choice");
  assert.equal(records[0]?.actualPath, "stream");
  assert.equal(records[0]?.fallbackReason, "whole_file_limit");
});
