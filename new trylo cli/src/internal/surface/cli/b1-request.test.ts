import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliContext } from "./context.js";
import { isRunFailure, prepareRun, runOneTurn } from "./run-command.js";

test("B1 actual CLI request reloads rules at each turn and delivers range metadata and local rules", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-request-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) body += String(chunk);

    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = requests.length === 1
      ? { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "module/source.ts", offset: 2500, limit: 2 }) } }] }
      : { content: "done" };

    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();

  assert.ok(address !== null && typeof address !== "string");
  let id = 0;
  const ctx: CliContext = {
    cwd: root, homeDir: root, env: { TRYLO_HOME: join(root, "profile"), TRYLO_API_KEY: "unit-credential" },
    platform: "win32", nodeVersion: "v24", stdinIsTty: false,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: file => statSync(file).isDirectory(), readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-${++id}`,
  };

  mkdirSync(join(root, "module"));
  writeFileSync(join(root, "module", "AGENTS.md"), "LOCAL-MODULE-RULE");
  writeFileSync(join(root, "module", "source.ts"), Array.from({ length: 2600 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(root, "AGENTS.md"), "RULE-BEFORE-PREPARATION");
  const sink = { stdout: (_text: string) => {}, stderr: (_text: string) => {} };
  const scaffold = await prepareRun(ctx, { options: { message: [], readStdin: false, provider: "openai-compatible", model: "local-test", endpoint: `http://127.0.0.1:${address.port}/chat/completions` }, sink, permissionMode: "non_interactive" });

  assert.equal(isRunFailure(scaffold), false);

  if (isRunFailure(scaffold)) return;

  t.after(scaffold.close);
  writeFileSync(join(root, "AGENTS.md"), "RULE-AT-TURN-ONE");
  const first = await runOneTurn(ctx, scaffold, "read the target", sink, "non_interactive", {});

  assert.ok("result" in first && first.exitCode === 0);
  const system = requests[0]?.messages.filter(m => m.role === "system").map(m => m.content).join("\n") ?? "";

  assert.match(system, /RULE-AT-TURN-ONE/);
  assert.doesNotMatch(system, /RULE-BEFORE-PREPARATION/);
  assert.match(system, /platform: win32/);
  const toolText = requests[1]?.messages.find(m => m.role === "tool")?.content ?? "";

  assert.match(toolText, /"startLine":2501/);
  assert.match(toolText, /"nextOffset":2502/);
  assert.match(toolText, /LOCAL-MODULE-RULE/);
  writeFileSync(join(root, "AGENTS.md"), "RULE-AT-TURN-TWO");
  await runOneTurn(ctx, scaffold, "another turn", sink, "non_interactive", {});
  const nextSystem = requests[2]?.messages.filter(m => m.role === "system").map(m => m.content).join("\n") ?? "";

  assert.match(nextSystem, /RULE-AT-TURN-TWO/);
});
