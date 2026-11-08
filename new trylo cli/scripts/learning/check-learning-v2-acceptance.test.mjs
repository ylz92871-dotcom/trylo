import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acceptancePlan, invoiceOracle } from "./check-learning-v2-acceptance.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("oracle accepts legal zero/absent discount and rejects independent arithmetic and shape defects", () => {
  const row = { invoiceId: "independent", lines: [{ qty: 0, unitPrice: 12 }, { qty: 2, unitPrice: 9 }], total: 18 };

  assert.equal(invoiceOracle(row), "pass");
  assert.equal(invoiceOracle({ ...row, discount: 3, total: 15 }), "pass");

  for (const value of [{ ...row, total: 15 }, { ...row, discount: 3 }, { ...row, discount: -1 },
    { ...row, total: "18" }, { ...row, lines: [] }, { ...row, lines: [{ qty: -1, unitPrice: 12 }] }]) assert.equal(invoiceOracle(value), "fail");

  assert.equal(invoiceOracle({ ...row, discount: 3, total: 21 }, "add"), "pass");
  assert.equal(invoiceOracle({ ...row, discount: 3, total: 21 }), "fail");
  assert.equal(acceptancePlan().limits.upstreamHttpRequests, 27);
});

test("a fresh production management worker reads its isolated Board with zero network allowance", async () => {
  const build = path.resolve(root, process.env.TRYLO_CHECK_COMPILED ?? "dist");
  const evidence = path.join(root, "docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-check-learning-v2");
  const directory = await mkdtemp(path.join(evidence, "prepared-worker-")), home = path.join(directory, "profile");

  await mkdir(home);
  const request = path.join(directory, "request.json");

  await writeFile(request, JSON.stringify({ action: "operation", operation: { action: "status" }, build,
    boardRoot: path.join(home, "learning/board"), provider: "AMD", model: "DeepSeek-V4-Flash", maxCalls: 0 }));
  const child = fork(fileURLToPath(new URL("./check-learning-v2-acceptance.mjs", import.meta.url)), ["--worker", request],
    { cwd: directory, windowsHide: true, env: { ...process.env, TRYLO_HOME: home, TRYLO_API_KEY: "", TRYLO_OPENAI_API_KEY: "" }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let result, stderr = "";

  child.on("message", value => { if (value.kind === "result") result = value; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  assert.equal(result?.exitCode, 0, JSON.stringify(result));
  assert.equal(result.board.ok, true);
  assert.deepEqual(result.requests, []);
  assert.equal(result.board.catalog.versions.length, 0);
  assert.equal(result.board.catalog.runs.length, 0);
});
