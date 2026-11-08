import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { createBoardReader, createFileBoardStore, withBoardWriter } from "./file-event-store.js";
import type { BoardWriterAdmissionOptions } from "./writer-admission.js";

const scope = "workspace:board-admission", at = "2026-11-05T05:00:00.000Z";
const reportInput = { scope, issueId: "issue:original-pa-report", problemKey: "original-pa-handoff",
  report: { reportId: "report:original-pa", source: { teamRunId: "team:original", taskId: "task:business", memberId: "member:pa" },
    facts: ["The original source is missing from a dependent handoff."], evidenceRefs: ["evidence:original-handoff"] } };
const reportCommandId = `central-learning:${contentHashOf({ kind: "report", ...reportInput })}`;
const centralFact = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: emptyCentralRuntimeState(scope),
  reason: "original_central_checkpoint", sourceRefs: [] });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function directory(t: TestContext) {
  const parent = testScratchPath("board-writer-admission");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function centralCheckpoint(store: BoardStore) {
  const result = await store.apply({ type: "record_reward_v2_fact", commandId: "central:original-checkpoint", issuedAt: at,
    expectedSequence: 0, fact: centralFact });
  assert.ok(result.ok, JSON.stringify(result));
}

async function assertOriginalRecords(root: string) {
  const loaded = await createBoardReader(root).load();
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.state.rewardV2Facts!.length, 1);
  assert.equal(loaded.state.rewardV2Facts![0]!.payloadJson, centralFact.payloadJson);
  assert.equal(loaded.state.learningIssues!.length, 1);
  assert.deepEqual(loaded.state.learningIssues![0]!.reports, [reportInput.report]);
  assert.equal(loaded.state.appliedCommands.filter(row => row.commandId === reportCommandId).length, 1);
  assert.equal(loaded.state.appliedCommands.length, 2);
}

test("an actual PA report waits for an asynchronous central writer in the same process and commits its original command once", { timeout: 15000 }, async t => {
  const root = await directory(t), entered = deferred(), release = deferred();
  let unlocked = false, succeededBeforeUnlock = false;
  const central = withBoardWriter(root, async store => {
    await centralCheckpoint(store);
    entered.resolve();
    await release.promise;
    return { ok: true };
  });

  await entered.promise;
  const original = createFileCollaborationBoard(root), attempted = deferred(), commandIds: string[] = [];
  const control = createCollaborationControl({ now: () => at, ownerId: "personal-agent:original", board: { ...original,
    apply(command) {
      commandIds.push(command.commandId);
      attempted.resolve();
      return original.apply(command);
    } } });
  const pending = control.report(reportInput).then(result => {
    succeededBeforeUnlock = result.ok && !unlocked;
    return result;
  });

  try {
    await attempted.promise;
    await nextTurn();
  }
  finally {
    unlocked = true;
    release.resolve();
    await central;
  }

  const result = await pending;
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(succeededBeforeUnlock, false);
  assert.deepEqual(commandIds, [reportCommandId]);
  await assertOriginalRecords(root);
});

const boardUrl = new URL("../../learning/agent/subsystems/collaboration/runtime/board-port.js", import.meta.url).href;
const controlUrl = new URL("../../learning/agent/subsystems/collaboration/control/index.js", import.meta.url).href;
const childScript = `
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createFileCollaborationBoard } from ${JSON.stringify(boardUrl)};
import { createCollaborationControl } from ${JSON.stringify(controlUrl)};
const original = createFileCollaborationBoard(process.argv[1]), commands = [];
const board = { ...original, apply(command) { commands.push(command.commandId);return original.apply(command); } };
const control = createCollaborationControl({ board, now: () => ${JSON.stringify(at)}, ownerId: 'personal-agent:child' });
process.send({ kind: 'ready' });
await new Promise(resolve => process.once('message', resolve));
const pending = control.report(${JSON.stringify(reportInput)});
await nextTurn();
process.send({ kind: 'contending' });
const result = await pending;
process.send({ kind: 'result', result, commands });
process.disconnect();
`;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function startReporter(root: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages: Record<string, unknown>[] = [];
  let notify: (() => void) | undefined, diagnostics = "";

  child.stderr!.on("data", value => { diagnostics += String(value); });
  child.on("message", value => {
    if (record(value)) messages.push(value);
    notify?.();
    notify = undefined;
  });
  const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject);
  child.once("exit", code => {
    messages.push({ kind: "exit", code });
    notify?.();
    notify = undefined;
    resolve(code);
  }); });

  return { child, done, async message(kind: string) {
    for (;;) {
      const index = messages.findIndex(value => value.kind === kind);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      if (messages.some(value => value.kind === "exit")) throw new Error(`Reporter exited before ${kind}: ${diagnostics}`);
      await new Promise<void>(resolve => { notify = resolve; });
    }
  } };
}

