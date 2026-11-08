import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { ensureCentralLearningBudget } from "../../integration/central-learning/budget.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import { workspaceIdentity } from "./workspace-identity.js";
import { isRuntimeFingerprint } from "../../ports/session.js";
import { isRunFailure, prepareRun } from "./run-command.js";

const issuedAt = "2026-11-05T00:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000,
  maxCalls: 10, maxSteps: 10, maxPromptChars: 5000 };

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-workspace-identity-"));
  const workspace = path.join(root, "MixedWorkspace"), foreign = path.join(root, "ForeignWorkspace"), home = path.join(root, "Profile");

  mkdirSync(workspace);
  mkdirSync(foreign);
  mkdirSync(home);
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "trylo-workspace-identity-")));
    rmSync(root, { recursive: true, force: true });
  });
  const ctx: CliContext = { homeDir: root, cwd: workspace, env: { TRYLO_HOME: home }, nodeVersion: "test", stdinIsTty: false,
    readFile: file => existsSync(file) ? readFileSync(file, "utf8") : undefined, isDirectory: file => statSync(file).isDirectory(),
    realPath: file => { try { return realpathSync.native(file); } catch { return undefined; } },
    readDir: () => [], writeFile: () => false, readStdin: async () => "", readLine: async () => undefined,
    readSecret: async () => undefined, stdout: () => {}, stderr: () => {}, now: () => Date.parse(issuedAt), newId: () => "unused" };
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const readBoard = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const seedBudget = async (scope: string, budgetId = "budget:original"): Promise<CentralLearningBudgetRootRef> => {
    const before = await readBoard();
    const opened = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `fixture:open:${budgetId}`, issuedAt,
      action: { kind: "open_budget", expectedSequence: before.sequence, budget: { schemaVersion: 1, budgetId, scope,
        unit: "total_model_tokens", limits: { tokens: 1000, calls: 10, steps: 10 }, authorizationRef: `authorization:${budgetId}` } } }));
    assert.ok(opened.ok);
    return { budgetId, scope, openedSequence: before.sequence + 1, authorizationRef: `authorization:${budgetId}` };
  };

  function saveIntent(intentRoot: string, nativeRoot: string, rootRef?: CentralLearningBudgetRootRef) {
    const paths = runtimeScopePaths(home, intentRoot), owner = tryAcquireRuntimeOwner(paths);
    assert.ok(owner.ok);
    try { assert.ok(owner.value.writeIntent({ schemaVersion: 1, homeRoot: home, workspaceRoot: intentRoot, enabled: true,
      wakeSequence: 1, consumedSequence: 0, wakeReason: "fixture", sourceRefs: [], configuration: {
        schemaVersion: 1, providerId: "fixture", model: "fixture", endpointHash: "fixture", userLearning: false,
        workspaceId: workspaceIdentity(nativeRoot), allowance, ...(rootRef === undefined ? {} : { rootRef }) } }).ok); }
    finally { owner.value.close(); }
  }

  return { root, workspace, foreign, home, ctx, boardRoot, readBoard, seedBudget, saveIntent };
}

test("an ordinary workspace resolves its physical spelling without creating an intent or Board", async t => {
  const f = fixture(t);
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: false });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.workspaceRoot, realpathSync.native(f.workspace));
  assert.equal(resolved.value.workspaceId, workspaceIdentity(realpathSync.native(f.workspace)));
  assert.equal(resolved.value.rootRef, undefined);
  assert.equal(existsSync(f.boardRoot), false);
  assert.equal(existsSync(runtimeScopePaths(f.home, f.workspace).directory), false);
});

test("the saved exact root avoids Board lookup even when the Board is unreadable", async t => {
  const f = fixture(t), rootRef = { budgetId: "budget:original", scope: f.workspace, openedSequence: 1, authorizationRef: "original" };
  f.saveIntent(f.workspace, f.workspace, rootRef);
  mkdirSync(f.boardRoot, { recursive: true });
  writeFileSync(path.join(f.boardRoot, "board-events.ndjson"), "invalid board event\n");
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: true });
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.rootRef, rootRef);
});

