import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { initializeCentralRuntimeWorker } from "../../adapters/central-learning-runtime/worker-driver.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import type { CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint } from "../../ports/session.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { sessionPath } from "./session-paths.js";
import { openSession } from "./session-open.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import { workspaceIdentity } from "./workspace-identity.js";
import { openCentralRuntimeForTurn } from "./central-runtime-turn.js";
import type { RunScaffold } from "./run-scaffold.js";

const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000,
  maxCalls: 4, maxSteps: 4, maxPromptChars: 5000 };

async function observed(promise: Promise<void>) {
  const cancel = new AbortController();
  const deadline = delay(3000, undefined, { signal: cancel.signal }).then(() => { throw new Error("runtime_hint_was_not_driven"); });
  try { await Promise.race([promise, deadline]); }
  finally { cancel.abort(); }
}

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-workspace-continuation-"));
  const workspace = path.join(root, "MixedWorkspace"), foreign = path.join(root, "ForeignWorkspace"), home = path.join(root, "Profile");

  mkdirSync(workspace);
  mkdirSync(foreign);
  mkdirSync(home);
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "trylo-workspace-continuation-")));
    rmSync(root, { recursive: true, force: true });
  });
  const ctx: CliContext = { cwd: workspace, homeDir: root, env: { TRYLO_HOME: home }, nodeVersion: "test", stdinIsTty: false,
    readFile: file => existsSync(file) ? readFileSync(file, "utf8") : undefined, isDirectory: file => statSync(file).isDirectory(),
    realPath: file => { try { return realpathSync.native(file); } catch { return undefined; } }, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout() {}, stderr() {}, now: () => Date.parse("2026-11-05T00:00:00.000Z"), newId: () => "unused" };
  const print = (native: string, explicitRoot?: string): RuntimeFingerprint => ({ schemaVersion: SESSION_FORMAT_VERSION,
    providerId: "fixture", model: "fixture", toolCatalogHash: "fixture:stable-catalog", workspaceId: workspaceIdentity(native),
    ...(explicitRoot === undefined ? {} : { workspaceRoot: explicitRoot }) });
  const journal = async (sessionId: string, native: string, explicitRoot?: string) => {
    const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });
    const started = await store.start({ sessionId, createdAt: "2026-11-05T00:00:00.000Z", fingerprint: print(native, explicitRoot) });
    assert.ok(started.ok);
    await store.release();
    return sessionPath(ctx.homeDir, ctx.env, sessionId);
  };
  const saveIntent = (native: string, rootRef?: CentralLearningBudgetRootRef) => {
    const paths = runtimeScopePaths(home, native), owner = tryAcquireRuntimeOwner(paths);
    assert.ok(owner.ok);
    try { assert.ok(owner.value.writeIntent({ schemaVersion: 1, homeRoot: home, workspaceRoot: native, enabled: true,
      wakeSequence: 1, consumedSequence: 0, wakeReason: "saved", sourceRefs: [], configuration: { schemaVersion: 1,
        providerId: "fixture", model: "fixture", endpointHash: "fixture", workspaceId: workspaceIdentity(native),
        allowance, userLearning: false, thoughtMaxTokens: 2048, ...(rootRef === undefined ? {} : { rootRef }) } }).ok); }
    finally { owner.value.close(); }
  };

  return { ctx, workspace, foreign, home, print, journal, saveIntent, boardRoot: methodBoardRoot(ctx.homeDir, ctx.env) };
}

test("an original journal without a root resumes under the identical raw caller spelling without identity migration", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), caller = f.workspace.toLowerCase(), sessionId = "legacy-raw-caller";
  const file = await f.journal(sessionId, caller), before = readFileSync(file, "utf8");
  const resolved = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller,
    { allowBudgetLookup: false, resumeSessionId: sessionId });
  assert.ok(resolved.ok);
  const resumed = await openSession(f.ctx, { message: [], readStdin: false, resume: sessionId },
    { ...f.print(caller), workspaceId: resolved.value.workspaceId, workspaceRoot: resolved.value.workspaceRoot });

  assert.equal(resumed.kind, "resume", JSON.stringify(resumed));

  if (resumed.kind === "resume") await resumed.session.release();

  assert.equal(resolved.value.workspaceRoot, caller);
  assert.equal(resolved.value.requestedRoot, caller);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(existsSync(f.boardRoot), false);
  assert.equal(existsSync(runtimeScopePaths(f.home, caller).directory), false);
});

test("an explicit original header root needs both its original hash and same physical workspace", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), native = f.workspace.toUpperCase(), caller = f.workspace.toLowerCase();

  await f.journal("explicit-native-root", native, native);
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, caller,
    { allowBudgetLookup: false, resumeSessionId: "explicit-native-root" });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.workspaceRoot, native);
  assert.equal(resolved.value.workspaceId, workspaceIdentity(native));
  assert.equal(resolved.value.budgetScope, native);
  assert.ok(resolved.value.compatibleRoots.includes(caller));
  assert.equal(existsSync(f.boardRoot), false);
});

