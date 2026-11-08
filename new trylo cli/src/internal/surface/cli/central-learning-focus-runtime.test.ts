import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { attachCentralRuntime, type CentralRuntimeClient } from "../../adapters/central-learning-runtime/client.js";
import { readRuntimeIntent, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import type { CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import { ensureCentralLearningBudget } from "../../integration/central-learning/budget.js";
import { createCentralAccountingFundingAtRoot } from "../../integration/learning-content/central-accounting-funding.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { centralLearningTurnFactory } from "./central-learning-turn.js";
import { createPersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createDenyAllPermission } from "./permission.js";
import type { RunScaffold } from "./run-scaffold.js";
import { workspaceIdentity } from "./workspace-identity.js";

const at = "2026-11-05T12:00:00.000Z", signal = new AbortController().signal;
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 1000, maxCalls: 4, maxSteps: 4, maxPromptChars: 5000 };
const unexpected = (): never => { throw new Error("Focus must not invoke provider, tools, permissions or business IO"); };

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-focus-runtime-")), workspace = path.join(root, "MixedWorkspace"), home = path.join(root, "profile");

  mkdirSync(workspace);
  mkdirSync(home);
  const primary = realpathSync.native(workspace), business = path.sep === "\\" ? primary.toUpperCase() : primary;
  const ctx: CliContext = { cwd: business, homeDir: root, env: { TRYLO_HOME: home }, nodeVersion: "test", stdinIsTty: false,
    readFile: () => undefined, readDir: () => [], isDirectory: () => true,
    realPath: filename => { try { return realpathSync.native(filename); } catch { return undefined; } },
    writeFile: unexpected, readStdin: unexpected, readLine: unexpected, readSecret: unexpected,
    stdout() {}, stderr: unexpected, now: () => Date.parse(at), newId: prefix => `${prefix}-fixture` };
  const provider: ProviderPort = { stream: unexpected, fork: unexpected };
  const tools: ToolPort = { snapshot: () => [], execute: unexpected, cancel: unexpected };
  const pa = createPersonalAgentRuntime({ homeDir: ctx.homeDir, env: ctx.env, scope: business, turnId: "focus-business", choice: allowance.maxTokens,
    now: ctx.now, warn: unexpected, newOwnerId: () => "actual-pa-focus", provider, model: "must-not-send", tools, workspaceTools: tools,
    permission: createDenyAllPermission(), grants: createPermissionGrantCache(),
    sandbox: { policy: { mode: "deny_all", network: "restricted", workspaceRoot: business, maxWriteBytes: 0, allowAbsoluteExecutable: false }, evaluate: unexpected } });

  t.after(async () => { await pa.close();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-focus-runtime-"));
  rmSync(root, { recursive: true, force: true }); });
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const report = await pa.control.report({ scope: business, problemKey: "original-business-handoff", report: {
    reportId: "report:original-business", source: { teamRunId: "team:original", taskId: "task:original", memberId: "worker" },
    facts: ["The actual receiver could not interpret the original duration unit."], evidenceRefs: ["source:original-business"] } });
  assert.ok(report.ok);
  const focus = { issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    reason: "Review the original receiver boundary.", sourceRefs: ["source:original-business"] };
  const scaffold: RunScaffold = { providerId: "reference-only", providerKind: "openai-compatible", model: "must-not-send", endpoint: "http://127.0.0.1:1/v1",
    format: "text", apiKey: undefined, workspaceRoot: business, workspaceId: workspaceIdentity(business), checkpointRoot: path.join(home, "checkpoints"),
    sessionId: "focus-business", centralLearning: allowance, warnings: [], close: async () => {} };
  const turn = (runtime?: CentralRuntimeClient, identity?: CliContext["workspaceIdentity"]) => centralLearningTurnFactory({
    ctx: identity === undefined ? ctx : { ...ctx, workspaceIdentity: identity },
    scaffold: identity === undefined ? scaffold : { ...scaffold, workspaceIdentity: identity }, turnId: "focus-business", permissionChoice: {}, independent: true,
    ...(runtime === undefined ? {} : { runtime }),
  })({ provider, collaboration: pa });

  return { root, home, primary, business, ctx, boardRoot, read, focus, turn };
}

