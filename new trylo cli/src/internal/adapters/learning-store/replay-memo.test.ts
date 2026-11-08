import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { command, userRuleDraft } from "../../learning/control/fixtures.js";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { decodeLog, encodeRecord } from "./codec.js";
import { createBoardReader, createFileBoardStore, withBoardWriter } from "./file-event-store.js";
import { BoardReplayMemo, boardReplayMemo } from "./replay-memo.js";

async function directory(t: TestContext) {
  const parent = testScratchPath("board-replay-memo");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  t.after(async () => { boardReplayMemo.forget(root);
  assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true }); });
  return root;
}

function original(proposalId = "proposal:a") {
  const first = command("submit_proposal", { commandId: "original", proposal: userRuleDraft({ proposalId }) });
  const result = reduce(emptyBoardState(), first);
  assert.ok(result.ok);
  const record = { sequence: 1, commandId: first.commandId, command: first, events: result.events };
  return { raw: encodeRecord(record), state: result.state, first };
}

function observe(t: TestContext) {
  const modes: ("exact" | "suffix" | undefined)[] = [], read = boardReplayMemo.read.bind(boardReplayMemo);
  t.mock.method(boardReplayMemo, "read", (root: string, raw: Buffer) => {
    const result = read(root, raw);
    modes.push(result?.mode);
    return result;
  });
  return modes;
}

test("fresh readers reuse exact bytes and only an appended suffix without exposing cached objects", async t => {
  const root = await directory(t), file = path.join(root, "board-events.ndjson"), prefix = original(), modes = observe(t);

  await writeFile(file, prefix.raw);
  const cold = await createBoardReader(root).load();
  assert.ok(cold.ok);
  assert.deepEqual(cold.state, prefix.state);
  Object.assign(cold.state.proposals[0]!, { hypothesis: "caller mutation" });
  const exact = await createBoardReader(root).load();
  assert.ok(exact.ok);
  assert.deepEqual(exact.state, prefix.state);
  Object.assign(exact.state.appliedCommands[0]!, { commandId: "caller mutation" });
  const next = command("fast_lane_validate", { commandId: "next", proposalId: "proposal:a" });
  const reduced = reduce(prefix.state, next);
  assert.ok(reduced.ok);
  await writeFile(file, `${prefix.raw}\n${encodeRecord({ sequence: 2, commandId: next.commandId, command: next, events: reduced.events })}`);
  const suffix = await createBoardReader(root).load();
  assert.ok(suffix.ok);
  assert.deepEqual(suffix.state, reduced.state);
  assert.deepEqual(modes, [undefined, "exact", "suffix"]);
  const full = await readFile(file), race = new BoardReplayMemo();

  race.remember(root, full, reduced.state, 2);
  race.remember(root, Buffer.from(prefix.raw), prefix.state, 1); // An older concurrent load finishes last.
  const afterOldPublish = race.read(root, full);
  assert.equal(afterOldPublish?.mode, "suffix");
  assert.deepEqual(afterOldPublish.state, reduced.state);
  const bounded = new BoardReplayMemo(2, Buffer.byteLength(prefix.raw) * 2), bytes = Buffer.from(prefix.raw);

  bounded.remember("root:a", bytes, prefix.state, 1);
  bounded.remember("root:b", bytes, prefix.state, 1);
  bounded.remember("root:c", bytes, prefix.state, 1);
  assert.equal(bounded.read("root:a", bytes), undefined);
  bounded.remember("oversize", Buffer.concat([bytes, bytes, bytes]), prefix.state, 1);
  assert.equal(bounded.read("oversize", bytes), undefined);
});

test("replacement, truncation, damaged suffix and torn-tail write keep the original cold contracts", async t => {
  const root = await directory(t), file = path.join(root, "board-events.ndjson"), a = original(), b = original("proposal:b");
  const read = () => createBoardReader(root).load();
  await writeFile(file, a.raw);
  assert.ok((await read()).ok);
  assert.equal(a.raw.length, b.raw.length);
  await writeFile(file, b.raw);
  const replaced = await read();
  assert.ok(replaced.ok);
  assert.deepEqual(replaced.state, b.state);
  await writeFile(file, "");
  const empty = await read();
  assert.ok(empty.ok);
  assert.equal(empty.state.sequence, 0);
  await writeFile(file, a.raw);
  assert.ok((await read()).ok);
  await writeFile(file, `${a.raw}incomplete`);
  const torn = await read();
  assert.ok(torn.ok);
  assert.deepEqual(torn.state, a.state);
  const store = createFileBoardStore(root);
  assert.ok("apply" in store);

  try {
    const blocked = await store.apply(command("fast_lane_validate", { proposalId: "proposal:a", commandId: "blocked" }));
    assert.equal(!blocked.ok && blocked.reason, "torn_write");
    assert.equal(await readFile(file, "utf8"), `${a.raw}incomplete`);
  } finally { await store.close(); }

  await writeFile(file, a.raw);
  assert.ok((await read()).ok);
  const next = command("quarantine", { proposalId: "proposal:a", commandId: "gap" });

  await writeFile(file, a.raw + encodeRecord({ sequence: 3, commandId: next.commandId, command: next, events: [] }));
  const gap = await read();
  assert.equal(!gap.ok && gap.reason, "sequence_gap");
  await writeFile(file, a.raw);
  assert.ok((await read()).ok);
  await writeFile(file, `${a.raw}deadbeef {}\n`);
  const corrupt = await read();
  assert.equal(!corrupt.ok && corrupt.reason, "checksum_mismatch");
});

