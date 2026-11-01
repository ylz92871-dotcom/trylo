import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dispatchToolLearningWorker } from "./background-worker.js";

test("detached trusted worker outlives its foreground parent without retaining parent pipes", async t => {
  const base = path.resolve("Temp/tool-background-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  let workerPid: number | undefined;
  t.after(async () => {
    // Publishing the receipt precedes process exit; Windows still owns its cwd until then.
    if (workerPid !== undefined) await waitForProcessExit(workerPid);
    await rm(root, { recursive: true, force: true });
  });
  const child = path.join(root, "child.mjs"), parent = path.join(root, "parent.mjs"), receipt = path.join(root, "receipt.txt");
  await writeFile(child, 'import{writeFileSync}from"node:fs";setTimeout(()=>writeFileSync(process.argv[2],"worker_finished"),2000);');
  await writeFile(parent, `import{dispatchToolLearningWorker}from ${JSON.stringify(new URL("./background-worker.js", import.meta.url).href)};
const result=await dispatchToolLearningWorker({nodeExecutable:process.execPath,entrypoint:${JSON.stringify(child)},cwd:${JSON.stringify(root)},env:process.env,args:[${JSON.stringify(receipt)}]});
console.log(JSON.stringify(result));`);
  const completed = await promisify(execFile)(process.execPath, [parent], { windowsHide: true, timeout: 10_000 });
  const result: unknown = JSON.parse(completed.stdout); assert.ok(typeof result === "object" && result !== null && "ok" in result && result.ok === true);
  assert.ok("pid" in result && typeof result.pid === "number" && Number.isSafeInteger(result.pid)); workerPid = result.pid;
  let alreadyFinished = true;
  try { await access(receipt); } catch { alreadyFinished = false; }
  assert.equal(alreadyFinished, false, "foreground must exit while the independent worker still runs");
  for (let i = 0; i < 100; i++) {
    try { assert.equal(await readFile(receipt, "utf8"), "worker_finished"); return; }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("the independently owned worker did not finish its artifact");
});

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("the owned worker did not release its process before fixture cleanup");
}

test("relative execution paths and an unavailable runtime fail before claiming a worker started", async () => {
  assert.deepEqual(await dispatchToolLearningWorker({ nodeExecutable: "node", entrypoint: "main.js", cwd: "workspace", env: {}, args: [] }),
    { ok: false, code: "worker_paths_not_absolute" });
  const result = await dispatchToolLearningWorker({ nodeExecutable: path.resolve("Temp/nonexistent-tool-worker-runtime.exe"),
    entrypoint: path.resolve("Temp/main.js"), cwd: path.resolve("Temp"), env: {}, args: [] });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "worker_spawn_failed");
});
