import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import type { ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";
import { ToolLearningServiceError } from "../../learning/agent/subsystems/tool/domain/evolution/service-error.js";
import { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import { enqueueToolLearningPlan } from "../../learning/agent/subsystems/tool/runtime/pipeline-queue.js";
import type { CliContext } from "./context.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";

test("a public funded tool session makes one local HTTP attempt for one Board reservation after HTTP 503", async t => {
  const base = testScratchPath("tool-session-http-budget-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  let requests = 0, closeSession = async () => {};
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "TEST ONLY controlled local refusal" } }));
  });

  t.after(async () => {
    try { await closeSession(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const boardRoot = path.join(root, "board"), scope = "TEST_ONLY_funded_http";
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY funded HTTP boundary",
    createdAt: new Date(0).toISOString(), trigger: { runId: "TEST_ONLY_task", proposalKey: "TEST_ONLY_http", action: "user_requested", evidenceRefs: [] } };
  const queued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(queued.ok);
  assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "start_job", commandId: "TEST_ONLY_start", jobId: queued.jobId,
    issuedAt: plan.createdAt }))).ok);
  const funding = createToolLearningFunding({ boardRoot, scope, now: () => 0 });
  assert.ok(await funding.allowance(plan));
  let id = 0;
  const ctx: CliContext = { env: { TRYLO_HOME: path.join(root, "profile"), TRYLO_API_KEY: "TEST_ONLY_loopback_placeholder" },
    homeDir: root, cwd: root, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => false, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `TEST_ONLY_${prefix}_${++id}` };
  // This is a real local HTTP transport and Board ledger, with no external
  // provider, real credential, executable tool, download or model response.
  const session = openToolEvolutionSession(ctx, { provider: "openai-compatible", model: "TEST_ONLY_local_refusal",
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`, message: [], readStdin: false },
    { boardRoot, funding, mode: "after_turn", generationTimeoutMs: 10_000 });

  assert.ok(!("exitCode" in session));
  closeSession = async () => { try { await session.close(); } finally { await funding.release(); } };
  await assert.rejects(session.complete("Return a small JSON contract. TEST ONLY local transport.", new AbortController().signal, "contract"),
    error => error instanceof ToolLearningServiceError);
  await session.retireWorkers();
  assert.equal(requests, 1, "a retry requires another central reservation, not a transport-local resend");
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  const grants = loaded.state.centralLearningGrants!;
  assert.equal(grants.length, 1);
  const grant = grants[0]!;
  assert.equal(grant.reservations.length, 1);
  assert.equal(grant.reservations[0]!.state, "settled");
  assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
  assert.deepEqual(centralLearningSpent(grant), { calls: 1, steps: 1, tokens: grant.reservations[0]!.maxTokens });
});