test("a legacy unknown hash and a foreign or contradictory explicit root never establish a resume identity", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), caller = f.workspace.toLowerCase(), unseen = f.workspace.replace("MixedWorkspace", "mIxEdWoRkSpAcE");

  await f.journal("unknown-legacy", unseen);
  await f.journal("foreign-root", f.foreign, f.foreign);
  await f.journal("contradictory-root", unseen, f.workspace);

  for (const sessionId of ["unknown-legacy", "foreign-root", "contradictory-root"]) {
    const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, caller, { allowBudgetLookup: false, resumeSessionId: sessionId });
    assert.ok(!resolved.ok);
    assert.equal(resolved.reason, "runtime_workspace_identity_unresolved");
  }

  assert.equal(existsSync(f.boardRoot), false);
});

test("an explicit missing resume is rejected even when a runtime primary is saved", async t => {
  const f = fixture(t);
  f.saveIntent(f.workspace);
  const paths = runtimeScopePaths(f.home, f.workspace), before = readFileSync(paths.intentPath, "utf8");
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace,
    { allowBudgetLookup: false, resumeSessionId: "missing-resume" });
  assert.ok(!resolved.ok);
  assert.equal(resolved.reason, "runtime_workspace_identity_unresolved");
  assert.equal(readFileSync(paths.intentPath, "utf8"), before);
  assert.equal(existsSync(f.boardRoot), false);
});

test("a legitimate old journal resumes its business identity beside a saved runtime primary without rebinding it", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), caller = f.workspace.toLowerCase(), sessionId = "old-business-identity";

  f.saveIntent(f.workspace);
  await f.journal(sessionId, caller);
  const paths = runtimeScopePaths(f.home, f.workspace), before = readFileSync(paths.intentPath, "utf8");
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, caller,
    { allowBudgetLookup: false, resumeSessionId: sessionId });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.workspaceRoot, f.workspace);
  assert.equal(resolved.value.workspaceId, workspaceIdentity(f.workspace));
  assert.equal(resolved.value.budgetScope, f.workspace);
  assert.deepEqual(resolved.value.resumedSession, { workspaceRoot: caller, workspaceId: workspaceIdentity(caller) });
  const resumed = await openSession(f.ctx, { message: [], readStdin: false, resume: sessionId }, f.print(caller));

  assert.equal(resumed.kind, "resume", JSON.stringify(resumed));
  if (resumed.kind === "resume") await resumed.session.release();

  assert.equal(readFileSync(paths.intentPath, "utf8"), before);
  assert.equal(existsSync(f.boardRoot), false);
});

test("a saved native rootless journal resumes through witnessed primary identity across caller case without changing its wallet", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), sessionId = "saved-native-rootless", budgetId = "budget:original-native", authorizationRef = "original-native-authorization";
  const opened = await withBoardWriter(f.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:native-root", issuedAt: "2026-11-05T00:00:00.000Z",
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId, scope: f.workspace,
      unit: "total_model_tokens", limits: { tokens: 1000, calls: 4, steps: 4 }, authorizationRef } } }));
  assert.ok(opened.ok);
  const occupied = await withBoardWriter(f.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:native-charge", issuedAt: "2026-11-05T00:00:00.000Z",
    action: { kind: "reserve_budget_usage", budgetId, scope: f.workspace, owner: { kind: "central_deliberation", ownerId: "original" },
      reservationId: "original-native:pending", maxTokens: 200, expectedSequence: 1 } }));
  assert.ok(occupied.ok);
  const rootRef = { budgetId, scope: f.workspace, openedSequence: 1, authorizationRef };

  f.saveIntent(f.workspace, rootRef);
  const journal = await f.journal(sessionId, f.workspace);
  const paths = runtimeScopePaths(f.home, f.workspace), beforeIntent = readFileSync(paths.intentPath, "utf8"), beforeJournal = readFileSync(journal, "utf8");
  const before = await createBoardReader(f.boardRoot).load();
  assert.ok(before.ok);

  for (const caller of [f.workspace.toUpperCase(), f.workspace.toLowerCase()]) {
    const resolved = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller,
      { allowBudgetLookup: false, resumeSessionId: sessionId });
    assert.ok(resolved.ok);
    assert.equal(resolved.value.workspaceRoot, f.workspace);
    assert.equal(resolved.value.workspaceId, workspaceIdentity(f.workspace));
    assert.equal(resolved.value.budgetScope, f.workspace);
    assert.deepEqual(resolved.value.rootRef, rootRef);
    assert.deepEqual(resolved.value.resumedSession, { workspaceRoot: f.workspace, workspaceId: workspaceIdentity(f.workspace) });
    const resumed = await openSession(f.ctx, { message: [], readStdin: false, resume: sessionId }, f.print(f.workspace));

    assert.equal(resumed.kind, "resume", JSON.stringify(resumed));
    if (resumed.kind === "resume") await resumed.session.release();
  }

  const after = await createBoardReader(f.boardRoot).load();
  assert.ok(after.ok);
  assert.deepEqual(after.state, before.state);
  assert.equal(readFileSync(paths.intentPath, "utf8"), beforeIntent);
  assert.equal(readFileSync(journal, "utf8"), beforeJournal);
});