test("an actual PA report in another Node process waits for the original central lock without replacing its command or records", { timeout: 15000 }, async t => {
  const root = await directory(t), central = createFileBoardStore(root);
  assert.ok("apply" in central, JSON.stringify(central));
  await centralCheckpoint(central);
  const reporter = startReporter(root);
  t.after(() => { if (reporter.child.exitCode === null) reporter.child.kill(); });
  let released = false;

  try {
    await reporter.message("ready");
    reporter.child.send({ kind: "report" });
    // This handshake is sent after a child event-loop turn, so its actual
    // report has encountered the live parent lock before the parent releases it.
    await reporter.message("contending");
    await central.close();
    released = true;
    const value = await reporter.message("result");
    assert.ok(record(value.result));
    assert.equal(value.result.ok, true, JSON.stringify(value.result));
    assert.deepEqual(value.commands, [reportCommandId]);
    assert.equal(await reporter.done, 0);
    await assertOriginalRecords(root);
  } finally { if (!released) await central.close(); }
});

test("writer admission checks abort, collection and its bounded deadline before entering any callback", { timeout: 15000 }, async t => {
  const root = await directory(t), held = createFileBoardStore(root);
  assert.ok("apply" in held);
  let callbacks = 0;
  const attempt = (admission: BoardWriterAdmissionOptions) => withBoardWriter(root, async () => {
    callbacks++;
    return { ok: true };
  }, { admission });
  const reason = (value: Awaited<ReturnType<typeof attempt>>) => "reason" in value ? value.reason : "entered";

  try {
    const stopped = new AbortController();
    stopped.abort();
    assert.equal(reason(await attempt({ signal: stopped.signal })), "learning_aborted");
    assert.equal(reason(await attempt({ canEnter: () => false })), "collect_disabled");
    const abort = new AbortController();
    let abortWaits = 0;

    assert.equal(reason(await attempt({ signal: abort.signal, now: () => 0, random: () => 0,
      async wait(_milliseconds, signal) {
        abortWaits++;
        assert.equal(signal, abort.signal);
        abort.abort();
      } })), "learning_aborted");
    assert.equal(abortWaits, 1);
    let enabled = true, collectionWaits = 0;

    assert.equal(reason(await attempt({ canEnter: () => enabled, now: () => 0, random: () => 0,
      async wait() {
        collectionWaits++;
        enabled = false;
      } })), "collect_disabled");
    assert.equal(collectionWaits, 1);
    let clock = 0;
    const waits: number[] = [];

    assert.equal(reason(await attempt({ timeoutMs: 60, now: () => clock, random: () => 1,
      async wait(milliseconds) {
        waits.push(milliseconds);
        clock += milliseconds;
      } })), "multi_writer");
    assert.deepEqual(waits, [60]);
    assert.equal(callbacks, 0);
  } finally { await held.close(); }
});

test("an entered callback which appended before throwing or returning multi_writer is never replayed", { timeout: 15000 }, async t => {
  const root = await directory(t);
  for (const outcome of ["throw", "multi_writer"] as const) {
    let callbacks = 0;
    const commandId = `entered:${outcome}`;
    const result = await withBoardWriter(root, async store => {
      callbacks++;
      const appended = await store.apply({ type: "coordinate_learning", commandId, issuedAt: at, action: { kind: "report", ...reportInput,
        issueId: `issue:${commandId}`, problemKey: commandId, report: { ...reportInput.report, reportId: `report:${commandId}` } } });
      assert.ok(appended.ok, JSON.stringify(appended));
      if (outcome === "throw") throw new Error("the original callback failed after its durable append");
      return { ok: false as const, reason: "multi_writer" as const, detail: "original callback result after durable append" };
    }, { admission: { timeoutMs: 100, async wait() { assert.fail("An entered callback cannot return to admission"); } } });

    assert.equal(callbacks, 1);
    assert.ok("reason" in result);
    assert.equal(result.reason, outcome === "throw" ? "board_unavailable" : "multi_writer");
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.appliedCommands.filter(row => row.commandId === commandId).length, 1);
    assert.equal(loaded.state.learningIssues!.find(row => row.issueId === `issue:${commandId}`)!.reports.length, 1);
  }
});
