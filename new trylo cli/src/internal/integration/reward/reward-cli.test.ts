import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { methodBoardRoot } from "../../surface/cli/learning-sink.js";

const cli = fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url));
const reader = new URL("../../adapters/learning-store/file-event-store.js", import.meta.url).href;

async function run(workspace: string, home: string, endpoint: string, learning: string, experimental: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.TRYLO_REWARD_TEST_CLI ?? cli, "run", "read sample.txt once then finish",
      ...(learning === "off" ? [] : [`--learning=${learning}`]), "--provider", "openai-compatible", "--endpoint", endpoint,
      "--model", "reward-test-model", "--format", "stream-json"], {
      cwd: workspace, env: { ...process.env, TRYLO_HOME: home, TRYLO_API_KEY: "fixture-local-only",
        TRYLO_REWARD_FEEDBACK: experimental, TRYLO_REWARD_RUNTIME_REVISION: "test-runtime-hash-v1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("reward CLI timed out")); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 262144) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 262144) child.kill(); });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", status => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
}

/** Scripted remote side; production argv, HTTP adapter, tool, host, Board and separate-process restore. */
test("reward CLI: real process chain records one tool result, restores it, and both OFF switches collect zero", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reward-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, ".trylo"), { recursive: true });
  await writeFile(path.join(workspace, "sample.txt"), "reward fixture\n");
  await writeFile(path.join(workspace, ".trylo", "config.json"), JSON.stringify({ contextTokenLimit: 100000, maxIterations: 3 }));
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      requests++;
      const parsed = JSON.parse(body) as { messages: { role: string }[] };
      const complete = parsed.messages.some(message => message.role === "tool");
      const delta = complete ? { content: "Finished reading." } : { tool_calls: [{ index: 0, id: "call-read",
        type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "sample.txt" }) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: complete ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  for (const [mode, flag, expected] of [["method", "1", 1], ["off", "1", 0], ["method", "0", 0]] as const) {
    const home = path.join(root, `home-${mode}-${flag}`);
    const result = await run(workspace, home, endpoint, mode, flag);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("tool_result"), "must actually execute the tool");
    assert.ok(!result.stderr.includes("reward_degraded"), result.stderr);
    const rootDir = methodBoardRoot(home, { TRYLO_HOME: home });
    const restored = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const {createBoardReader}=await import(process.env.REWARD_READER); const result=await createBoardReader(process.env.REWARD_ROOT).load(); process.stdout.write(JSON.stringify(result.ok?{ok:true,uses:result.state.rewardExposures??[],feedbacks:result.state.rewardFeedbacks??[]}:result));"],
      { env: { ...process.env, REWARD_READER: reader, REWARD_ROOT: rootDir }, encoding: "utf8", timeout: 10_000 });
    assert.equal(restored.status, 0, restored.stderr);
    const saved = JSON.parse(restored.stdout) as { ok: boolean; uses: unknown[]; feedbacks: { origin: string; outcome: { kind: string; value: number } }[] };
    assert.ok(saved.ok);
    assert.equal(saved.uses.length, expected);
    assert.equal(saved.feedbacks.length, expected);
    if (expected === 1) {
      assert.equal(saved.feedbacks[0]!.origin, "environment");
      assert.equal(saved.feedbacks[0]!.outcome.kind, "measured");
      assert.equal(saved.feedbacks[0]!.outcome.value, 1);
    }
  }
  assert.equal(requests, 6, "reward collection must not add provider calls");
});