test("a cold worker retains the descriptor's requested alias and drives only the original budget scope", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), caller = f.workspace.toLowerCase();
  f.saveIntent(f.workspace);
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, caller, { allowBudgetLookup: false });
  assert.ok(resolved.ok);
  const descriptor = resolved.value, requested = descriptor.requestedRoot ?? descriptor.workspaceRoot;
  const carrier = await initializeCentralRuntimeWorker({ homeRoot: f.home, workspaceRoot: requested,
    configuration: { fixtureRequestedRoot: caller, fixtureNativeRoot: descriptor.workspaceRoot, fixtureBudgetScope: descriptor.budgetScope },
    diagnostic() {}, entrypoint: new URL("../../adapters/central-learning-runtime/worker-fixture.test.js", import.meta.url) }, new AbortController().signal);

  assert.ok(carrier);

  try {
    carrier.acknowledgeMetadata();
    const result = await carrier.driver.drive({ scope: runtimeScopePaths(f.home, requested), configuration: carrier.configuration,
      wake: { reason: "cold_original_source", sourceRefs: [] }, signal: new AbortController().signal, publish() {} });
    assert.equal(result.reason, "actual_fixture_result");
    assert.equal(carrier.workspaceRoot, f.workspace);
    assert.equal(descriptor.workspaceId, workspaceIdentity(f.workspace));
    assert.equal(existsSync(f.boardRoot), false);
  } finally { await carrier.driver.close?.(); }
});

for (const sameKey of [true, false]) test(sameKey
  ? "same-key caller case reaches both original turn wakes as a raw read hint"
  : "a distinct-key caller attaches the saved primary without a hint or second owner", { skip: sameKey && path.sep !== "\\" }, async t => {
  const f = fixture(t);
  f.saveIntent(f.workspace);
  const identity = await resolveCentralRuntimeWorkspaceIdentity(f.ctx, f.workspace, { allowBudgetLookup: false });
  assert.ok(identity.ok);
  // A distinct-key spelling must neither create an owner nor accompany a wake.
  const raw = sameKey ? f.workspace.toLowerCase() : path.join(f.workspace, "UNVERI~1"), paths = runtimeScopePaths(f.home, f.workspace);

  assert.equal(runtimeScopePaths(f.home, raw).scopeKey === paths.scopeKey, sameKey);
  const saved = readRuntimeIntent(paths);
  assert.ok(saved.ok && saved.value !== undefined);
  const wakes: CentralRuntimeWake[] = [];
  let entered!: () => void, committed!: () => void;
  const normalEntry = new Promise<void>(resolve => { entered = resolve; }), taskCommitted = new Promise<void>(resolve => { committed = resolve; });
  const host = await serveCentralRuntime({ paths, configuration: saved.value.configuration, driver: { async drive(input) {
    wakes.push(input.wake);
    if (input.wake.reason === "normal_entry") entered();
    if (input.wake.reason === "normal_task_source_committed") committed();
    return { state: "waiting" };
  } } });
  const scaffold: RunScaffold = { providerId: "fixture", providerKind: "fixture", model: "fixture", endpoint: "", format: "text",
    apiKey: undefined, workspaceRoot: raw, workspaceId: workspaceIdentity(raw),
    workspaceIdentity: { ...identity.value, requestedRoot: raw }, checkpointRoot: path.join(f.home, "checkpoints"),
    sessionId: "original-source", warnings: [], async close() {} };

  try {
    const runtime = await openCentralRuntimeForTurn(f.ctx, scaffold);
    assert.ok(runtime);

    try {
      assert.equal(runtime.client.scopeKey, paths.scopeKey, "business session identity cannot select another runtime owner");
      await observed(normalEntry);
      await runtime.afterTask("original-source", "original-task");
      await observed(taskCommitted);

      for (const reason of ["normal_entry", "normal_task_source_committed"]) {
        assert.deepEqual(wakes.find(wake => wake.reason === reason)?.sourceWorkspaceRoots, sameKey ? [raw] : undefined);
      }

      const current = readRuntimeIntent(paths);
      assert.ok(current.ok && current.value !== undefined);
      assert.deepEqual(current.value.configuration, saved.value.configuration);

      if (!sameKey) assert.equal(existsSync(runtimeScopePaths(f.home, raw).directory), false);

      assert.equal(existsSync(f.boardRoot), false);
    } finally { runtime.close(); }
  } finally { await host.close(); }
});
