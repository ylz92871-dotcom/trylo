import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test, { mock, type TestContext } from "node:test";
import { createHermesNodeClient } from "./client.js";
import { MAX_TOOL_OUTPUT_BYTES } from "../../../../../loop/tool-execution.js";
import { HERMES_VIEW_MAX_BYTES_ENV } from "./view-transport.js";

type Frame = Record<string, unknown>;

const PROFILE = { name: "fixture", command: "fixture", args: [], env: {}, allowedTools: [] };
const opportunity = { trigger: "explicit" as const, mode: "agent" as const };

class FixtureChild extends childProcess.ChildProcess {
  override stdin = new PassThrough(); override stdout = new PassThrough(); override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [this.stdin, this.stdout, this.stderr, undefined, undefined];
  override killed = false;
  frames: Frame[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.frames.push(JSON.parse(chunk.toString())));
  }

  override kill() {
    this.killed = true;
    return true;
  }

  emitFrame(frame: Frame) { this.stdout.write(`${JSON.stringify(frame)}\n`); }
}

function fixtureClient(t: TestContext, nextId?: () => string) {
  const children: FixtureChild[] = [];
  const patched = mock.method(childProcess, "spawn", () => {
    const child = new FixtureChild();
    children.push(child);
    return child;
  });

  syncBuiltinESMExports();
  let id = 0;
  const client = createHermesNodeClient({ nodeBinary: "fixture", env: {}, storageRoot: path.resolve("fixture"),
    nextId: nextId ?? (() => `request-${++id}`) });

  t.after(() => {
    client.close();
    patched.mock.restore();
    syncBuiltinESMExports();
  });

  return { client, children };
}

test("normal and learning profile results receive the same host-owned view byte budget", async t => {
  const { client, children } = fixtureClient(t);
  for (const [index, kind] of (["normal", "learning"] as const).entries()) {
    const pending = client.profile(kind);
    children[0]!.emitFrame({ type: "result", id: `request-${index + 1}`,
      result: { ...PROFILE, env: { HERMES_HOME: "synthetic", [HERMES_VIEW_MAX_BYTES_ENV]: "999999" } } });
    const profile = await pending;
    assert.equal(profile.env[HERMES_VIEW_MAX_BYTES_ENV], String(MAX_TOOL_OUTPUT_BYTES));
    assert.equal(profile.env.HERMES_HOME, "synthetic");
  }
});

