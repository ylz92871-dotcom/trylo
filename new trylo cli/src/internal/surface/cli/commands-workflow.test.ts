import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { parseWorkflow } from "./args-workflow.js";
import { handleWorkflowList, handleWorkflowRun, handleWorkflowShow } from "./commands-workflow.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import { runWorkflowLearning } from "../../integration/workflow-learning/runtime.js";
import { workflowFeedback } from "../../integration/workflow-learning/archive.js";
import { decodeJournal } from "../../adapters/session-store/codec.js";
import { sessionPath } from "./session-paths.js";
import { workflowBoardRoot } from "./commands-workflow-learning.js";
import { handleRun } from "./run-command.js";
import { handleStdioRun } from "./run-stdio.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createWorkflowExecution } from "../../integration/workflow-learning/execution.js";
import { readWorkflowVersion } from "../../integration/workflow-learning/archive.js";
import { selectWorkflowPath } from "../../learning/domains/workflow/trace-learn.js";
import { resolveActiveWorkflowAdoption } from "../../integration/workflow-learning/run-adoption.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";

/**
 * Workflow regression (WP24.2 / A08).
 *
 * Discovery is real files; `run` executes through the ordinary run
 * pipeline with the offline fixture provider, so the test proves a
 * workflow produces a genuine turn result without a second executor.
 * The new-behavior red proof (unknown `workflow` command before this
 * package) is recorded in `evidence/2026-10-06-WP24/wp24-red-examples.md`.
 */

