import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { RecordRewardV2FactCommand } from "../../learning/control/commands.js";
import type { BoardState } from "../../learning/control/state.js";
import type { FileBoardStoreOptions } from "./file-event-store.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { command, userRuleDraft } from "../../learning/control/fixtures.js";
import { methodPayloadHash } from "../../learning/control/method-replay.js";
import { boardReplayMemo } from "./replay-memo.js";

// The baseline uses the original adapter, rather than failing because a new
// checkpoint module does not exist in that immutable prefix.
const baseline = process.env.TRYLO_CHECKPOINT_BASELINE_PREFIX;
const adapterUrl = baseline === undefined ? new URL("./file-event-store.js", import.meta.url).href
  : pathToFileURL(path.resolve(baseline, "internal/adapters/learning-store/file-event-store.js")).href;
const adapter = await import(adapterUrl) as typeof import("./file-event-store.js");
const LOG = "board-events.ndjson", CHECKPOINT = "board-replay-checkpoint.json", SNAPSHOT = "board-snapshot.json";
const policy = { minimumBytes: 1024 * 1024, minimumRecords: 2 };

interface ReplayReport {
  readonly mode: "cold" | "memo_exact" | "memo_suffix" | "checkpoint";
  readonly decodedRecords: number; readonly reducedRecords: number; readonly prefixBytes: number;
  readonly suffixBytes: number; readonly physicalSequence: number;
}

interface Checkpoint {
  readonly schemaVersion: number; readonly replayVersion: string;
  readonly prefix: { readonly byteLength: number; readonly sha256: string; readonly physicalSequence: number; readonly logicalSequence: number };
  readonly baseSnapshot: { readonly sha256: string; readonly generation: number } | null;
  readonly state: BoardState; readonly checksum: string;
}