test("legacy shadow profile delivery also receives the host view byte budget", async t => {
  const { client, children } = fixtureClient(t);
  let supplied!: () => void;
  const delivered = new Promise<void>(resolve => { supplied = resolve; });
  let budget: string | undefined;
  const pending = client.learn(opportunity, { runShadow: async request => {
    budget = request.profile.env[HERMES_VIEW_MAX_BYTES_ENV];
    supplied();
    return { answer: "fixture" };
  } });

  children[0]!.emitFrame({ type: "shadow", id: "request-1", shadowId: "budget-shadow", prompt: "fixture",
    profile: { ...PROFILE, env: { [HERMES_VIEW_MAX_BYTES_ENV]: "1" } } });
  await delivered;
  assert.equal(budget, String(MAX_TOOL_OUTPUT_BYTES));
  children[0]!.emitFrame({ type: "result", id: "request-1", result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("cancelling one request preserves concurrent work and aborts only its shadow", async t => {
  const { client, children } = fixtureClient(t), cancellation = new AbortController();
  let enter!: () => void, shadowSignal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const first = client.learn(opportunity, { signal: cancellation.signal, runShadow: async (_request, signal) => {
    shadowSignal = signal;
    enter();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  const rejected = assert.rejects(first, /cancelled/);
  const second = client.compatibility("pendingList").then(value => ({ value }), error => ({ error }));
  const child = children[0]!;

  child.emitFrame({ type: "shadow", id: "request-1", shadowId: "shadow-1", prompt: "fixture", profile: PROFILE });
  await entered;
  cancellation.abort();
  await rejected;
  assert.equal(child.killed, false, "request cancellation must not kill the shared worker");
  assert.equal(shadowSignal?.aborted, true);
  assert.ok(child.frames.some(frame => frame.type === "cancel" && frame.id === "request-1"));
  child.emitFrame({ type: "result", id: "request-2", result: { ok: true } });
  assert.deepEqual(await second, { value: { ok: true } });
});

test("a timed-out native write reports unknown and preserves another pending request", async t => {
  const { client, children } = fixtureClient(t);
  const writing = client.compatibility("pendingApply", { id: "synthetic" }, { timeoutMs: 5 });
  const rejected = assert.rejects(writing, /hermes_compat_timeout_unknown/);
  const reading = client.compatibility("pendingList").then(value => ({ value }), error => ({ error }));

  await rejected;
  assert.equal(children[0]!.killed, false);
  children[0]!.emitFrame({ type: "result", id: "request-2", result: { ok: true } });
  assert.deepEqual(await reading, { value: { ok: true } });
});

test("old process output and a late shadow completion cannot touch a restarted worker", async t => {
  const { client, children } = fixtureClient(t, () => "reused-id");
  let finishShadow!: (value: { answer: string }) => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const first = client.learn(opportunity, { runShadow: async () => {
    enter();
    return new Promise(resolve => { finishShadow = resolve; });
  } });
  const rejected = assert.rejects(first, /hermes_worker_closed/);

  children[0]!.emitFrame({ type: "shadow", id: "reused-id", shadowId: "old-shadow", prompt: "fixture", profile: PROFILE });
  await entered;
  client.close();
  await rejected;
  const second = client.compatibility("pendingList").then(value => ({ value }), error => ({ error }));
  const restarted = children[1]!;

  children[0]!.stdout.write("x".repeat(1_048_577));
  finishShadow({ answer: "late" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(restarted.killed, false, "old stdout must not trip the new process limit");
  assert.equal(restarted.frames.some(frame => frame.shadowId === "old-shadow"), false);
  restarted.emitFrame({ type: "result", id: "reused-id", result: { ok: true } });
  assert.deepEqual(await second, { value: { ok: true } });
});

// This protocol fixture copies only the real worker. Its tiny local dependency
// stubs expose cancellation/finally timing; no native assets or models run.
async function fixtureWorker(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-worker-cancel-"));
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}',
    "host/worker.mjs": await readFile(new URL("./worker.mjs", import.meta.url), "utf8"),
    "compat/index.mjs": 'export const createFileMemento=()=>({}); export const createHermesSkillCompatibility=()=>({pendingList:async()=>({ok:true})});',
    "vendor/legacy/package.json": '{"type":"commonjs"}',
    "vendor/legacy/hermes-python-resolver.js": 'exports.resolveHermesPython=()=>process.execPath;',
    "vendor/legacy/hermes-capability-manager.js": 'exports.SERVER_NAME="fixture"; exports.LEARNING_SERVER_NAME="fixture"; exports.LEARNING_ALLOWED_TOOLS=[]; exports.getServerScriptPath=()=>"fixture"; exports.ensureDataDir=root=>root;',
    "vendor/legacy/learning-loop/orchestrator.js": `
      const emit=body=>process.stdout.write(JSON.stringify(body)+"\\n");
      exports.runExplicitLearn=async p=>{try{
        emit({type:"fixture_started",id:p.turnId});
        if(p.taskGoal==="before")await new Promise(resolve=>setTimeout(resolve,50));
        return await p.runInShadow("fixture");
      }catch(error){return {error:error.message};}
      finally{emit({type:"fixture_finally",id:p.turnId});}};
    `,
  };

  for (const [name, body] of Object.entries(files)) {
    const filename = path.join(root, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, body);
  }

  const child = childProcess.spawn(process.execPath, [path.join(root, "host", "worker.mjs")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const frames: Frame[] = [], waiters = new Set<() => void>();
  const reader = createInterface({ input: child.stdout });

  reader.on("line", line => {
    frames.push(JSON.parse(line));
    for (const notify of waiters) notify();
  });
  t.after(async () => {
    child.kill();
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    reader.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = (frame: Frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const wait = (predicate: (frame: Frame) => boolean) => new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error("fixture protocol timeout"));
    }, 1500);
    function check() {
      const found = frames.find(predicate);
      if (found) {
      clearTimeout(timer);
      waiters.delete(check);
      resolve(found);
    }
    }
    waiters.add(check);
    check();
  });

  return { root, frames, send, wait };
}

for (const point of ["before", "waiting"] as const) test(`worker cancellation ${point} shadow preserves the original finally and other requests`, async t => {
  const worker = await fixtureWorker(t);

  worker.send({ type: "request", id: "learn", operation: "learn", storageRoot: worker.root,
    opportunity: { ...opportunity, turnId: "learn", taskGoal: point } });
  await worker.wait(frame => frame.type === (point === "before" ? "fixture_started" : "shadow") && frame.id === "learn");
  worker.send({ type: "cancel", id: "learn" });
  await worker.wait(frame => frame.type === "fixture_finally" && frame.id === "learn");

  if (point === "before") assert.equal(worker.frames.some(frame => frame.type === "shadow"), false);

  worker.send({ type: "request", id: "read", operation: "compat", method: "pendingList", storageRoot: worker.root });
  assert.deepEqual((await worker.wait(frame => frame.type === "result" && frame.id === "read")).result, { ok: true });
});