test("normal prepare and cold resume keep the saved primary identity across Windows caller casing", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), rootRef = await f.seedBudget(f.workspace);

  f.saveIntent(f.workspace.toLowerCase(), f.workspace, rootRef);
  const before = await f.readBoard();
  const prepare = (cwd: string, session: { readonly session: string } | { readonly resume: string }) =>
    prepareRun({ ...f.ctx, cwd }, { options: { message: [], readStdin: false, ...session }, sink: f.ctx,
      permissionMode: "non_interactive" });
  const first = await prepare(f.workspace.toUpperCase(), { session: "native-primary" });

  assert.ok(!isRunFailure(first), JSON.stringify(first));
  if (isRunFailure(first)) return;

  try {
    assert.equal(first.workspaceRoot, f.workspace);
    assert.equal(first.workspaceId, workspaceIdentity(f.workspace));
    assert.deepEqual(first.workspaceIdentity?.rootRef, rootRef);
    assert.ok(first.session);
    const records = await first.session.readRecords();
    assert.ok(records.ok);
    const print = records.view.records[0]?.payload.fingerprint;
    assert.ok(isRuntimeFingerprint(print));
    assert.equal(print.workspaceId, first.workspaceId);
    assert.equal(print.workspaceRoot, f.workspace);
  } finally {
    await first.close();
    await first.execution?.close();
  }

  const resumed = await prepare(f.workspace.toLowerCase(), { resume: "native-primary" });

  assert.ok(!isRunFailure(resumed), JSON.stringify(resumed));
  if (isRunFailure(resumed)) return;

  try {
    assert.equal(resumed.workspaceId, workspaceIdentity(f.workspace));
    assert.ok(resumed.resumeRecords);
  }
  finally {
    await resumed.close();
    await resumed.execution?.close();
  }

  assert.deepEqual(await f.readBoard(), before, "normal preparation and resume do not mutate the original budget");
});

test("no learning authorization leaves an unreadable Board untouched", async t => {
  const f = fixture(t);
  mkdirSync(f.boardRoot, { recursive: true });
  writeFileSync(path.join(f.boardRoot, "board-events.ndjson"), "invalid board event\n");
  const ordinary = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: false });
  assert.ok(ordinary.ok);
  const explicit = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: true });
  assert.ok(!explicit.ok);
  assert.equal(explicit.reason, "runtime_workspace_budget_unavailable");
});

test("ordinary normal preparation does not inspect or repair an unreadable Board", async t => {
  const f = fixture(t);

  mkdirSync(f.boardRoot, { recursive: true });
  const events = path.join(f.boardRoot, "board-events.ndjson"), text = "invalid board event\n";

  writeFileSync(events, text);
  const run = await prepareRun(f.ctx, { options: { message: [], readStdin: false }, sink: f.ctx,
    permissionMode: "non_interactive" });

  assert.ok(!isRunFailure(run), JSON.stringify(run));
  if (isRunFailure(run)) return;

  try {
    assert.equal(run.centralLearning, undefined);
    assert.equal(run.session, undefined);
  }
  finally {
    await run.close();
    await run.execution?.close();
  }

  assert.equal(readFileSync(events, "utf8"), text);
  assert.equal(existsSync(runtimeScopePaths(f.home, f.workspace).directory), false);
});

test("two Windows case cold recoveries retain the saved native root and original charged budget", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), rootRef = await f.seedBudget(f.workspace);
  const charged = await withBoardWriter(f.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:charge", issuedAt,
    action: { kind: "reserve_budget_usage", budgetId: rootRef.budgetId, scope: rootRef.scope,
      owner: { kind: "central_deliberation", ownerId: "original" }, reservationId: "original:pending", maxTokens: 200, expectedSequence: 1 } }));

  assert.ok(charged.ok);
  const before = await f.readBoard();

  // The old bootstrap rewrote intentRoot, while config ID and rootRef still identified the original root.
  f.saveIntent(f.workspace.toLowerCase(), f.workspace, rootRef);

  for (const caller of [f.workspace.toUpperCase(), f.workspace.toLowerCase()]) {
    const resolved = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller, { allowBudgetLookup: true });
    assert.ok(resolved.ok);
    assert.equal(resolved.value.workspaceRoot, f.workspace);
    assert.equal(resolved.value.workspaceId, workspaceIdentity(f.workspace));
    assert.equal(resolved.value.budgetScope, rootRef.scope);
    assert.deepEqual(resolved.value.rootRef, rootRef);
    assert.ok(resolved.value.compatibleRoots.includes(caller));
    assert.ok(resolved.value.compatibleWorkspaceIds.includes(workspaceIdentity(caller)));
    const restored = await ensureCentralLearningBudget({ boardRoot: f.boardRoot, scope: resolved.value.budgetScope, rootRef: resolved.value.rootRef,
      allowance, authorizationRef: rootRef.authorizationRef, now: () => issuedAt, enabled: () => true });

    assert.ok(restored.ok);
    assert.equal(restored.projection.occupied.tokens, 200);
  }

  assert.deepEqual(await f.readBoard(), before, "resolution and canonical budget reuse never open or refund a root");
});

