import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "./context.js";
import { isRunFailure, prepareRun, runOneTurn } from "./run-command.js";

for (const durable of [true, false]) test(`fallback retains bootstrap as prior context (durable=${durable})`, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-bootstrap-fallback-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { version: 1 as const, messages: [{ role: "assistant" as const, content: "BOOTSTRAP-PRIOR" }] };
  const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const originalFetch = globalThis.fetch;

  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    const body = options?.body;

    assert.equal(typeof body, "string");
    const parsed = JSON.parse(String(body)) as { model: string; messages: Array<{ role: string; content: string }> };

    requests.push(parsed);

    if (parsed.model === "primary") {
      return new Response('{"error":"busy"}', { status: 429, headers: { "Content-Type": "application/json" } });
    }

    return new Response('data: {"choices":[{"delta":{"content":"fallback done"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  };
  let id = 0;
  const ctx: CliContext = { cwd: root, homeDir: root, env: { TRYLO_HOME: path.join(root, "profile"), TRYLO_API_KEY: "fixture-only" },
    platform: "win32", nodeVersion: "v24", stdinIsTty: false, bootstrapContext: context,
    readFile(file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: file => statSync(file).isDirectory(), readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => undefined, stderr: () => undefined, now: () => 0, newId: prefix => `${prefix}-${++id}` };
  const frames: string[] = [];
  const sink = { stdout: (text: string) => frames.push(text), stderr: () => undefined };
  const scaffold = await prepareRun(ctx, { options: { message: [], readStdin: false, format: "stream-json",
    provider: "openai-compatible", model: "primary", fallbackModel: "fallback", endpoint: "https://bootstrap.invalid/v1/chat/completions",
    ...(durable ? { session: "bootstrap-fallback" } : {}),
  }, sink, permissionMode: "non_interactive" });

  assert.equal(isRunFailure(scaffold), false);

  if (isRunFailure(scaffold)) return;

  t.after(scaffold.close);
  const outcome = await runOneTurn(ctx, scaffold, "CURRENT-HUMAN", sink, "non_interactive", {});

  assert.ok("result" in outcome && outcome.exitCode === 0, JSON.stringify({ outcome, requests, frames }));
  assert.deepEqual(requests.map(request => request.model), ["primary", "primary", "primary", "fallback"]);

  for (const request of requests) {
    assert.deepEqual(request.messages.filter(message => message.content === "BOOTSTRAP-PRIOR"), context.messages);
    assert.equal(request.messages.at(-1)?.content, "CURRENT-HUMAN");
  }

  if (durable) {
    const records = await scaffold.session?.readRecords();

    assert.equal(records?.ok, true);

    if (records?.ok) {
      assert.equal(records.view.records.filter(record => record.type === "turn_start" && "bootstrapContext" in record.payload).length, 1);
      assert.equal(records.view.records.some(record => record.type === "transcript_item" && JSON.stringify(record.payload).includes("BOOTSTRAP-PRIOR")), false);
      assert.equal(records.view.records.some(record => "providerContinuation" in record.payload), false);
    }
  }

  const output = frames.map(line => JSON.parse(line) as { type: string });

  assert.equal(output.filter(frame => frame.type === "run_result").length, 1);
});
