import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { testScratchPath } from "../../testing/scratch.js";
import type { ToolPort } from "../../ports/tools.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { CliContext } from "./context.js";
import { openSession } from "./session-open.js";
import { catalogHash, compatibleCatalogHashes, toolCatalogHash } from "./wiring-catalog.js";

const AT = "1970-01-01T00:00:00.000Z";
const SIGNAL = new AbortController().signal;

function context(home: string): CliContext {
  return { env: {}, homeDir: home, cwd: home, nodeVersion: "v24.14.1", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-1` };
}

function previousTools(root: string): ToolPort {
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
    sessions: createProcessSessionRegistry() });
  return { ...tools, snapshot: () => tools.snapshot().filter(binding => binding.name !== "todo_read") };
}

async function savedSession(home: string, oldCatalog: string): Promise<void> {
  const opened = await openSession(context(home), { message: [], readStdin: false, session: "saved" },
    { schemaVersion: "1", providerId: "fixture", model: "fixture", workspaceId: "workspace", toolCatalogHash: oldCatalog });

  assert.equal(opened.kind, "new");

  if (opened.kind !== "new") throw new Error("Expected a new local fixture session");

  for (const [kind, payload] of [
    ["tool_use", { toolCallId: "todo", name: "todo_write", arguments: { todos: [{ content: "Preserve saved progress", status: "in_progress" }] } }],
    ["tool_result", { toolCallId: "todo", status: "succeeded", value: { todos: [{ content: "Preserve saved progress", status: "in_progress" }] } }],
  ] as const) {
    const written = await opened.session.append({ type: "envelope", sessionId: "saved", turnId: "t1", at: AT,
      payload: { envelope: { protocolVersion: "0.0", sequence: kind === "tool_use" ? 1 : 2, eventId: kind,
        timestamp: AT, sessionId: "saved", turnId: "t1", kind, producerId: "loop", producerSequence: 1, payload } } });
    assert.equal(written.ok, true);
  }

  await opened.session.release();
}

test("a saved pre-todo_read catalog resumes and exposes its restored list through the new query", async t => {
  const home = mkdtempSync(testScratchPath("todo-read-session-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  await savedSession(home, toolCatalogHash(previousTools(home)));
  const opened = await openSession(context(home), { message: [], readStdin: false, resume: "saved" },
    { schemaVersion: "1", providerId: "fixture", model: "fixture", workspaceId: "workspace", toolCatalogHash: catalogHash(home) },
    compatibleCatalogHashes(home));

  assert.equal(opened.kind, "resume");

  if (opened.kind !== "resume") throw new Error("The additive read-only tool must not strand the saved session");

  try {
    const tools = createWorkspaceTools({ workspaceRoot: home, workflowRecords: opened.records });
    const result = await tools.execute({ toolCallId: "read", name: "todo_read", arguments: {} }, SIGNAL);
    assert.equal(result.outcome, "result");
    if (result.outcome === "result") assert.deepEqual(result.value.todos,
      [{ content: "Preserve saved progress", status: "in_progress" }]);
  } finally { await opened.session.release(); }
});

test("current tool-schema changes do not strand an existing conversation", async t => {
  const home = mkdtempSync(testScratchPath("todo-read-drift-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tools = previousTools(home);
  const changed: ToolPort = { ...tools, snapshot: () => tools.snapshot().map(binding => binding.name !== "read_file" ? binding
    : { ...binding, parameters: { ...binding.parameters, unrelated: true } as JsonObject }) };

  await savedSession(home, toolCatalogHash(changed));
  const opened = await openSession(context(home), { message: [], readStdin: false, resume: "saved" },
    { schemaVersion: "1", providerId: "fixture", model: "fixture", workspaceId: "workspace", toolCatalogHash: catalogHash(home) },
    compatibleCatalogHashes(home));

  assert.equal(opened.kind, "resume", "historical calls are data; future calls use today's catalog and permissions");
  if (opened.kind === "resume") await opened.session.release();
});
