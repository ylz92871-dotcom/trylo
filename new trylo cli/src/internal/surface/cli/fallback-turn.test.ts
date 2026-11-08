import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliContext } from "./context.js";
import { isRunFailure, prepareRun, runOneTurn } from "./run-command.js";

/**
 * WP18.2 (L05) end to end: a transient 429 exhausts the primary attempts and
 * the non-interactive turn retries exactly once on the fallback model.
 * Red was the missing `--fallback-model` path: no second request with a
 * different model could ever be built.
 */

function sseOk(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

test("a 429 on the primary falls back once to the fallback model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "trylo-fallback-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const models: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) body += String(chunk);

    const hit = models.length + 1;

    models.push((JSON.parse(body) as { model?: string }).model ?? "");

    if (hit <= 3) {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "busy" }));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(sseOk("recovered"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();

  assert.ok(address !== null && typeof address !== "string");
  let id = 0;
  const ctx: CliContext = {
    cwd: root,
    homeDir: root,
    env: { TRYLO_HOME: join(root, "profile"), TRYLO_API_KEY: "unit-credential" },
    platform: "win32",
    nodeVersion: "v24",
    stdinIsTty: false,

    readFile: (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: (file) => statSync(file).isDirectory(),
    readDir: () => [],
    writeFile: () => false,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => {},
    stderr: () => {},
    now: () => 0,
    newId: (prefix) => `${prefix}-${++id}`,
  };
  const lines: string[] = [];
  const sink = { stdout: (text: string) => lines.push(text), stderr: (_text: string) => {} };
  const scaffold = await prepareRun(ctx, {
    options: {
      message: [],
      readStdin: false,
      format: "stream-json",
      provider: "openai-compatible",
      model: "primary-7b",
      fallbackModel: "fallback-70b",
      endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    },
    sink,
    permissionMode: "non_interactive",
  });

  assert.equal(isRunFailure(scaffold), false);

  if (isRunFailure(scaffold)) {
    return;
  }

  t.after(scaffold.close);
  const outcome = await runOneTurn(ctx, scaffold, "hello", sink, "non_interactive", {});

  assert.ok("result" in outcome && outcome.exitCode === 0);
  assert.deepEqual(models, ["primary-7b", "primary-7b", "primary-7b", "fallback-70b"]);

  if ("warnings" in outcome) {
    assert.ok(outcome.warnings.some((warning) => warning.startsWith("model_fallback:")));
  }

  const frames = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  const starts = frames.filter(frame => frame.type === "run_start");
  const results = frames.filter(frame => frame.type === "run_result");

  assert.equal(starts.length, 1, "fallback is one external run, not a second start");
  assert.equal(results.length, 1, "the failed primary must not terminate Desktop before fallback");
  assert.equal(results[0]?.status, "completed");
  assert.equal(results[0]?.turnId, starts[0]?.turnId);
  assert.equal(frames.at(-1)?.type, "run_result");
  assert.ok(frames.some(frame => frame.type === "warning" && frame.code === "model_fallback"));

  if ("result" in outcome) assert.equal(results[0]?.attemptTurnId, outcome.result.turnId);
});
