import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createNdjsonSessionStore } from "../adapters/session-store/ndjson.js";
import { createCompactionService } from "../compaction/service.js";
import { testScratchPath } from "../testing/scratch.js";

// Each child imports fresh owners, attaches the native store, adopts only the
// latest resumed window, and appends a new draft without rewriting history.
const CHILD = `
import assert from "node:assert/strict";
import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const { createNdjsonSessionStore } = await import(input.store);
const { createCompactionService } = await import(input.service);
const { adoptResumedWindow, createCompactionLedger, journalView, windowOnJournal } = await import(input.ledger);
const store = createNdjsonSessionStore({ path: input.journal });
const at = "2026-11-08T00:00:00.000Z", sessionId = "cross-process-window-id";
const opened = fs.existsSync(input.journal) ? await store.attach() : await store.start({ sessionId, createdAt: at,
  fingerprint: { schemaVersion: "1", providerId: "no-provider", model: "no-model", toolCatalogHash: "empty", workspaceId: "fixture" } });
assert.equal(opened.ok, true);
try {
  const before = await store.read(); assert.equal(before.ok, true);
  const ordinal = before.session.transcript.length;
  assert.equal((await store.append({ type: "turn_start", sessionId, at, payload: {} })).ok, true);
  for (const [index, kind] of ["user", "assistant_text"].entries()) {
    const payload = kind === "user" ? { kind, sequence: ordinal + index, text: "Continue observed work." }
      : { kind, sequence: ordinal + index, blockId: "done", text: "Completed one observation." };
    assert.equal((await store.append({ type: "transcript_item", sessionId, at, payload })).ok, true);
  }
  const read = await store.read(), raw = await store.readRecords();
  assert.equal(read.ok, true); assert.equal(raw.ok, true); assert.equal(raw.view.tornTail, false);
  const service = createCompactionService(), projected = service.projectForPrompt({ records: raw.view.records });
  assert.equal(projected.ok, true);
  const ledger = createCompactionLedger();
  adoptResumedWindow(ledger, projected.view.window, raw.view.records, read.session.transcript);
  const decision = journalView(sessionId, read.session.transcript, ledger.entries, ledger.resumed);
  assert.equal(decision.filter(record => record.type === "compact").length, input.round === 1 ? 0 : 1);
  const outcome = service.compact({ records: decision, sessionId, at, summary: "Observed progress; continue the current task." });
  assert.equal(outcome.ok, true);
  const mapped = windowOnJournal(outcome.record.payload, raw.view.records, decision);
  assert.notEqual(mapped, undefined);
  assert.equal((await store.append({ ...outcome.record, payload: mapped })).ok, true);
  console.log(JSON.stringify({ windowId: mapped.windowId, keys: Object.keys(mapped).sort() }));
} finally { await store.release(); }
`;

test("four fresh processes resume the native journal with w1, w2, w3, w4", async () => {
  const scratch = testScratchPath(), root = mkdtempSync(path.join(scratch, "compaction-window-id-"));
  const journal = path.join(root, "session.ndjson");

  try {
    let previousBytes = Buffer.alloc(0);

    for (let round = 1; round <= 4; round++) {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", CHILD], { encoding: "utf8", windowsHide: true,
        input: JSON.stringify({ journal, round, store: new URL("../adapters/session-store/ndjson.js", import.meta.url).href,
          service: new URL("../compaction/service.js", import.meta.url).href, ledger: new URL("../loop/compact-ledger.js", import.meta.url).href }) });
      if (child.error) throw child.error;

      assert.equal(child.status, 0, child.stderr);
      const result: { windowId: string; keys: string[] } = JSON.parse(child.stdout);

      assert.equal(result.windowId, `w${round}`);
      assert.deepEqual(result.keys, ["formatVersion", "replacedFromSequence", "replacedToSequence", "summary", "windowId"]);
      const currentBytes = readFileSync(journal);

      assert.deepEqual(currentBytes.subarray(0, previousBytes.length), previousBytes, "previous durable bytes are append-only");
      previousBytes = currentBytes;
    }

    const read = await createNdjsonSessionStore({ path: journal }).readRecords();

    assert.equal(read.ok, true);
    assert.equal(read.view.tornTail, false);
    assert.deepEqual(read.view.records.filter(record => record.type === "compact").map(record => record.payload["windowId"]), ["w1", "w2", "w3", "w4"]);
    assert.equal(createCompactionService().projectForPrompt({ records: read.view.records }).ok, true);
  } finally {
    assert.equal(path.dirname(root), scratch);
    rmSync(root, { recursive: true, force: true });
  }
});
