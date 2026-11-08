import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { runTurn } from "../../loop/runner.js";
import { emptyProfileLoader } from "../../loop/fakes.js";
import { CentralLearningNominationUnavailable } from "../../integration/central-learning/contracts.js";
import { createCentralToolExecutor } from "../../integration/central-learning/tool-executor.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { testScratchPath } from "../../testing/scratch.js";
import { centralLearningTurnFactory, type CentralLearningTurnRuntime } from "./central-learning-turn.js";
import { createPersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import { createDenyAllPermission } from "./permission.js";
import { isRunFailure, prepareRun } from "./run-command.js";
import { methodBoardRoot } from "./learning-sink.js";

const unavailable = () => new CentralLearningNominationUnavailable("tool", "tool_learning_source_unavailable");
const isUnavailable = (error: unknown) => error instanceof CentralLearningNominationUnavailable
  && error.domain === "tool" && error.reason === "tool_learning_source_unavailable";

async function fixture(t: TestContext, options: { readonly independent?: boolean; readonly failure?: () => Error;
  readonly signal?: AbortSignal; readonly onlyIssueId?: string } = {}) {
  const root = mkdtempSync(testScratchPath("central-business-nomination-")), home = path.join(root, "profile");
  mkdirSync(home);
  const owned = createProcessContext(), warnings: string[] = [], requests: ProviderRequest[] = [];
  const ctx = { ...owned, cwd: root, homeDir: root, env: { TRYLO_HOME: home }, stdout() {}, stderr: (text: string) => { warnings.push(text); } };
  const scaffold = await prepareRun(ctx, { sink: ctx, permissionMode: "non_interactive", options: {
    message: [], readStdin: false, provider: "fixture", session: "business-nomination", shellIsolation: "host",
    centralLearning: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 2, maxSteps: 2, maxPromptChars: 100000 } } });

  assert.ok(!isRunFailure(scaffold));
  if (isRunFailure(scaffold)) throw new Error(scaffold.message);

  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "answer", text: "Original business delivery." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const tools: ToolPort = { snapshot: () => [], execute: async () => assert.fail("No business tool is called"), cancel: async () => {} };
  const permission = createDenyAllPermission();
  let runtime: CentralLearningTurnRuntime | undefined, inspections = 0;
  const pa = createPersonalAgentRuntime({ homeDir: ctx.homeDir, env: ctx.env, scope: scaffold.workspaceRoot,
    turnId: "business-turn", now: ctx.now, warn: text => warnings.push(text), provider, model: "fixture", tools, workspaceTools: tools,

    beforeCentralInspect: async () => {
      inspections++;
      await runtime?.beforeInspect();
    },

    permission, grants: createPermissionGrantCache(), sandbox: { policy: { mode: "deny_all", network: "restricted",
      workspaceRoot: root, maxWriteBytes: 0, allowAbsoluteExecutable: false }, evaluate: () => assert.fail("No sandbox action is called") } });
  let nominations = 0;
  // Substitute only a declared native result. The production adapter owns its
  // typed conversion; ordinary native exceptions must pass through unchanged.
  const nominationPort = createCentralToolExecutor({ boardRoot: methodBoardRoot(ctx.homeDir, ctx.env), scope: scaffold.workspaceId,
    centralScope: scaffold.workspaceRoot, now: ctx.now, authorized: () => true, modelRef: "local-fixture", mode: "after_turn",
    run: async () => assert.fail("No learning worker runs") }, {
    nominateResult: async () => {
      nominations++;
      if (options.failure !== undefined) throw options.failure();
      return { ok: false as const, reason: "tool_learning_source_unavailable" };
    },

    prepare: async () => assert.fail("No learning preparation is dispatched"),
    dispatch: async () => assert.fail("No learning work is dispatched"),
    observe: async () => assert.fail("No learning work is observed"),
  });
  const central = centralLearningTurnFactory({ ctx, scaffold: { ...scaffold, workflowCentralExecution: nominationPort,
    ...(options.onlyIssueId === undefined ? {} : { centralLearningOnlyIssueId: options.onlyIssueId }) },
    turnId: "business-turn", permissionChoice: {}, ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.independent === false ? {} : { independent: true }) })({ provider, collaboration: pa });

  runtime = central;
  t.after(async () => {
    try {
      await central.close();
      await pa.close();
      await scaffold.close();
      await scaffold.execution?.close();
    }
    finally {
      owned.close();
      assert.equal(path.dirname(root), testScratchPath());
      rmSync(root, { recursive: true, force: true });
    }
  });

  return { provider: pa.wrapProvider(provider), tools, permission, runtime: central, warnings, requests,
    nominations: () => nominations, inspections: () => inspections };
}

