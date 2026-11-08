import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "./file-event-store.js";
import { repairBoardTornTail } from "./torn-tail-repair.js";

const storeUrl = new URL("./file-event-store.js", import.meta.url).href;
const fixtureUrl = new URL("../../learning/control/fixtures.js", import.meta.url).href;
const repairUrl = new URL("./torn-tail-repair.js", import.meta.url).href;
const childScript = `
import { createFileBoardStore } from ${JSON.stringify(storeUrl)};
import { command, userRuleDraft } from ${JSON.stringify(fixtureUrl)};
import { repairBoardTornTail } from ${JSON.stringify(repairUrl)};
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
const [mode, directory, stage, identity] = process.argv.slice(1);
const emit = value => writeSync(1, value + '\\n');
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
const options = {lockOptions:{onStage(current){
  if(mode === 'recoverer' && current === stage){ emit('STAGE:' + current); pause(); }
}}};
async function writer(){
  const store = createFileBoardStore(directory, options);
  if(!('apply' in store)) throw new Error(JSON.stringify(store));
  const applied = await store.apply(command('submit_proposal',{proposal:userRuleDraft({proposalId:'persisted-owner'}),commandId:'persisted-command'}));
  if(!applied.ok) throw new Error(JSON.stringify(applied));
  emit('LOCKED'); pause();
}
async function contender(){
  emit('READY');
  await new Promise(resolve => process.stdin.once('data', resolve));
  for(let attempt=0;attempt<300;attempt++){
    const store=createFileBoardStore(directory);
    if(!('apply' in store)){
      if(store.reason!=='multi_writer') throw new Error(JSON.stringify(store));
      await new Promise(resolve=>setTimeout(resolve, 5));continue;
    }
    const sentinel=path.join(directory,'independent-critical-section');
    const fd=openSync(sentinel,'wx');
    try{
      const applied=await store.apply(command('submit_proposal',{proposal:userRuleDraft({proposalId:'contender-'+identity}),commandId:'contender-command-'+identity}));
      if(!applied.ok) throw new Error(JSON.stringify(applied));
      await new Promise(resolve=>setTimeout(resolve, 15));
    }finally{closeSync(fd);unlinkSync(sentinel);await store.close();}
    emit('DONE:'+identity);return;
  }
  throw new Error('bounded contention retry exhausted');
}
if(mode==='writer') await writer();
else if(mode==='contender') await contender();
else if(mode==='repairer') { await repairBoardTornTail(directory,{onStage(current){if(current===stage){emit('STAGE:'+current);pause();}}});throw new Error('repair kill stage was not reached'); }
else { const store=createFileBoardStore(directory,options); if('apply' in store) await store.close(); throw new Error('expected kill stage was not reached:'+JSON.stringify(store)); }
`;

type Running = { readonly child: ChildProcessWithoutNullStreams; readonly output: () => string; readonly done: Promise<number | null> };

function directory(label: string): string {
  const parent = testScratchPath("board-lock-process-evidence");
  mkdirSync(parent, { recursive: true });
  const result = mkdtempSync(path.join(parent, `${label}-`));
  console.log(`board_lock_evidence=${result}`);
  return result;
}

function start(mode: string, root: string, stage = "", identity = ""): Running {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, mode, root, stage, identity], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";

  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  return { child, output: () => output, done };
}

async function waitFor(running: Running, marker: string): Promise<void> {
  if (running.output().includes(marker)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`child marker timeout ${marker}: ${running.output()}`)), 20_000);
    const check = () => { if (running.output().includes(marker)) finish(); };
    const exited = () => finish(new Error(`child exited before ${marker}: ${running.output()}`));

    function finish(error?: Error): void {
      clearTimeout(timeout);
      running.child.stdout.off("data", check);
      running.child.stderr.off("data", check);
      running.child.off("exit", exited);
      if (error !== undefined) reject(error); else resolve();
    }

    running.child.stdout.on("data", check);
    running.child.stderr.on("data", check);
    running.child.once("exit", exited);
    check();
  });
}

async function kill(running: Running, root: string, label: string): Promise<void> {
  running.child.kill("SIGKILL");
  await running.done;
  writeFileSync(path.join(root, `${label}-child.log`), running.output());
}

