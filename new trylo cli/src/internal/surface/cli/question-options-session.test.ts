import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import type { JsonValue } from "../../protocol/envelope.js";
import { testScratchPath } from "../../testing/scratch.js";
import type { CliContext } from "./context.js";
import { openSession } from "./session-open.js";
import { sessionPath } from "./session-paths.js";
import { selectToolPort } from "./tool-selection.js";
import { catalogHash, compatibleCatalogHashes, toolCatalogHash } from "./wiring-catalog.js";

const AT = "1970-01-01T00:00:00.000Z";
const PREVIOUS_QUESTION_TOOLS = new Set(["ask_user_question", "request_user_input_async"]);
const port = (bindings: readonly ToolBinding[]): ToolPort => ({
  snapshot: () => bindings, execute: async () => ({ outcome: "cancelled" }), cancel: async () => {},
});

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, JsonValue> {
  assert.ok(isObject(value));
  return value;
}

function previousBindings(root: string): readonly ToolBinding[] {
  const current = createWorkspaceTools({ workspaceRoot: root,
    sandbox: createWorkspaceSandbox({ workspaceRoot: root }), sessions: createProcessSessionRegistry() });
  return current.snapshot().map(binding => {
    if (!PREVIOUS_QUESTION_TOOLS.has(binding.name)) return binding;
    const parameters = structuredClone(binding.parameters);
    const question = object(object(object(parameters.properties).questions).items);
    // Frozen shipped contract: choices were mandatory for both aliases.
    assert.deepEqual(question.required, ["header", "question"]);
    question.required = ["header", "question", "options"];
    return { ...binding, parameters };
  });
}

function context(home: string): CliContext {
  return { env: {}, homeDir: home, cwd: home, nodeVersion: "v24.14.1", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-1` };
}

test("a saved choices-required session resumes without rewriting history or changing session identity", async t => {
  const home = mkdtempSync(testScratchPath("question-options-resume-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const prior = toolCatalogHash(port(previousBindings(home)));
  const fingerprint = { schemaVersion: "1", providerId: "fixture", model: "fixture", workspaceId: "workspace", toolCatalogHash: prior };
  const saved = await openSession(context(home), { message: [], readStdin: false, session: "saved" }, fingerprint);
  assert.equal(saved.kind, "new");
  if (saved.kind !== "new") throw new Error("Expected a new fixture session");

  const args = { questions: [{ header: "Layout", question: "Which layout?", options: [
    { label: "One", description: "First layout" }, { label: "Two", description: "Second layout" },
  ] }] };
  for (const [sequence, kind, payload] of [
    [1, "tool_use", { toolCallId: "ask", name: "ask_user_question", arguments: args }],
    [2, "tool_result", { toolCallId: "ask", status: "succeeded", value: { answer: "One" } }],
  ] as const) {
    const written = await saved.session.append({ type: "envelope", sessionId: "saved", turnId: "t1", at: AT,
      payload: { envelope: { protocolVersion: "0.0", sequence, eventId: kind, timestamp: AT,
        sessionId: "saved", turnId: "t1", kind, producerId: "loop", producerSequence: sequence, payload } } });
    assert.equal(written.ok, true);
  }
  await saved.session.release();
  const journal = sessionPath(home, {}, "saved"), before = readFileSync(journal);
  const resumed = await openSession(context(home), { message: [], readStdin: false, resume: "saved" },
    { ...fingerprint, toolCatalogHash: catalogHash(home) }, compatibleCatalogHashes(home));
  assert.equal(resumed.kind, "resume");
  if (resumed.kind !== "resume") throw new Error("Compatible optional choices must not strand history");
  try {
    assert.ok(resumed.records.some(record => record.type === "envelope"
      && object(object(record.payload).envelope).kind === "tool_use"));
    assert.deepEqual(readFileSync(journal), before);
  } finally { await resumed.session.release(); }
});

test("the exact previous question schema is compatible for default and explicitly selected aliases", () => {
  for (const selection of [undefined, ["ask_user_question"], ["request_user_input_async"], ["ask_user_question", "request_user_input_async"]]) {
    const prior = selectToolPort(port(previousBindings("/project")), selection);
    assert.ok(compatibleCatalogHashes("/project", selection).includes(toolCatalogHash(prior, selection)));
  }
});

test("choices-required compatibility composes with prior Todo, B1 and shell contracts", () => {
  const old = previousBindings("/project").filter(binding => binding.name !== "todo_read").map(binding => {
    const parameters = structuredClone(binding.parameters), properties = object(parameters.properties);
    if (binding.name === "run_shell") {
      properties.command = { ...object(properties.command), description: "Command to run, without redirections. `a | b | c` pipelines are allowed." };
      properties.timeoutMs = { type: "number", minimum: 1, maximum: 120000, description: "Optional foreground timeout in milliseconds." };
    }
    const removed = binding.name === "read_file" ? ["offset", "limit"]
      : binding.name === "search_text" || binding.name === "glob_files" ? ["include", "exclude"] : [];
    for (const key of removed) delete properties[key];
    return { ...binding, parameters };
  });
  assert.ok(compatibleCatalogHashes("/project").includes(toolCatalogHash(port(old))));
});

test("question compatibility does not approve unknown schemas, permissions or tool ceilings", () => {
  const old = previousBindings("/project"), accepted = compatibleCatalogHashes("/project");
  for (const alter of [
    (binding: ToolBinding): ToolBinding => ({ ...binding, name: "different_question_owner" }),
    (binding: ToolBinding): ToolBinding => ({ ...binding, needsApproval: true }),
    (binding: ToolBinding): ToolBinding => ({ ...binding, sideEffect: "external" }),
    (binding: ToolBinding): ToolBinding => {
      const parameters = structuredClone(binding.parameters);
      const question = object(object(object(parameters.properties).questions).items);
      question.required = ["header", "question", "options", "id"];
      return { ...binding, parameters };
    },
    (binding: ToolBinding): ToolBinding => {
      const parameters = structuredClone(binding.parameters);
      const options = object(object(object(object(parameters.properties).questions).items).properties);
      object(options.options).minItems = 3;
      return { ...binding, parameters };
    },
  ]) {
    const changed = old.map(binding => binding.name === "ask_user_question" ? alter(binding) : binding);
    assert.equal(accepted.includes(toolCatalogHash(port(changed))), false);
  }
  const unrelated = old.map(binding => binding.name === "read_file"
    ? { ...binding, parameters: { ...binding.parameters, additionalProperties: true } } : binding);
  assert.equal(accepted.includes(toolCatalogHash(port(unrelated))), false);
  assert.equal(accepted.includes("unknown-catalog"), false);
  for (const selection of [[], ["read_file"], ["mcp_search_tools"]]) {
    assert.equal(compatibleCatalogHashes("/project", selection).includes(toolCatalogHash(port(old))), false);
  }
});

test("computing legacy compatibility leaves the live optional question contract intact", () => {
  const before = catalogHash("/project");
  compatibleCatalogHashes("/project");
  assert.equal(catalogHash("/project"), before);
  const tools = createWorkspaceTools({ workspaceRoot: "/project" });
  for (const binding of tools.snapshot().filter(item => PREVIOUS_QUESTION_TOOLS.has(item.name))) {
    const question = object(object(object(binding.parameters.properties).questions).items);
    assert.deepEqual(question.required, ["header", "question"]);
  }
});