function workspace(files: Readonly<Record<string, string>>): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-wf-"));

  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text);
  }

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ctxFor(dir: string): { readonly ctx: CliContext; readonly sink: CliSink; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const readFile = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const ctx: CliContext = {
    env: { TRYLO_HOME: join(dir, "home") },
    homeDir: dir,
    cwd: dir,
    nodeVersion: "v20.0.0",
    platform: "linux",
    stdinIsTty: false,
    readFile,
    isDirectory: () => true,

    readDir: (absolutePath: string) => {
      try {
        return readdirSync(absolutePath).map((name) => {
          let bytes = 0;
          let modifiedAtMs = 0;

          try {
            const info = statSync(join(absolutePath, name));
            bytes = info.size;
            modifiedAtMs = info.mtimeMs;
          } catch {
            // Vanished between listing and stat: unsized, still listed.
          }

          return { name, bytes, modifiedAtMs };
        });
      } catch {
        return [];
      }
    },

    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-test`,
  };

  return { ctx, sink: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) }, out, err };
}

test("list names project workflows and show prints the prompt", () => {
  const ws = workspace({ ".trylo/workflows/deploy.md": "---\ndescription: Ship it\n---\n\nRun the checks.\n" });
  try {
    const fx = ctxFor(ws.dir);
    assert.equal(handleWorkflowList(fx.ctx, { json: false }), EXIT_CODES.OK);
    assert.match(fx.out.join(""), /deploy/);
    const shown = ctxFor(ws.dir);
    assert.equal(handleWorkflowShow(shown.ctx, { name: "deploy", json: false }), EXIT_CODES.OK);
    assert.match(shown.out.join(""), /Run the checks/);
  } finally {
    ws.cleanup();
  }
});

test("show of a missing workflow refuses with CONFIG, not an empty page", () => {
  const ws = workspace({});
  try {
    const fx = ctxFor(ws.dir);
    assert.equal(handleWorkflowShow(fx.ctx, { name: "nosuch", json: false }), EXIT_CODES.CONFIG);
    assert.equal(fx.out.join(""), "");
  } finally {
    ws.cleanup();
  }
});

test("run executes the workflow body as the run prompt on the fixture provider", async () => {
  const ws = workspace({ ".trylo/workflows/hello.md": "Say hello.\n" });
  try {
    const fx = ctxFor(ws.dir);
    const code = await handleWorkflowRun(
      fx.ctx,
      { name: "hello", run: { message: [], readStdin: false, provider: "fixture" } },
      fx.sink,
    );

    assert.equal(code, EXIT_CODES.OK);
    // The fixture provider's scripted answer: the point is the workflow body
    // drove a genuine turn through the ordinary pipeline (exit 0 plus model
    // text), not that the fixture echoes the prompt.
    assert.match(fx.out.join(""), /The package name is/);
  } finally {
    ws.cleanup();
  }
});

test("the parser owns run flags after -- and refuses them before it", () => {
  const ok = parseWorkflow(["run", "deploy", "--", "--provider", "fixture"]);

  assert.equal(ok.kind, "workflow_run");

  if (ok.kind === "workflow_run") {
    assert.equal(ok.options.name, "deploy");
    assert.equal(ok.options.run.provider, "fixture");
  }

  assert.equal(parseWorkflow(["run", "deploy", "--json"]).kind, "error");
  assert.equal(parseWorkflow(["run", "../escape"]).kind, "error");
  assert.equal(parseWorkflow(["bogus"]).kind, "error");
});

test("learned runs persist a durable session without an explicit session flag and keep unchecked feedback unknown", async () => {
  const task = { scope: "project-a", taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" } };
  const ws = workspace({ "task.json": JSON.stringify(task) });

  try {
    const fx = ctxFor(ws.dir);
    const boardRoot = workflowBoardRoot(fx.ctx);
    const learned = await runWorkflowLearning({ boardRoot, issuedAt: "1970-01-01T00:00:00.000Z", request: {
      ...task, subsystem: "workflow", requestId: "durable-session", collect: true,
      budget: { maxEpisodes: 2, maxSteps: 4, maxTokens: 4096 }, traces: [{ ...task, schemaVersion: 1, traceId: "prior-success",
        source: "imported", outcome: "success", steps: [{ nodeId: "prepare", input: "source.csv", output: "clean.csv",
          dependsOn: [], check: "node check-clean.mjs", status: "passed", evidenceRefs: ["imported-check"] }] }],
    } });

    assert.equal(learned.ok, true);

    if (!learned.ok) return;

    // The fixture never calls workflow_record_step. Its normal completed
    // terminal must remain distinct from verified workflow completion.
    const code = await handleWorkflowRun(fx.ctx, { name: learned.value.versionId, task: "task.json",
      run: { message: [], readStdin: false, provider: "fixture" } }, fx.sink);

    assert.equal(code, EXIT_CODES.EXECUTION_FAILURE);
    const raw = fx.ctx.readFile(sessionPath(fx.ctx.homeDir, fx.ctx.env, "workflow-run-test"));

    assert.notEqual(raw, undefined, "a learned run must retain the journal addressed by its evidence references");
    const decoded = decodeJournal(raw!);

    assert.equal(decoded.ok, true);

    if (!decoded.ok) return;

    assert.ok(decoded.records.some(record => record.type === "session_start" && record.sessionId === "workflow-run-test"));
    assert.ok(decoded.records.some(record => record.type === "terminal"));
    assert.ok(decoded.records.some(record => record.type === "envelope" && record.payload.envelope !== undefined));
    const feedback = await workflowFeedback(boardRoot, learned.value.versionId);

    assert.equal(feedback.ok, true);

    if (feedback.ok) {
      assert.equal(feedback.value.length, 1);
      assert.equal(feedback.value[0]?.outcome, "unknown");
      assert.equal(feedback.value[0]?.steps.length, 0);
    }

    assert.match(fx.err.join(""), /workflow_feedback .*"outcome":"unknown"/);
  } finally { ws.cleanup(); }
});

async function dailyFixture() {
  const task = { scope: "project-a", taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" } };
  const ws = workspace({ "task.json": JSON.stringify(task), "different.json": JSON.stringify({ ...task, conditions: { mode: "different" } }) });
  const fx = ctxFor(ws.dir);
  let id = 0;
  const ctx: CliContext = { ...fx.ctx, newId: prefix => `${prefix}-${++id}` };
  const learned = await runWorkflowLearning({ boardRoot: workflowBoardRoot(ctx), issuedAt: "1970-01-01T00:00:00.000Z", request: {
    ...task, subsystem: "workflow", requestId: "daily", collect: true, budget: { maxEpisodes: 2, maxSteps: 4, maxTokens: 4096 }, traces: [
      { ...task, schemaVersion: 1, traceId: "previous", source: "imported", outcome: "success", steps: [
        { nodeId: "prepare", input: "source.csv", output: "clean.csv", dependsOn: [], check: "node check-clean.mjs", status: "passed", evidenceRefs: ["check"] },
      ] },
    ],
  } });
  if (!learned.ok) {
    ws.cleanup();
    throw new Error(learned.message);
  }

  const records = () => {
    const decoded = decodeJournal(readFileSync(sessionPath(ctx.homeDir, ctx.env, "daily"), "utf8"));
    if (!decoded.ok) throw new Error(decoded.detail);
    return decoded.records;
  };

  return { ...fx, ctx, ws, versionId: learned.value.versionId, records };
}

test("ordinary run and stdio restore the same frozen workflow without repeating adoption", async () => {
  for (const stdio of [false, true]) {
    const fx = await dailyFixture();
    try {
      const run = stdio ? handleStdioRun : handleRun;
      const context = (): CliContext => {
        let initial = true;
        return { ...fx.ctx, readLine: async () => {
          if (initial) {
            initial = false;
            return JSON.stringify({ type: "user", message: { role: "user", content: "Continue the task." } });
          }
          return new Promise<undefined>(() => {});
        } };
      };
      const first = await run(context(), { message: ["Do the task."], readStdin: false, provider: "fixture", session: "daily",
        workflowVersion: fx.versionId, workflowTask: "task.json", ...(stdio ? { format: "stream-json" } : {}) }, fx.sink);

      assert.equal(first, EXIT_CODES.EXECUTION_FAILURE);
      const resumed = await run(context(), { message: ["Continue."], readStdin: false, provider: "fixture", resume: "daily",
        ...(stdio ? { format: "stream-json" } : {}) }, fx.sink);

      assert.equal(resumed, EXIT_CODES.EXECUTION_FAILURE);
      assert.equal(fx.records().filter(record => record.type === "execution_extension").length, 1);
      assert.equal(fx.records().filter(record => record.type === "terminal").length, 2);
      const before = fx.records().length;

      assert.equal(await handleRun(fx.ctx, { message: ["Change context."], readStdin: false, provider: "fixture", resume: "daily",
        workflowVersion: fx.versionId, workflowTask: "different.json" }, fx.sink), EXIT_CODES.CONFIG);
      assert.equal(fx.records().length, before, "refused context drift performs no new turn");
    } finally { fx.ws.cleanup(); }
  }
});

test("restart cannot refill a workflow allowance or automatically repeat an unknown effect", async () => {
  for (const failure of ["budget", "unknown_effect"] as const) {
    const fx = await dailyFixture();
    try {
      await handleRun(fx.ctx, { message: ["Do the task."], readStdin: false, provider: "fixture", session: "daily",
        workflowVersion: fx.versionId, workflowTask: "task.json", ...(failure === "budget" ? { maxTokens: 1 } : {}) }, fx.sink);

      if (failure === "unknown_effect") {
        const store = createNdjsonSessionStore({ path: sessionPath(fx.ctx.homeDir, fx.ctx.env, "daily") });
        assert.equal((await store.attach()).ok, true);
        try { assert.equal((await store.append({ type: "effect_issued", sessionId: "daily", turnId: "interrupted-turn",
          at: "1970-01-01T00:00:00.000Z", payload: { key: "tool:write-outcome-unknown" } })).ok, true); }
        finally { await store.release(); }
      }

      const before = fx.records().length;

      assert.equal(await handleRun(fx.ctx, { message: ["Continue."], readStdin: false, provider: "fixture", resume: "daily" }, fx.sink), EXIT_CODES.CONFIG);
      assert.equal(fx.records().length, before, "refusal before any provider or tool activity");
      assert.match(fx.err.join(""), failure === "budget" ? /workflow_budget_exhausted/ : /requires effect reconciliation/);
    } finally { fx.ws.cleanup(); }
  }
});

test("verified completion before a process interruption permits a different next task in the same session", async () => {
  const fx = await dailyFixture();
  try {
    await handleRun(fx.ctx, { message: ["First task."], readStdin: false, provider: "fixture", session: "daily",
      workflowVersion: fx.versionId, workflowTask: "task.json" }, fx.sink);
    const version = await readWorkflowVersion(workflowBoardRoot(fx.ctx), fx.versionId);
    if (!version.ok) throw new Error(version.message);

    const selected = selectWorkflowPath(version.value, version.value);
    if (!selected.ok) throw new Error(selected.message);

    const projection = createWorkflowExecution({ artifact: selected.value.artifact, versionId: fx.versionId, traceId: "unit-completion", sessionId: "daily" });
    const store = createNdjsonSessionStore({ path: sessionPath(fx.ctx.homeDir, fx.ctx.env, "daily") });

    assert.equal((await store.attach()).ok, true);

    try {
      let sequence = 0;
      const emit = async (kind: string, payload: JsonObject) => {
        sequence += 1;
        const envelope: Envelope = { protocolVersion: "0.0", eventId: `unit-${sequence}`, sequence,
          timestamp: "1970-01-01T00:00:00.000Z", sessionId: "daily", turnId: "unit-finished-turn", producerId: "loop", producerSequence: sequence, kind, payload };
        projection.observe(envelope);
        assert.equal((await store.append({ type: "envelope", sessionId: "daily", turnId: "unit-finished-turn",
          at: envelope.timestamp, payload: { envelope: { ...envelope } } })).ok, true);
      };

      await emit("turn_start", {});
      await emit("tool_use", { name: "run_shell", toolCallId: "unit-check", arguments: { command: "node check-clean.mjs" } });
      await emit("tool_result", { toolCallId: "unit-check", status: "succeeded", value: { exitCode: 0 } });
      const args = { nodeId: "prepare", input: "source.csv", output: "clean.csv", checkToolCallId: "unit-check" };

      await emit("tool_use", { name: "workflow_record_step", toolCallId: "unit-record", arguments: args });
      const accepted = await projection.tools.execute({ name: "workflow_record_step", toolCallId: "unit-record", arguments: args }, new AbortController().signal);

      assert.equal(accepted.outcome, "result");

      if (accepted.outcome !== "result") return;

      await emit("tool_result", { toolCallId: "unit-record", status: "succeeded", value: accepted.value });
      await emit("terminal", { reason: "completed" });
      await store.append({ type: "terminal", sessionId: "daily", turnId: "unit-finished-turn", at: "1970-01-01T00:00:00.000Z", payload: { reason: "completed" } });
    } finally { await store.release(); }

    // No completion seal was written: this is the exact process-interruption
    // window after durable execution success and before the finish hook.
    const active = await resolveActiveWorkflowAdoption(workflowBoardRoot(fx.ctx), fx.records());

    assert.deepEqual(active, { ok: true, value: undefined });
    const task = { scope: "project-b", taskFamily: { id: "audit", intentClass: "audit-data", checkKind: "acceptance" } };

    writeFileSync(join(fx.ws.dir, "next-task.json"), JSON.stringify(task));
    assert.equal(await handleRun(fx.ctx, { message: ["Another scope."], readStdin: false, provider: "fixture", resume: "daily",
      workflowVersion: fx.versionId, workflowTask: "next-task.json" }, fx.sink), EXIT_CODES.CONFIG);
    const next = await runWorkflowLearning({ boardRoot: workflowBoardRoot(fx.ctx), issuedAt: "1970-01-01T00:00:00.000Z", request: {
      ...task, subsystem: "workflow", requestId: "next-instance", collect: true, budget: { maxEpisodes: 2, maxSteps: 4, maxTokens: 4096 },
      traces: [{ ...task, schemaVersion: 1, traceId: "audit-success", source: "imported", outcome: "success", steps: [
        { nodeId: "audit", input: "audit.csv", output: "audit.json", dependsOn: [], check: "node check-audit.mjs", status: "passed", evidenceRefs: ["audit-check"] },
      ] }],
    } });
    if (!next.ok) throw new Error(next.message);

    assert.equal(await handleRun(fx.ctx, { message: ["Next task."], readStdin: false, provider: "fixture", resume: "daily",
      workflowVersion: next.value.versionId, workflowTask: "next-task.json" }, fx.sink), EXIT_CODES.EXECUTION_FAILURE);
    assert.equal(fx.records().filter(record => record.type === "execution_extension" && record.payload.configuration !== undefined).length, 3,
      "old adoption, proven completion seal and independent next adoption all remain durable");
  } finally { fx.ws.cleanup(); }
});

test("host token grants resume exhausted instances, remain idempotent and reserve unknown prior usage", async () => {
  for (const unknownUsage of [false, true]) {
    const fx = await dailyFixture();
    try {
      await handleRun(fx.ctx, { message: ["First bounded task."], readStdin: false, provider: "fixture", session: "daily",
        workflowVersion: fx.versionId, workflowTask: "task.json", maxTokens: unknownUsage ? 1000 : 1 }, fx.sink);

      if (unknownUsage) {
        const store = createNdjsonSessionStore({ path: sessionPath(fx.ctx.homeDir, fx.ctx.env, "daily") });

        assert.equal((await store.attach()).ok, true);

        try {
          for (const [kind, payload] of [["turn_start", {}], ["api_call", { attemptId: "unknown-stream" }]] as const) {
            const envelope: Envelope = { protocolVersion: "0.0", eventId: `unknown-${kind}`, sequence: kind === "turn_start" ? 0 : 1,
              timestamp: "1970-01-01T00:00:00.000Z", sessionId: "daily", turnId: "interrupted-stream", producerId: "loop", producerSequence: 1, kind, payload };
            await store.append({ type: "envelope", sessionId: "daily", turnId: "interrupted-stream", at: envelope.timestamp, payload: { envelope: { ...envelope } } });
          }
        } finally { await store.release(); }
      }

      const granted = { message: ["Continue with explicit additional allowance."], readStdin: false, provider: "fixture", resume: "daily",
        workflowRefillTokens: 10000, workflowBudgetGrant: "host-grant-1" };

      assert.equal(await handleRun(fx.ctx, granted, fx.sink), EXIT_CODES.EXECUTION_FAILURE);
      const grants = () => fx.records().filter(item => item.type === "execution_extension" &&
        typeof item.payload.configuration === "object" && item.payload.configuration !== null && !Array.isArray(item.payload.configuration)
        && "kind" in item.payload.configuration && item.payload.configuration.kind === "budget_grant");

      assert.equal(grants().length, 1);
      const configuration = grants()[0]!.payload.configuration as JsonObject;

      assert.equal(configuration.tokens, 10000);
      assert.equal(typeof configuration.unknownReservation === "number" && configuration.unknownReservation > 0, unknownUsage);
      assert.equal(await handleRun(fx.ctx, granted, fx.sink), EXIT_CODES.EXECUTION_FAILURE);
      assert.equal(grants().length, 1, "redelivered host grant does not refill again");
      const before = fx.records().length;

      assert.equal(await handleRun(fx.ctx, { ...granted, workflowRefillTokens: 20000 }, fx.sink), EXIT_CODES.CONFIG);
      assert.equal(fx.records().length, before);
      assert.equal(await handleRun(fx.ctx, { ...granted, workflowBudgetGrant: "overflow", workflowRefillTokens: Number.MAX_SAFE_INTEGER }, fx.sink), EXIT_CODES.CONFIG);
      assert.equal(fx.records().length, before, "overflowing grants are refused before appending immutable allowance");
    } finally { fx.ws.cleanup(); }
  }
});

test("disabled collection preserves execution recovery and performs no new Board writes", async () => {
  const fx = await dailyFixture();
  try {
    const root = workflowBoardRoot(fx.ctx);
    const before = await createBoardReader(root).load();

    assert.equal(before.ok, true);
    assert.equal(await handleRun(fx.ctx, { message: ["Private task."], readStdin: false, provider: "fixture", session: "daily",
      workflowVersion: fx.versionId, workflowTask: "task.json", workflowLearning: true, workflowCollection: "disabled" }, fx.sink), EXIT_CODES.EXECUTION_FAILURE);
    const after = await createBoardReader(root).load();

    assert.deepEqual(after, before, "no feedback asset, learning job, proposal or model allowance is written");
    assert.equal(fx.records().filter(item => item.type === "terminal").length, 1);
    assert.equal(await handleRun(fx.ctx, { message: ["Continue privately."], readStdin: false, provider: "fixture", resume: "daily",
      workflowCollection: "disabled" }, fx.sink), EXIT_CODES.EXECUTION_FAILURE);
    assert.deepEqual(await createBoardReader(root).load(), before);
    assert.equal(fx.records().filter(item => item.type === "terminal").length, 2);
    assert.match(fx.err.join(""), /"collected":false/);
  } finally { fx.ws.cleanup(); }
});