test("a missing reference recovers the unique same-physical Board scope as witnessed path evidence", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), native = f.workspace.toUpperCase(), caller = f.workspace.toLowerCase(), rootRef = await f.seedBudget(native);

  f.saveIntent(caller, native);
  const before = await f.readBoard();
  const resolved = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller, { allowBudgetLookup: true });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.workspaceRoot, native);
  assert.equal(resolved.value.workspaceId, workspaceIdentity(native));
  assert.deepEqual(resolved.value.rootRef, rootRef);
  assert.equal(resolved.value.budgetScope, native);
  assert.deepEqual(await f.readBoard(), before);
});

test("first explicit activation recovers an existing physical root and excludes foreign scope", async t => {
  const f = fixture(t), rootRef = await f.seedBudget(f.workspace);

  await f.seedBudget(f.foreign, "budget:foreign");
  await f.seedBudget("workspace:semantic", "budget:semantic");
  const before = await f.readBoard();
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: true });
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.rootRef, rootRef);
  assert.ok(!resolved.value.compatibleRoots.includes(f.foreign));
  assert.ok(!resolved.value.compatibleRoots.includes("workspace:semantic"));
  assert.deepEqual(await f.readBoard(), before);
});

test("multiple original roots for one physical workspace fail without merging either wallet", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t);
  await f.seedBudget(f.workspace.toUpperCase(), "budget:upper");
  await f.seedBudget(f.workspace.toLowerCase(), "budget:lower");
  const before = await f.readBoard();
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: true });
  assert.ok(!resolved.ok);
  assert.equal(resolved.reason, "runtime_workspace_budget_conflict");
  assert.deepEqual(await f.readBoard(), before);
});

test("an old hash with no witnessed path remains unresolved instead of enumerating casing", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), caller = f.workspace.toLowerCase(), unseen = f.workspace.replace("MixedWorkspace", "mIxEdWoRkSpAcE");
  f.saveIntent(caller, unseen);
  const resolved = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller, { allowBudgetLookup: false });
  assert.ok(!resolved.ok);
  assert.equal(resolved.reason, "runtime_workspace_identity_unresolved");
  assert.equal(existsSync(f.boardRoot), false);
});

test("a foreign saved root reference cannot gain physical alias compatibility", async t => {
  const f = fixture(t), rootRef = await f.seedBudget(f.foreign);
  f.saveIntent(f.workspace, f.workspace, rootRef);
  const before = await f.readBoard();
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: true });
  assert.ok(!resolved.ok);
  assert.equal(resolved.reason, "runtime_workspace_root_mismatch");
  assert.deepEqual(await f.readBoard(), before);
});

test("a context without realPath proves only the exact native root", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t);
  f.saveIntent(f.workspace, f.workspace);
  const { realPath: _physicalPort, ...exact } = f.ctx;
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(exact, f.workspace, { allowBudgetLookup: false });
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.compatibleRoots, [f.workspace]);
  assert.deepEqual(resolved.value.compatibleWorkspaceIds, [workspaceIdentity(f.workspace)]);
  const caller = f.workspace.toLowerCase();
  const alias = await resolveCentralRuntimeWorkspaceIdentity({ ...exact, cwd: caller }, caller, { allowBudgetLookup: false });

  assert.ok(!alias.ok);
  assert.equal(alias.reason, "runtime_workspace_root_mismatch");
});
