import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { command, userRuleDraft } from "../../learning/control/fixtures.js";
import { createFileBoardStore } from "./file-event-store.js";
import { releaseLock, tryAcquireLock, type LockHandle } from "./lock.js";
import { repairBoardTornTail } from "./torn-tail-repair.js";

async function tornBoard(): Promise<{ readonly root: string; readonly prefix: Buffer; readonly original: Buffer; readonly tail: Buffer }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-board-torn-"));
  const store = createFileBoardStore(root);

  assert.equal("apply" in store, true, JSON.stringify(store));

  if (!("apply" in store)) throw new Error("cannot create test Board");

  assert.equal((await store.apply(command("submit_proposal", { proposal: userRuleDraft({ proposalId: "前缀-保持" }), commandId: "prefix-command" }))).ok, true);
  await store.close();
  const file = path.join(root, "board-events.ndjson");
  const prefix = readFileSync(file);
  const tail = Buffer.from('incomplete {"中文":"尾巴"', "utf8");

  appendFileSync(file, tail);

  return { root, prefix, tail, original: readFileSync(file) };
}

test("torn tail prevents append, snapshot and compaction without altering original bytes", async () => {
  const fixture = await tornBoard();
  const store = createFileBoardStore(fixture.root);

  assert.equal("apply" in store, true);

  if (!("apply" in store)) return;

  try {
    const applied = await store.apply(command("submit_proposal", { proposal: userRuleDraft({ proposalId: "must-not-write" }), commandId: "must-not-write-command" }));

    assert.equal(!applied.ok && applied.reason, "torn_write");
    const snapshot = await store.snapshot(0);

    assert.equal(!snapshot.ok && snapshot.reason, "torn_write");
    const compacted = await store.compact(0);

    assert.equal(!compacted.ok && compacted.reason, "torn_write");
    assert.equal(readFileSync(path.join(fixture.root, "board-events.ndjson")).equals(fixture.original), true);
    assert.equal(existsSync(path.join(fixture.root, "board-snapshot.json")), false);
  } finally { await store.close(); }
});

test("explicit repair quarantines exact original and tail with hash/byte offset, then permits new events", async () => {
  const fixture = await tornBoard();
  const repaired = await repairBoardTornTail(fixture.root);

  assert.equal(repaired.ok && repaired.status, "repaired", JSON.stringify(repaired));

  if (!repaired.ok || repaired.evidenceDirectory === undefined) return;

  const evidence = repaired.evidenceDirectory;

  assert.equal(path.dirname(evidence), path.join(fixture.root, "quarantine"));
  assert.equal(readFileSync(path.join(evidence, "original.ndjson")).equals(fixture.original), true);
  assert.equal(readFileSync(path.join(evidence, "tail.bin")).equals(fixture.tail), true);
  const metadata = JSON.parse(readFileSync(path.join(evidence, "evidence.json"), "utf8"));

  assert.equal(metadata.originalSha256, createHash("sha256").update(fixture.original).digest("hex"));
  assert.equal(metadata.retainedBytes, fixture.prefix.length);
  assert.equal(readFileSync(path.join(fixture.root, "board-events.ndjson")).equals(fixture.prefix), true);
  const store = createFileBoardStore(fixture.root);

  assert.equal("apply" in store, true);

  if (!("apply" in store)) return;

  try {
    assert.equal((await store.apply(command("submit_proposal", { proposal: userRuleDraft({ proposalId: "after-repair" }), commandId: "after-repair-command" }))).ok, true);
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.state.proposals.map(proposal => proposal.proposalId), ["前缀-保持", "after-repair"]);
  } finally { await store.close(); }

  const again = await repairBoardTornTail(fixture.root);

  assert.equal(again.ok && again.status, "not_needed");
  assert.equal(readdirSync(path.join(fixture.root, "quarantine")).length, 1);
});

test("failed evidence or verification leaves the original intact and a retry preserves separate evidence", async () => {
  for (const fault of ["throw", "corrupt-evidence", "change-log"] as const) {
    const fixture = await tornBoard();
    const result = await repairBoardTornTail(fixture.root, { onStage(stage) {
      if (stage !== "evidence_saved") return;

      if (fault === "throw") throw new Error("injected after durable evidence");

      if (fault === "change-log") appendFileSync(path.join(fixture.root, "board-events.ndjson"), "changed");
      else {
        const evidence = readdirSync(path.join(fixture.root, "quarantine"))[0]!;
        writeFileSync(path.join(fixture.root, "quarantine", evidence, "evidence.json"), "corrupt");
      }
    } });

    assert.equal(!result.ok && result.reason, "board_unavailable");
    const expected = fault === "change-log" ? Buffer.concat([fixture.original, Buffer.from("changed")]) : fixture.original;

    assert.equal(readFileSync(path.join(fixture.root, "board-events.ndjson")).equals(expected), true);
    const retried = await repairBoardTornTail(fixture.root);

    assert.equal(retried.ok && retried.status, "repaired");
    assert.equal(readdirSync(path.join(fixture.root, "quarantine")).length, 2);
  }
});

test("repair refuses legacy lock, active owner, corrupt complete records and changed ownership", async () => {
  const fixture = await tornBoard();
  const file = path.join(fixture.root, "board-writer.lock");

  writeFileSync(file, "");
  const legacy = await repairBoardTornTail(fixture.root);

  assert.equal(!legacy.ok && legacy.reason, "multi_writer");
  assert.equal(readFileSync(file).length, 0);
  unlinkSync(file);
  const active = tryAcquireLock(file);

  assert.equal("ok" in active, false);
  const blocked = await repairBoardTornTail(fixture.root);

  assert.equal(!blocked.ok && blocked.reason, "multi_writer");

  if (!("ok" in active)) releaseLock(active);

  let replacement: LockHandle | undefined;
  const fenced = await repairBoardTornTail(fixture.root, { onStage(stage) {
    if (stage !== "before_truncate") return;
    unlinkSync(file);
    const acquired = tryAcquireLock(file);
    assert.equal("ok" in acquired, false);
    if (!("ok" in acquired)) replacement = acquired;
  } });

  assert.equal(!fenced.ok && fenced.reason, "multi_writer");
  assert.equal(readFileSync(path.join(fixture.root, "board-events.ndjson")).equals(fixture.original), true);

  if (replacement !== undefined) releaseLock(replacement);

  writeFileSync(path.join(fixture.root, "board-events.ndjson"), "bad complete record\npartial");
  const corrupt = await repairBoardTornTail(fixture.root);

  assert.equal(!corrupt.ok && corrupt.reason, "checksum_mismatch");
  assert.equal(readFileSync(path.join(fixture.root, "board-events.ndjson"), "utf8"), "bad complete record\npartial");
});