async function livePrimary(h: Awaited<ReturnType<typeof fixture>>) {
  const opened = await ensureCentralLearningBudget({ boardRoot: h.boardRoot, scope: h.primary, allowance,
    authorizationRef: "original-primary-authorization", enabled: () => true, now: () => at });
  assert.ok(opened.ok);
  const funding = createCentralAccountingFundingAtRoot({ boardRoot: h.boardRoot, scope: h.primary, budgetId: opened.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: "original-primary" }, enabled: () => true, now: () => at });

  assert.ok((await funding.reserve({ reservationId: "original-prior-call", maxTokens: 100 })).ok);
  assert.ok((await funding.settle({ reservationId: "original-prior-call", usage: { kind: "reported", totalTokens: 40 } })).ok);
  const identity = await resolveCentralRuntimeWorkspaceIdentity(h.ctx, h.business, { allowBudgetLookup: true });
  assert.ok(identity.ok);
  assert.equal(identity.value.workspaceRoot, h.primary);
  const configuration = { schemaVersion: 1, providerId: "reference-only", model: "must-not-send", endpointHash: contentHashOf("http://127.0.0.1:1/v1"),
    workspaceId: workspaceIdentity(h.primary), allowance, userLearning: false, rootRef: opened.rootRef };
  const paths = runtimeScopePaths(h.home, h.primary), wakes: CentralRuntimeWake[] = [];
  let release!: () => void;
  const closeGate = new Promise<void>(resolve => { release = resolve; });
  const host = await serveCentralRuntime({ paths, configuration, driver: {
    async drive(input) {
      wakes.push(input.wake);
      return { state: "waiting" };
    }, async close() { await closeGate; },
  } });

  try {
    const attached = await attachCentralRuntime({ homeRoot: h.home, workspaceRoot: h.primary, configuration }, {
      executable: "must-not-launch-another-owner", entrypoint: "must-not-launch", environment: {} });
    assert.ok(attached.ok);
    assert.equal(attached.client.ownerId, host.owner.snapshot().ownerId);
    return { host, paths, client: attached.client, wakes, identity: identity.value,

      async close() {
        release();
        attached.client.detach();
        await host.close("restart");
      } };
  } catch (error) {
    release();
    await host.close("restart");
    throw error;
  }
}

test("independent focus without an original runtime client cannot write a decision or open its first wallet", async t => {
  const h = await fixture(t), before = await h.read(), turn = h.turn();
  try {
    const result = await turn.focus(h.focus, signal), after = await h.read();
    assert.equal(after.centralLearningBudgets?.length ?? 0, 0, "a missing runtime must not enter legacy inspect and open a wallet");
    assert.deepEqual(after, before, "the original focus decision also remains untouched without a runtime");
    assert.deepEqual(result, { ok: false, reason: "runtime_unavailable" });
  } finally { await turn.close(); }
});

test("a live primary runtime accepts the original PA focus and wake without authorizing or charging its business alias", { skip: path.sep !== "\\" }, async t => {
  const h = await fixture(t), primary = await livePrimary(h), turn = h.turn(primary.client, primary.identity);
  try {
    assert.notEqual(h.business, h.primary);
    assert.equal(realpathSync.native(h.business), h.primary);
    const before = await h.read(), result = await turn.focus(h.focus, signal);
    assert.ok(result.ok, JSON.stringify(result));
    await new Promise<void>(resolve => setImmediate(resolve));
    const after = await h.read();
    assert.equal(after.learningIssues?.find(row => row.issueId === h.focus.issueId)?.decision.kind, "focused_learning");
    assert.equal(after.centralLearningBudgets?.length, 1);
    assert.deepEqual(after.centralLearningBudgets, before.centralLearningBudgets, "root identity, authorization, limits and original spending stay unchanged");
    assert.deepEqual(after.centralLearningGrants, before.centralLearningGrants);
    assert.ok(primary.wakes.some(wake => wake.reason === "personal_agent_focus" && wake.sourceRefs.includes(h.focus.issueId)));
  } finally {
    await turn.close();
    await primary.close();
  }
});

test("an explicitly stopping primary owner cannot be revived by a PA focus or alter original funding", { skip: path.sep !== "\\" }, async t => {
  const h = await fixture(t), primary = await livePrimary(h), turn = h.turn(primary.client, primary.identity);
  try {
    assert.ok((await primary.client.stop()).ok);
    const before = await h.read(), result = await turn.focus(h.focus, signal);
    assert.deepEqual(result, { ok: false, reason: "runtime_stopping" });
    assert.deepEqual(await h.read(), before);
    const intent = readRuntimeIntent(primary.paths);
    assert.ok(intent.ok && intent.value?.enabled === false);
    assert.equal(primary.wakes.some(wake => wake.reason === "personal_agent_focus"), false);
  } finally {
    await turn.close();
    await primary.close();
  }
});