async function directory(t: TestContext): Promise<string> {
  const parent = testScratchPath("board-replay-checkpoint");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  t.after(async () => {
    boardReplayMemo.forget(root);
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function open(root: string, options: FileBoardStoreOptions = {}): BoardStore {
  const store = adapter.createFileBoardStore(root, { checkpointPolicy: policy, ...options });
  assert.ok("apply" in store, "the isolated ordinary Board writer must open");
  if (!("apply" in store)) throw new Error("checkpoint fixture writer unavailable");
  return store;
}

function fact(label: string, value: number): RecordRewardV2FactCommand {
  return { type: "record_reward_v2_fact", commandId: `command:${label}:${value}`, issuedAt: "2026-11-05T00:00:00.000Z",
    expectedSequence: value - 1, fact: { id: `fact:${label}:${value}`, scope: "workspace:checkpoint-contract", kind: "projection",
      algorithmVersion: "checkpoint-contract-v1", payloadJson: canonicalJson({ label, value }) } };
}

async function apply(store: BoardStore, value: Parameters<BoardStore["apply"]>[0]) {
  const result = await store.apply(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("ordinary checkpoint fixture command rejected");
  return result;
}

async function seed(t: TestContext, label = "a", count: 2 | 3 = 3, tailLabel = label) {
  const root = await directory(t), writer = open(root);
  try {
    const one = await apply(writer, fact(label, 1)), two = await apply(writer, fact(label, 2));

    // This is the first baseline assertion: no explicit snapshot/checkpoint call.
    assert.ok(existsSync(path.join(root, CHECKPOINT)), "ordinary_writer_auto_checkpoint_missing");
    const prefix = await readFile(path.join(root, LOG)), checkpointText = await readFile(path.join(root, CHECKPOINT), "utf8");
    const checkpoint = JSON.parse(checkpointText) as Checkpoint;

    assert.equal(checkpoint.schemaVersion, 1);
    assert.equal(checkpoint.replayVersion, "trylo-board-replay-2026-11-05-v1");
    assert.equal(checkpoint.prefix.byteLength, prefix.length);
    assert.equal(checkpoint.prefix.physicalSequence, 2);
    assert.equal(checkpoint.prefix.logicalSequence, two.state.sequence);
    assert.equal(checkpoint.prefix.sha256, sha256Hex(prefix.toString("utf8")));
    assert.equal(checkpoint.baseSnapshot, null);
    assert.deepEqual(checkpoint.state, two.state);
    const last = count === 3 ? await apply(writer, fact(tailLabel, 3)) : two;

    assert.equal(await readFile(path.join(root, CHECKPOINT), "utf8"), checkpointText,
      "a one-record suffix does not reach the next automatic checkpoint boundary");

    return { root, one, two, last, prefix, checkpoint, checkpointText, raw: await readFile(path.join(root, LOG)) };
  } finally { await writer.close(); }
}

async function readCold(root: string) {
  boardReplayMemo.forget(root);
  const reports: ReplayReport[] = [];
  const result = await adapter.createBoardReader(root, { observeReplay: report => reports.push(report) }).load();
  return { result, reports };
}

function reseal(value: Record<string, unknown>): string {
  const body = { ...value };
  delete body.checksum;
  return canonicalJson({ ...body, checksum: sha256Hex(canonicalJson(body)) });
}

const childScript = `
const adapter = await import(process.argv[1]);
const { contentHashOf } = await import(process.argv[3]);
const reports = [];
const loaded = await adapter.createBoardReader(process.argv[2], { observeReplay(report) { reports.push(report); } }).load();
process.stdout.write(JSON.stringify(loaded.ok ? { ok: true, stateHash: contentHashOf(loaded.state), reports }
  : { ok: false, reason: loaded.reason, reports }));
if (!loaded.ok) process.exitCode = 1;
`;

async function restartedReader(t: TestContext, root: string): Promise<{ readonly ok: boolean; readonly stateHash: string; readonly reports: readonly ReplayReport[] }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, adapterUrl, root,
    new URL("../../learning/control/hash.js", import.meta.url).href], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });

  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "", diagnostics = "";

  child.stdout!.on("data", value => { output += String(value); });
  child.stderr!.on("data", value => { diagnostics += String(value); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0, diagnostics || output);
  return JSON.parse(output) as Awaited<ReturnType<typeof restartedReader>>;
}

test("ordinary writes create a checkpoint and a fresh Node reader decodes and reduces only the original suffix", { timeout: 15000 }, async t => {
  const original = await seed(t);
  const restarted = await restartedReader(t, original.root);
  assert.equal(restarted.ok, true);
  assert.equal(restarted.stateHash, contentHashOf(original.last.state));
  assert.equal(restarted.reports.length, 1);
  assert.deepEqual(restarted.reports[0], { mode: "checkpoint", decodedRecords: 1, reducedRecords: 1,
    prefixBytes: original.prefix.length, suffixBytes: original.raw.length - original.prefix.length, physicalSequence: 3 });
  assert.equal((await readFile(path.join(original.root, LOG))).equals(original.raw), true, "reader reuse never truncates or rewrites authority");
});

test("unproven, replaced, truncated or torn checkpoint prefixes retain the original cold authority contracts", async t => {
  const original = await seed(t), replacement = await seed(t, "b", 3, "a");

  assert.equal(replacement.prefix.length, original.prefix.length, "a same-length valid replacement still changes its meaning and prefix hash");
  const log = path.join(original.root, LOG), checkpoint = path.join(original.root, CHECKPOINT);

  await writeFile(log, replacement.raw);
  let loaded = await readCold(original.root);
  assert.equal(loaded.result.ok, true);

  if (loaded.result.ok) assert.deepEqual(loaded.result.state, replacement.last.state);

  assert.equal(loaded.reports.at(-1)?.mode, "cold");
  await writeFile(log, original.raw.subarray(0, original.raw.indexOf(10) + 1));
  loaded = await readCold(original.root);
  assert.equal(loaded.result.ok, true);

  if (loaded.result.ok) assert.deepEqual(loaded.result.state, original.one.state);

  assert.equal(loaded.reports.at(-1)?.mode, "cold");
  const damaged = Buffer.from(original.raw);
  damaged[0] = damaged[0] === 97 ? 98 : 97;
  await writeFile(log, damaged);
  loaded = await readCold(original.root);
  assert.equal(!loaded.result.ok && loaded.result.reason, "checksum_mismatch", "an invalid complete authority line cannot borrow the old checkpoint state");
  await writeFile(log, original.raw);
  const incomplete = { ...original.checkpoint } as Record<string, unknown>;
  delete incomplete.prefix;

  for (const invalid of [incomplete, { ...original.checkpoint, replayVersion: "old-replay-format" },
    { ...original.checkpoint, prefix: { ...original.checkpoint.prefix, sha256: "0".repeat(64) } }]) {
    await writeFile(checkpoint, reseal(invalid));
    loaded = await readCold(original.root);
    assert.equal(loaded.result.ok, true);
    if (loaded.result.ok) assert.deepEqual(loaded.result.state, original.last.state);
    assert.equal(loaded.reports.at(-1)?.mode, "cold");
  }

  const torn = Buffer.concat([original.prefix, Buffer.from("incomplete {")]);

  await writeFile(log, torn);
  await writeFile(checkpoint, original.checkpointText);
  loaded = await readCold(original.root);
  assert.equal(loaded.result.ok, true);

  if (loaded.result.ok) assert.deepEqual(loaded.result.state, original.two.state);

  assert.equal(loaded.reports.at(-1)?.mode, "cold");
  const writer = open(original.root);

  try {
    const blocked = await writer.apply(fact("a", 3));
    assert.equal(!blocked.ok && blocked.reason, "torn_write");
  }
  finally { await writer.close(); }

  assert.equal((await readFile(log)).equals(torn), true);
  assert.equal(await readFile(checkpoint, "utf8"), original.checkpointText);
});

test("legacy snapshot binding and physical sequence reset after compact cannot revive a stale checkpoint", async t => {
  const original = await seed(t, "a", 2), writer = open(original.root);

  try {
    const snapped = await writer.snapshot(0);
    assert.equal(snapped.ok, true);
    const oldSnapshot = JSON.parse(await readFile(path.join(original.root, SNAPSHOT), "utf8")) as Record<string, unknown>;

    assert.equal(Object.hasOwn(oldSnapshot, "replayVersion"), false);
    assert.equal(oldSnapshot.generation, 1);
    const appended = await apply(writer, fact("a", 3));

    await writeFile(path.join(original.root, CHECKPOINT), original.checkpointText);
    const loaded = await readCold(original.root);
    assert.equal(loaded.result.ok, true);

    if (loaded.result.ok) assert.deepEqual(loaded.result.state, appended.state);

    assert.equal(loaded.reports.at(-1)?.mode, "cold", "a changed legacy snapshot invalidates the old baseSnapshot proof");
  } finally { await writer.close(); }

  const root = await directory(t), legacy = open(root);

  try {
    await apply(legacy, command("submit_proposal", { commandId: "legacy:submit", proposal: userRuleDraft({ proposalId: "legacy:proposal" }) }));
    await apply(legacy, command("fast_lane_validate", { commandId: "legacy:validate", proposalId: "legacy:proposal" }));
    assert.equal(existsSync(path.join(root, CHECKPOINT)), false, "pure legacy proposal/asset history gets no automatic checkpoint IO even at the small policy boundary");
    const compacted = await legacy.compact(0);
    assert.equal(compacted.ok, true);
    assert.equal((await readFile(path.join(root, LOG))).length, 0);
    const appended = await apply(legacy, command("commit_asset", { commandId: "legacy:commit", proposalId: "legacy:proposal",
      versionId: "legacy:version", schemaVersion: 1, content: { text: "original legacy rule" } }));
    const loaded = await readCold(root);
    assert.equal(loaded.result.ok, true);

    if (loaded.result.ok) assert.deepEqual(loaded.result.state, appended.state);

    assert.equal(loaded.reports.at(-1)?.physicalSequence, 1);
    const snapshot = await readFile(path.join(root, SNAPSHOT));
    await rm(path.join(root, SNAPSHOT));
    let missing = await readCold(root);
    assert.equal(!missing.result.ok && missing.result.reason, "snapshot_corrupt");
    await writeFile(path.join(root, SNAPSHOT), "invalid legacy snapshot");
    missing = await readCold(root);
    assert.equal(!missing.result.ok && missing.result.reason, "snapshot_corrupt");
    await writeFile(path.join(root, SNAPSHOT), snapshot);
  } finally { await legacy.close(); }
});

test("unknown append stays unknown while checkpoint-cache IO cannot undo a confirmed ordinary append", async t => {
  const original = await seed(t, "a", 2);
  let appends = 0;
  const unknown = await adapter.withBoardWriter(original.root, store => store.apply(fact("a", 3)), {
    checkpointPolicy: policy, logAppender(file, body, encoding) {
      appends++;
      appendFileSync(file, body, encoding);
      throw new Error("original append acknowledgement unknown");
    },
  });

  assert.equal(typeof unknown === "object" && unknown !== null && "ok" in unknown && !unknown.ok && unknown.reason, "board_unavailable");
  assert.equal(appends, 1);
  assert.equal(await readFile(path.join(original.root, CHECKPOINT), "utf8"), original.checkpointText);
  const recovered = await readCold(original.root);
  assert.equal(recovered.result.ok, true);

  if (recovered.result.ok) {
    assert.equal(recovered.result.state.sequence, 3);
    assert.equal(recovered.result.state.rewardV2Facts?.length, 3);
  }

  assert.equal(recovered.reports.at(-1)?.mode, "checkpoint");
  assert.equal(recovered.reports.at(-1)?.reducedRecords, 1);
  const logBeforeRetry = await readFile(path.join(original.root, LOG)), retry = open(original.root);

  try { assert.equal((await apply(retry, fact("a", 3))).idempotent, true); } finally { await retry.close(); }

  assert.equal((await readFile(path.join(original.root, LOG))).equals(logBeforeRetry), true);

  const root = await directory(t), writer = open(root);

  try {
    await apply(writer, fact("a", 1));
    await mkdir(path.join(root, CHECKPOINT));
    const confirmed = await apply(writer, fact("a", 2));
    assert.equal(confirmed.state.sequence, 2);
    assert.equal((await stat(path.join(root, CHECKPOINT))).isDirectory(), true, "a failed cache rename preserves the pre-existing target directory");
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith(`${CHECKPOINT}.tmp-`)), [], "failed cache publication leaves no owned temporary file");
    const loaded = await readCold(root);
    assert.equal(loaded.result.ok, true);
    if (loaded.result.ok) assert.deepEqual(loaded.result.state, confirmed.state);
  } finally { await writer.close(); }

  const cancelledRoot = await directory(t);
  let enabled = true, sawTemporary = false;
  const cancelledWriter = open(cancelledRoot, { commandGuard() {
    if (readdirSync(cancelledRoot).some(name => name.startsWith(`${CHECKPOINT}.tmp-`))) {
      sawTemporary = true;
      enabled = false;
    }
    return enabled;
  } });

  try {
    await apply(cancelledWriter, fact("a", 1));
    const confirmed = await apply(cancelledWriter, fact("a", 2));
    assert.equal(confirmed.state.sequence, 2);
    assert.equal(sawTemporary, true);
    assert.equal(enabled, false);
    assert.equal(existsSync(path.join(cancelledRoot, CHECKPOINT)), false, "collection cancellation prevents cache publication after its temporary file was created");
    assert.deepEqual(readdirSync(cancelledRoot).filter(name => name.startsWith(`${CHECKPOINT}.tmp-`)), [], "cancelled cache publication cleans its own temporary file");
    const before = await readFile(path.join(cancelledRoot, LOG)), blocked = await cancelledWriter.apply(fact("a", 3));

    assert.equal(!blocked.ok && blocked.reason, "collect_disabled");
    assert.equal((await readFile(path.join(cancelledRoot, LOG))).equals(before), true, "the next actual append remains stopped by the original command guard");
  } finally { await cancelledWriter.close(); }
});