test("snapshot generation remains per store and a throwing appender invalidates rather than inventing success", async t => {
  const root = await directory(t), file = path.join(root, "board-events.ndjson"), prefix = original(), modes = observe(t);

  await writeFile(file, prefix.raw);
  assert.ok((await createBoardReader(root).load()).ok);
  await writeFile(path.join(root, "board-snapshot.json"), "invalid snapshot");
  const beforeInvalid = modes.length, invalid = await createBoardReader(root).load();
  assert.ok(invalid.ok);
  assert.deepEqual(invalid.state, prefix.state);
  assert.equal(modes.length, beforeInvalid);
  await rm(path.join(root, "board-snapshot.json"));
  const store = createFileBoardStore(root);
  assert.ok("apply" in store);

  try {
    const snapshot = await store.snapshot(0);
    assert.ok(snapshot.ok);
    assert.equal(snapshot.generation, 1);
  }
  finally { await store.close(); }

  const count = modes.length, snapRead = await createBoardReader(root).load();
  assert.ok(snapRead.ok);
  assert.equal(snapRead.generation, 1);
  assert.equal(modes.length, count);
  await rm(path.join(root, "board-snapshot.json"));
  assert.ok((await createBoardReader(root).load()).ok);
  let appends = 0;
  const unknown = await withBoardWriter(root, async writer => writer.apply(command("fast_lane_validate", {
    proposalId: "proposal:a", commandId: "unknown" })), { logAppender(target, data, encoding) {
    appends++;
    appendFileSync(target, data, encoding);
    throw new Error("acknowledgement lost after append");
  } });

  assert.equal(!unknown.ok && unknown.reason, "board_unavailable");
  assert.equal(appends, 1);
  const raw = await readFile(file);
  assert.equal(boardReplayMemo.read(root, raw), undefined);
  const actual = await createBoardReader(root).load();
  assert.ok(actual.ok);
  assert.equal(actual.state.sequence, 2);
  const decoded = decodeLog(raw.toString("utf8"));
  assert.ok(decoded.ok);
  assert.equal(decoded.records.length, 2);
});

test("suffix replay cannot restore an old missing command identity from a new payload", async t => {
  const root = await directory(t), file = path.join(root, "board-events.ndjson"), prefix = original();

  await writeFile(file, prefix.raw);
  assert.ok((await createBoardReader(root).load()).ok);
  const conflict = command("record_reward_v2_fact", { commandId: "original", expectedSequence: 1,
    fact: { id: "fact:conflict", scope: "workspace:conflict", kind: "projection", algorithmVersion: "test", payloadJson: "{}" } });

  await writeFile(file, prefix.raw + encodeRecord({ sequence: 2, commandId: conflict.commandId, command: conflict, events: [] }));
  const warm = await createBoardReader(root).load();
  assert.equal(!warm.ok && warm.reason, "command_identity_unavailable");
  boardReplayMemo.forget(root);
  assert.deepEqual(await createBoardReader(root).load(), warm);
});

test("an empty log cannot seed a memo that bypasses the complete-history proof", async t => {
  const root = await directory(t), file = path.join(root, "board-events.ndjson"), prefix = original();

  await writeFile(file, "");
  const empty = await createBoardReader(root).load();
  assert.ok(empty.ok);
  await writeFile(file, encodeRecord({ sequence: 1, commandId: prefix.first.commandId, command: prefix.first, events: [] }));
  const warm = await createBoardReader(root).load();
  assert.equal(!warm.ok && warm.reason, "snapshot_corrupt");
  boardReplayMemo.forget(root);
  assert.deepEqual(await createBoardReader(root).load(), warm);
  const memo = new BoardReplayMemo();
  memo.remember(root, Buffer.alloc(0), empty.state, 0);
  assert.equal(memo.read(root, Buffer.alloc(0)), undefined);
});