async function deadWriter(root: string): Promise<void> {
  const child = start("writer", root);
  try {
    await waitFor(child, "LOCKED");
    const next = createFileBoardStore(root);
    assert.equal(!("apply" in next) && next.reason, "multi_writer");
  } finally {
    await kill(child, root, "dead-writer");
  }
}

async function assertRecovered(root: string): Promise<void> {
  const reopened = createFileBoardStore(root);

  assert.equal("apply" in reopened, true, JSON.stringify(reopened));

  if (!("apply" in reopened)) return;

  try {
    const loaded = await reopened.load();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.state.proposals.filter(proposal => proposal.proposalId === "persisted-owner").length, 1);
  } finally {
    await reopened.close();
  }
}

test("real hard-killed Board writer is recovered without losing committed commands", { timeout: 60_000 }, async () => {
  const root = directory("writer-kill");
  await deadWriter(root);
  assert.equal(readFileSync(path.join(root, "board-writer.lock"), "utf8").includes('"formatVersion":1'), true);
  await assertRecovered(root);
  assert.equal(existsSync(path.join(root, "board-writer.lock")), false);
});

test("real recoverer killed with its intent or after stale unlink does not strand a guard", { timeout: 120_000 }, async () => {
  for (const stage of ["recovery_intent_published", "stale_lock_removed"]) {
    const root = directory(stage);

    await deadWriter(root);
    const recoverer = start("recoverer", root, stage);

    try {
      await waitFor(recoverer, `STAGE:${stage}`);
      const blocked = createFileBoardStore(root);
      assert.equal(!("apply" in blocked) && blocked.reason, "multi_writer");
      assert.equal(readdirSync(root).some(file => file.startsWith("board-writer.lock.intent-")), true);
    } finally {
      await kill(recoverer, root, "dead-recoverer");
    }

    await assertRecovered(root);
    assert.equal(readdirSync(root).some(file => file.startsWith("board-writer.lock.intent-")), false);
  }
});

test("four independent recovery processes serialize actual Board appends", { timeout: 120_000 }, async () => {
  const root = directory("four-recoverers");

  await deadWriter(root);
  const children = Array.from({ length: 4 }, (_, index) => start("contender", root, "", String(index)));

  try {
    await Promise.all(children.map(child => waitFor(child, "READY")));

    for (const child of children) child.child.stdin.end("GO\n");

    const codes = await Promise.all(children.map(child => child.done));

    children.forEach((child, index) => writeFileSync(path.join(root, `contender-${index}.log`), child.output()));
    assert.deepEqual(codes, [0, 0, 0, 0], children.map(child => child.output()).join("\n"));
    const store = createFileBoardStore(root);

    assert.equal("apply" in store, true);

    if (!("apply" in store)) return;

    try {
      const loaded = await store.load();
      assert.equal(loaded.ok, true);
      if (loaded.ok) assert.deepEqual(loaded.state.proposals.map(proposal => proposal.proposalId).sort(), ["contender-0", "contender-1", "contender-2", "contender-3", "persisted-owner"]);
    } finally { await store.close(); }
  } finally {
    for (const child of children) if (child.child.exitCode === null && child.child.signalCode === null) await kill(child, root, "unfinished-contender");
  }
});

test("real repairer killed after quarantine or truncation preserves evidence and restart recovery", { timeout: 120_000 }, async () => {
  for (const stage of ["evidence_saved", "after_truncate"]) {
    const root = directory(`repair-${stage}`);

    await deadWriter(root);
    const log = path.join(root, "board-events.ndjson");
    const prefix = readFileSync(log);

    appendFileSync(log, 'partial {"unknown":"must preserve"');
    const original = readFileSync(log);
    const repairer = start("repairer", root, stage);

    try {
      await waitFor(repairer, `STAGE:${stage}`);
      const bundle = readdirSync(path.join(root, "quarantine"))[0]!;
      assert.equal(readFileSync(path.join(root, "quarantine", bundle, "original.ndjson")).equals(original), true);
      assert.equal(readFileSync(log).equals(stage === "after_truncate" ? prefix : original), true);
    } finally { await kill(repairer, root, "dead-repairer"); }

    const recovered = await repairBoardTornTail(root);

    assert.equal(recovered.ok && recovered.status, stage === "after_truncate" ? "not_needed" : "repaired");
    assert.equal(readFileSync(log).equals(prefix), true);
    await assertRecovered(root);
  }
});