test("legacy missing method command identities recover only from retained original authority", async t => {
  const root = await directory(t), writer = open(root), original = fact("a", 1);
  try {
    await apply(writer, original);
    assert.equal((await writer.snapshot(0)).ok, true);
    const snapshotFile = path.join(root, SNAPSHOT);
    const removeSavedIdentity = async () => {
      const snapshot = JSON.parse(await readFile(snapshotFile, "utf8")) as { readonly state: BoardState } & Record<string, unknown>;
      const state = { ...snapshot.state, appliedCommands: snapshot.state.appliedCommands.map(({ payloadHash: _hash, ...item }) => item) };
      await writeFile(snapshotFile, reseal({ ...snapshot, state }));
      await rm(path.join(root, CHECKPOINT), { force: true });
      boardReplayMemo.forget(root);
    };

    await removeSavedIdentity();
    const restored = await readCold(root);
    assert.equal(restored.result.ok, true);

    if (restored.result.ok) assert.equal(restored.result.state.appliedCommands[0]?.payloadHash, methodPayloadHash(original));

    const raw = await readFile(path.join(root, LOG));
    assert.equal((await apply(writer, original)).idempotent, true);
    assert.equal((await readFile(path.join(root, LOG))).equals(raw), true);
    const compacted = await writer.compact(1);
    assert.equal(compacted.ok, true);
    assert.equal((await readFile(path.join(root, LOG))).length, 0);
    await removeSavedIdentity();
    const refused = await writer.apply(original);
    assert.equal(!refused.ok && refused.reason, "command_identity_unavailable");
  } finally { await writer.close(); }
});
