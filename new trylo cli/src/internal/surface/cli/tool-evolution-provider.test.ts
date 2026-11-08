import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { createToolLearningFunding, enqueueToolLearningPlan } from "../../learning/agent/subsystems/tool/runtime/index.js";
import type { ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { CliContext } from "./context.js";
import { createDenyAllPermission } from "./permission.js";
import { openToolEvolutionProvider } from "./tool-evolution-provider.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";

function context(root: string, readFile: CliContext["readFile"]): CliContext {
  let ids = 0;
  return { env: { TRYLO_HOME: path.join(root, "profile"), TRYLO_API_KEY: "synthetic-only-not-a-credential" },
    homeDir: root, cwd: root, nodeVersion: "v24.0.0", stdinIsTty: false, readFile, isDirectory: () => false, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout() {}, stderr() {}, now: () => 0, newId: prefix => `${prefix}-${++ids}` };
}

test("a frozen tool model skips mutable selection/credentials and its original session runner spends one actual Board reservation", async () => {
  const parent = path.resolve(tmpdir()), root = await mkdtemp(path.join(parent, "trylo-frozen-tool-model-"));
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "workspace:frozen-tool-model",
    capability: "TEST ONLY frozen host transport", createdAt: "1970-01-01T00:00:00.000Z",
    trigger: { runId: "task:frozen-tool", proposalKey: "frozen-tool-source", action: "user_requested", evidenceRefs: ["task:original-tool-contract"] } };
  const funding = createToolLearningFunding({ boardRoot: root, scope: plan.scope, now: () => 0 });
  let session: ReturnType<typeof openToolEvolutionSession> | undefined;

  try {
    const queued = await enqueueToolLearningPlan(root, plan);
    assert.ok(queued.ok);
    assert.ok((await withBoardWriter(root, store => store.apply({ type: "start_job", jobId: queued.jobId,
      commandId: "start:frozen-tool-model", issuedAt: plan.createdAt }))).ok);
    assert.ok(await funding.allowance(plan));
    let requests = 0;
    const provider = (): ProviderPort => ({ fork: () => provider(), async *stream(request) {
      requests++;
      assert.equal(request.model, "actual-frozen-tool-model");
      assert.deepEqual(request.tools, []);
      yield { type: "text_delta", blockId: "contract", text: '{"contract":"original-source-bound"}' };
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: 10, totalTokens: 110,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } });
    const ctx = context(root, () => { throw new Error("Frozen work must not reread provider selection or credentials"); });

    session = openToolEvolutionSession(ctx, { provider: "changed-and-unavailable", model: "changed-after-freeze", reasoningEffort: "high",
      message: [], readStdin: false }, { boardRoot: root, funding, frozenModel: { provider: provider(), model: "actual-frozen-tool-model" } });
    assert.ok(!("exitCode" in session));
    const output = await session.complete("Return the source-bound contract as JSON.", new AbortController().signal, "contract");

    assert.deepEqual(output, { contract: "original-source-bound" });
    assert.equal(requests, 1);
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.length, 1);
    const grant = loaded.state.centralLearningGrants![0]!;

    assert.equal(grant.reservations.length, 1);
    assert.equal(centralLearningSpent(grant).tokens, 110);
    assert.equal(centralLearningSpent(grant).calls, 1);
    assert.equal(grant.reservations[0]!.usage?.kind, "reported");
  } finally {
    try {
      if (session !== undefined && !("exitCode" in session)) await session.close();
      await funding.release();
    }
    finally {
      assert.equal(path.dirname(path.resolve(root)), parent);
      assert.ok(path.basename(root).startsWith("trylo-frozen-tool-model-"));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("legacy tool provider selection still resolves its model and forwards actual reasoning effort and Responses summary", async t => {
  const previous = globalThis.fetch, bodies: Record<string, unknown>[] = [];
  let requests = 0;

  globalThis.fetch = async (_url, init) => {
    requests++;
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{"error":{"message":"synthetic local request rejection"}}', { status: 400, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = previous; });

  for (const kind of ["openai-compatible", "openai-responses"] as const) {
    const ctx = context("D:/tool-provider-contract", file => file.replaceAll("\\", "/").endsWith("/providers.json") ? JSON.stringify({ version: 1,
      selected: "configured-tool-host", providers: [{ id: "configured-tool-host", kind, endpoint: "https://tool-host.invalid/v1",
        model: "configured-tool-model", reasoning: true }] }) : undefined);
    for (const effort of [undefined, "high"] as const) {
      const selected = openToolEvolutionProvider(ctx, { message: [], readStdin: false, provider: "configured-tool-host",
        ...(effort === undefined ? {} : { reasoningEffort: effort }) }, { permission: createDenyAllPermission() });

      assert.ok(!("exitCode" in selected));
      assert.equal(selected.model, "configured-tool-model");
      const before = requests;

      for await (const event of selected.provider.stream({ attemptId: "tool-provider:legacy-reasoning", model: selected.model,
        messages: [{ role: "user", content: "TEST ONLY legacy transport options" }], tools: [] }, new AbortController().signal)) void event;

      assert.equal(requests, before + 1);
      const body = bodies.at(-1);
      assert.ok(body);
      assert.equal(body.model, "configured-tool-model");

      if (kind === "openai-compatible") assert.equal(body.reasoning_effort, effort);
      else assert.deepEqual(body.reasoning, { ...(effort === undefined ? {} : { effort }), summary: "auto" });
    }
  }
});
