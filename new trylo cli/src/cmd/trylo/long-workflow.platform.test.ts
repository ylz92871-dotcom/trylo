import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { JsonObject } from "../../internal/protocol/envelope.js";
import { createNdjsonSessionStore } from "../../internal/adapters/session-store/ndjson.js";
import { sessionPath } from "../../internal/surface/cli/session-paths.js";

type Step = { readonly name: string; readonly args: JsonObject };

const INITIAL: readonly Step[] = [
  { name: "task_create", args: { subject: "Implement", description: "Keep the public API", activeForm: "Implementing" } },
  { name: "task_create", args: { subject: "Verify", description: "Test before finishing" } },
  { name: "task_update", args: { taskId: "1", blocks: "2", owner: "worker", claim: true } },
  { name: "create_goal", args: { objective: "Complete the migration", token_budget: 9000 } },
  { name: "goal_account_tokens", args: { tokens: 1234 } },
  { name: "todo_write", args: { todos: [{ content: "Verify", status: "in_progress" }] } },
  { name: "task_update", args: { taskId: "1", status: "completed", blocks: "missing" } },
  { name: "write_file", args: { path: "artifact.txt", content: "written once" } },
  { name: "task_get", args: { taskId: "1" } },
  { name: "goal_user_action", args: { action: "pause" } },
];
const RESUMED: readonly Step[] = [
  { name: "task_get", args: { taskId: "1" } },
  { name: "task_get", args: { taskId: "2" } },
  { name: "get_goal", args: {} },
  { name: "todo_write", args: { todos: [] } },
  { name: "task_create", args: { subject: "Deliver", description: "Share evidence" } },
];

test("CLI completes eleven requests, exits, then resumes durable workflow state without repeating a write", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-long-workflow-"));
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");

  mkdirSync(profile);
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let phase: "initial" | "resumed" = "initial";
  let index = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const steps = phase === "initial" ? INITIAL : RESUMED;
      const step = steps[index];
      const message = step === undefined ? { role: "assistant", content: "Verified." } : {
        role: "assistant", content: null, tool_calls: [{ id: `call-${index}`, type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.args) } }],
      };

      index += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message,
        finish_reason: step === undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
    });
  });

  t.after(() => server.close());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  assert.ok(address !== null && typeof address !== "string");
  writeFileSync(join(profile, "providers.json"), JSON.stringify({ version: 1, selected: "lab",
    providers: [{ id: "lab", kind: "openai-compatible", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: "m", contextWindow: 128000 }],
  }));
  const cli = fileURLToPath(new URL("./main.js", import.meta.url));

  async function run(args: readonly string[]): Promise<JsonObject[]> {
    const child = spawn(process.execPath, [cli, "run", "--workspace", workspace, "--format", "stream-json", "--allow-writes", ...args], {
      env: { ...process.env, TRYLO_HOME: profile, TRYLO_API_KEY: "public-test-key" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearTimeout(timer));

    assert.equal(code, 0, error + output);
    const events = output.trim().split("\n").map(line => JSON.parse(line) as JsonObject);

    assert.equal(events.filter(event => event.type === "run_result").length, 1);

    return events;
  }

  const initial = await run(["--session", "long-task", "Complete all migration stages"]);

  assert.equal(index, 11);
  assert.equal(initial.filter(event => event.type === "tool_result" && event.status === "failed").length, 1);
  assert.equal(readFileSync(join(workspace, "artifact.txt"), "utf8"), "written once");
  writeFileSync(join(workspace, "artifact.txt"), "changed between processes");
  phase = "resumed";
  index = 0;
  const resumed = await run(["--resume", "long-task", "Continue existing work"]);
  const results = resumed.filter(event => event.type === "tool_result");

  assert.equal(results.length, 5);
  assert.match(String(results[0]?.output), /Description: Keep the public API/);
  assert.match(String(results[0]?.output), /Status: pending/);
  assert.match(String(results[2]?.output), /Status: paused_by_user/);
  // The public stream renders output; canonical structured values live in the
  // journal. Read the real on-disk record rather than inventing a stream field.
  const store = createNdjsonSessionStore({ path: sessionPath(profile, { TRYLO_HOME: profile }, "long-task") });
  const recorded = await store.readRecords();

  assert.equal(recorded.ok, true);
  const envelopes = recorded.view.records.filter(record => record.type === "envelope" && record.turnId === resumed[0]?.turnId)
    .map(record => record.payload.envelope as JsonObject);
  const values = envelopes.filter(envelope => envelope.kind === "tool_result")
    .map(envelope => (envelope.payload as JsonObject).value as JsonObject);

  assert.equal((values[0]?.task as JsonObject).description, "Keep the public API");
  assert.equal((values[0]?.task as JsonObject).status, "pending");
  assert.equal((values[0]?.task as JsonObject).owner, "worker");
  assert.deepEqual((values[1]?.task as JsonObject).blockedBy, ["1"]);
  assert.deepEqual(values[2]?.goal, { objective: "Complete the migration", status: "paused_by_user", tokensUsed: 1234, tokenBudget: 9000, remaining: 7766 });
  assert.equal(values[3]?.previousTotal, 1);
  assert.equal((values[4]?.task as JsonObject).id, "3");
  assert.equal(readFileSync(join(workspace, "artifact.txt"), "utf8"), "changed between processes");
});
