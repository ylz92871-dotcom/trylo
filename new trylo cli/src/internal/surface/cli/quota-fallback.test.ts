import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { CliContext } from "./context.js";
import { isRunFailure, prepareRun, runOneTurn } from "./run-command.js";

test("an explicit exhausted allowance is actionable and never moves to a configured fallback model", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-quota-fallback-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith("trylo-quota-fallback-"));
    rmSync(root, { recursive: true, force: true });
  });
  const models: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    models.push((JSON.parse(body) as { model: string }).model);
    response.writeHead(429, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "AccountQuotaExceeded", message: "You have exceeded the 5-hour usage quota. It will reset at 2026-10-25 17:25:37 +0800 CST. PRIVATE-DATA" } }));
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  t.after(() => new Promise<void>(accept => server.close(() => accept())));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  let id = 0;
  const ctx: CliContext = {
    cwd: root, homeDir: root, env: { TRYLO_HOME: join(root, "profile"), TRYLO_API_KEY: "unit-credential" },
    platform: "linux", nodeVersion: "v24", stdinIsTty: false,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: file => statSync(file).isDirectory(), readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-${++id}`,
  };
  const lines: string[] = [];
  const sink = { stdout: (text: string) => lines.push(text), stderr: (_text: string) => {} };
  const scaffold = await prepareRun(ctx, { options: { message: [], readStdin: false, format: "stream-json", provider: "openai-compatible",
    model: "primary", fallbackModel: "fallback", endpoint: `http://127.0.0.1:${address.port}/chat/completions` }, sink, permissionMode: "non_interactive" });
  assert.equal(isRunFailure(scaffold), false); if (isRunFailure(scaffold)) return;
  t.after(scaffold.close);
  const outcome = await runOneTurn(ctx, scaffold, "hello", sink, "non_interactive", {});
  assert.deepEqual(models, ["primary"], "quota is account allowance, not transient model capacity");
  assert.equal(outcome.exitCode, 75);
  const frames = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  const warnings = frames.filter(frame => frame.type === "warning");
  assert.ok(warnings.some(frame => frame.code === "quota" && typeof frame.message === "string" && frame.message.includes("reset_at=2026-10-25T17:25:37+08:00")));
  assert.equal(JSON.stringify(lines).includes("PRIVATE-DATA"), false);
  assert.equal(JSON.stringify(lines).includes("model_fallback:"), false);
});