test("normal independent hooks and actual PA request preparation leave global nomination to the existing background owner", async t => {
  const h = await fixture(t), signal = new AbortController().signal;
  const provider = await h.runtime.beforeTask(h.provider, signal);
  const result = await runTurn({ provider, tools: h.tools, permission: h.permission, profile: emptyProfileLoader() },
    { sessionId: "business-nomination", turnId: "business-turn", correlationId: "local", text: "Deliver the original business answer." });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(h.requests.length, 1);
  const terminal = JSON.stringify(result.state);

  await h.runtime.afterTask(signal);
  assert.equal(JSON.stringify(result.state), terminal);
  assert.equal(h.inspections(), 1, "the real PA wrapper must inspect the current persisted resources");
  await h.runtime.beforeInspect();
  assert.equal(h.nominations(), 0, "neither task hooks nor automatic PA inspection may run the background snapshot's work");
  assert.equal(h.warnings.some(text => text.includes("central_learning_nomination_unavailable") || text.includes("context_unavailable")), false);
});

test("explicit learning hooks retain typed nomination failures and onlyIssue keeps its selected-source boundary", async t => {
  const explicit = await fixture(t, { independent: false });
  const signal = new AbortController().signal;

  await assert.rejects(explicit.runtime.beforeInspect(), isUnavailable);
  await assert.rejects(explicit.runtime.beforeTask(explicit.provider, signal), isUnavailable);
  await assert.rejects(explicit.runtime.afterTask(signal), isUnavailable);
  assert.equal(explicit.nominations(), 3);
  assert.equal(explicit.requests.length, 0);
  assert.equal(explicit.warnings.some(text => text.includes("central_learning_nomination_unavailable")), false);
  const selected = await fixture(t, { onlyIssueId: "selected-native-issue" });

  await selected.runtime.beforeInspect();
  await selected.runtime.beforeTask(selected.provider, signal);
  await selected.runtime.afterTask(signal);
  assert.equal(selected.nominations(), 0, "the explicit onlyIssue controller already excludes all unrelated source nomination");
});

test("normal cancellation and cancellation during explicit nomination retain the original reason and send no request", async t => {
  const cancellation = new AbortController(), reason = new Error("original-user-cancel");
  const normal = await fixture(t, { signal: cancellation.signal });

  cancellation.abort(reason);
  await assert.rejects(normal.runtime.beforeTask(normal.provider, cancellation.signal), error => error === reason);
  await assert.rejects(normal.runtime.beforeInspect(), error => error === reason);
  assert.equal(normal.nominations(), 0);
  assert.equal(normal.requests.length, 0);
  const explicitCancellation = new AbortController();
  const h = await fixture(t, { independent: false, failure: () => {
    explicitCancellation.abort(reason);
    return unavailable();
  } });

  await assert.rejects(h.runtime.beforeTask(h.provider, explicitCancellation.signal), error => error === reason);
  assert.equal(h.requests.length, 0);
  assert.equal(h.warnings.some(text => text.includes("central_learning_nomination_unavailable")), false);
});

test("explicit nomination does not reclassify ordinary permission or programming failures", async t => {
  for (const failure of [new Error("tool_nomination:tool_learning_source_unavailable"), new Error("permission_denied"), new TypeError("broken nomination port")]) {
    const h = await fixture(t, { independent: false, failure: () => failure });
    await assert.rejects(h.runtime.beforeTask(h.provider, new AbortController().signal), error => error === failure);
    assert.equal(h.requests.length, 0);
    assert.equal(h.warnings.some(text => text.includes("central_learning_nomination_unavailable")), false);
  }
});
