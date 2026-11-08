import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readRuntimeIntent, readRuntimeLocator, runtimeScopePaths } from "./files.js";
import { requestCentralRuntime } from "./transport.js";
import { attachCentralRuntime } from "./client.js";

function writeOwnerEntrypoint(entrypoint: string) {
  const serverUrl = new URL("./server.js", import.meta.url).href, filesUrl = new URL("./files.js", import.meta.url).href;
  writeFileSync(entrypoint, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {serveCentralRuntime} from ${JSON.stringify(serverUrl)};
import {runtimeScopePaths} from ${JSON.stringify(filesUrl)};
const reader=createInterface({input:process.stdin});
reader.once('line',async line=>{reader.close();const input=JSON.parse(line);
appendFileSync(${JSON.stringify(`${entrypoint}.starts`)},JSON.stringify({pid:process.pid,configuration:input.configuration})+'\\n');
const host=await serveCentralRuntime({paths:runtimeScopePaths(input.homeRoot,input.workspaceRoot),configuration:input.configuration,
driver:{async drive({publish}){publish({message:'Background source processed',sourceRefs:['persisted-source:1']});return {state:'waiting'};},
async close(){await new Promise(resolve=>setTimeout(resolve,input.configuration.closeDelayMs??0));}}});
process.stdout.write(JSON.stringify(host.address)+'\\n');
process.once('SIGTERM',()=>void host.close());process.once('SIGINT',()=>void host.close());});`);
}

function delayedFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-process-")), paths = runtimeScopePaths(root, root);
  const entrypoint = path.join(root, "owner.mjs");
  writeOwnerEntrypoint(entrypoint);
  const input = { homeRoot: root, workspaceRoot: root, configuration: { providerId: "reference-only", closeDelayMs: 150 } };
  const launch = { executable: process.execPath, entrypoint, environment: process.env };
  const starts = (): readonly { readonly pid: number; readonly configuration: Readonly<Record<string, unknown>> }[] =>
    existsSync(`${entrypoint}.starts`) ? readFileSync(`${entrypoint}.starts`, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const retired = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = readRuntimeLocator(paths);
      const allExited = starts().every(({ pid }) => { try {
        process.kill(pid, 0);
        return false;
      } catch { return true; } });
      if (found.ok && found.value === undefined && allExited) return;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    assert.fail("original_owner_did_not_retire");
  };
  const cleanup = async () => {
    const found = readRuntimeLocator(paths);
    if (found.ok && found.value !== undefined) await requestCentralRuntime(found.value, { operation: "stop" });
    await retired();
    assert.ok(root.startsWith(path.join(tmpdir(), "trylo-central-process-")));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
  };

  return { paths, input, launch, starts, retired, cleanup };
}

/** Real child lifetimes, no model/provider: the caller exits while one shared owner remains reachable. */
test("two clients attach one detached process and normal caller exit preserves owner and durable intent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-process-"));
  const paths = runtimeScopePaths(root, root), entrypoint = path.join(root, "owner.mjs"), caller = path.join(root, "caller.mjs");
  let ownerPid: number | undefined;

  writeOwnerEntrypoint(entrypoint);
  writeFileSync(caller, `import {attachCentralRuntime} from ${JSON.stringify(new URL("./client.js", import.meta.url).href)};
const input={homeRoot:${JSON.stringify(root)},workspaceRoot:${JSON.stringify(root)},configuration:{providerId:'reference-only'}};
const launch={executable:process.execPath,entrypoint:${JSON.stringify(entrypoint)},environment:process.env};
const clients=await Promise.all([attachCentralRuntime(input,launch),attachCentralRuntime(input,launch)]);
if(clients.some(value=>!value.ok))throw new Error('attachment_failed');
for(const value of clients)value.client.detach();
process.stdout.write(JSON.stringify(clients.map(value=>value.client.ownerId)));`);

  try {
    const child = spawn(process.execPath, [caller], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const result = await new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
      let output = "", error = "";
      const deadline = setTimeout(() => {
        child.kill();
        reject(new Error("caller_retained_background_handle"));
      }, 10000);
      child.stdout.on("data", data => { output += String(data); });
      child.stderr.on("data", data => { error += String(data); });
      child.once("error", reject);
      child.once("exit", code => {
        clearTimeout(deadline);
        resolve({ code, output, error });
      });
    });

    assert.equal(result.code, 0, result.error);
    const owners: unknown = JSON.parse(result.output);
    assert.ok(Array.isArray(owners));
    assert.equal(owners.length, 2);
    assert.equal(owners[0], owners[1]);
    const found = readRuntimeLocator(paths);
    assert.equal(found.ok, true);
    assert.ok(found.ok && found.value);
    ownerPid = found.value.pid;
    const status = await requestCentralRuntime(found.value, { operation: "status" });

    assert.equal(status.ok, true);
    if (!status.ok) return;

    assert.equal(status.snapshot.ownerId, owners[0]);
    assert.equal(status.snapshot.state, "waiting");
    assert.equal(status.snapshot.progress?.sourceRefs[0], "persisted-source:1");
    assert.equal((await requestCentralRuntime(found.value, { operation: "stop" })).ok, true);
  } finally {
    const found = readRuntimeLocator(paths);
    if (found.ok && found.value) {
      ownerPid ??= found.value.pid;
      await requestCentralRuntime(found.value, { operation: "stop" });
    }

    // The response acknowledges stop; wait for that exact owner's lock retirement before removing its sandbox.
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = readRuntimeLocator(paths);
      let exited = ownerPid === undefined;
      if (ownerPid !== undefined) { try { process.kill(ownerPid, 0); } catch { exited = true; } }
      if (found.ok && found.value === undefined && exited) break;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }

    assert.ok(root.startsWith(path.join(tmpdir(), "trylo-central-process-")));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
  }
});

test("one immediate attach waits for a paused process to retire and uses its saved configuration", async () => {
  const f = delayedFixture();
  try {
    const first = await attachCentralRuntime(f.input, f.launch);
    assert.ok(first.ok, JSON.stringify(first));
    const paused = await first.client.pause();
    assert.ok(paused.ok);
    assert.equal(paused.snapshot.state, "stopping");
    const intent = readRuntimeIntent(f.paths);
    assert.ok(intent.ok && intent.value?.enabled === true);
    const attached = await attachCentralRuntime({ ...f.input, configuration: { providerId: "stale-caller", closeDelayMs: 0 } }, f.launch);

    assert.ok(attached.ok, JSON.stringify(attached));
    assert.notEqual(attached.client.ownerId, first.client.ownerId, "a draining owner is never attach-ready");
    assert.ok(attached.initial.ok);
    assert.notEqual(attached.initial.snapshot.state, "stopping");
    assert.equal(f.starts().length, 2, "only the retired owner and its one replacement were launched");
    assert.deepEqual(f.starts()[1]!.configuration, f.input.configuration, "the original persisted configuration wins over a stale caller");
    const wake = await attached.client.wake({ reason: "ordinary_business_attach", sourceRefs: ["original:after-pause"] });
    assert.ok(wake.ok);
    first.client.detach();
    attached.client.detach();
  } finally { await f.cleanup(); }
});

test("explicit stop rejects immediate and retired-process attach without launching another child", async () => {
  const f = delayedFixture();
  try {
    const first = await attachCentralRuntime(f.input, f.launch);
    assert.ok(first.ok, JSON.stringify(first));
    const stopped = await first.client.stop();
    assert.ok(stopped.ok);
    assert.equal(stopped.snapshot.state, "stopping");
    const intent = readRuntimeIntent(f.paths);
    assert.ok(intent.ok && intent.value?.enabled === false);
    assert.deepEqual(await attachCentralRuntime(f.input, f.launch), { ok: false, reason: "runtime_disabled" });
    assert.equal(f.starts().length, 1);
    await f.retired();
    assert.deepEqual(await attachCentralRuntime(f.input, f.launch), { ok: false, reason: "runtime_disabled" });
    assert.equal(f.starts().length, 1, "saved stop authority cannot be turned into a fresh owner");
    first.client.detach();
  } finally { await f.cleanup(); }
});
