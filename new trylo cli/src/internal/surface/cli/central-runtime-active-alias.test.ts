import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readRuntimeIntent, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import { serveCentralRuntimeWorker } from "../../adapters/central-learning-runtime/worker-host.js";
import { initializeCentralRuntimeWorker, type CentralRuntimeWorkerDriver } from "../../adapters/central-learning-runtime/worker-driver.js";
import { isCentralRuntimeWorkerBootstrap } from "../../adapters/central-learning-runtime/worker-protocol.js";
import { ensureCentralLearningBudget } from "../../integration/central-learning/budget.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CliContext } from "./context.js";
import { isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import { createCentralRuntimeReadWorkspaceAccess } from "./central-runtime-read-access.js";
import { openCentralRuntimeForTurn } from "./central-runtime-turn.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import { methodBoardRoot } from "./learning-sink.js";
import { sessionPath } from "./session-paths.js";
import { workspaceIdentity } from "./workspace-identity.js";

const at = "2026-11-05T12:00:00.000Z", legacyText = "LEGACY_CASE_ORIGINAL_REQUIREMENT", nextText = "LEGACY_CASE_NEW_TURN";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 1000, maxCalls: 4, maxSteps: 4, maxPromptChars: 5000 };

function context(home: string, cwd: string): CliContext {
  let id = 0;
  return { homeDir: path.dirname(home), cwd, env: { TRYLO_HOME: home }, nodeVersion: "test", stdinIsTty: false,
    readFile: file => existsSync(file) ? readFileSync(file, "utf8") : undefined,
    isDirectory: file => existsSync(file) && statSync(file).isDirectory(),
    realPath: file => { try { return realpathSync.native(file); } catch { return undefined; } },
    readDir: directory => existsSync(directory) ? readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }) : [], writeFile: () => false, readStdin: async () => "", readLine: async () => undefined,
    readSecret: async () => undefined, stdout() {}, stderr() {}, now: () => Date.parse(at), newId: prefix => `${prefix}:${++id}` };
}

// Only the semantic driver is replaced by an original-source reader. Transport,
// real Worker, filesystem proof, source decoder, caller and owner are unchanged.
if (!isMainThread) {
  if (parentPort === null || !isCentralRuntimeWorkerBootstrap(workerData)) throw new Error("fixture_bootstrap_invalid");

  const input = workerData, scope = runtimeScopePaths(input.homeRoot, input.workspaceRoot);

  serveCentralRuntimeWorker({ port: parentPort, scope, stop: new Int32Array(input.stopBuffer), async initialize() {
    const saved = readRuntimeIntent(scope);
    if (!saved.ok || saved.value === undefined || !isCentralRuntimeConfiguration(saved.value.configuration)) throw new Error("fixture_configuration_invalid");

    const original = context(input.homeRoot, scope.workspaceRoot);
    const resolved = await resolveCentralRuntimeWorkspaceIdentity(original, scope.workspaceRoot, { allowBudgetLookup: false });
    if (!resolved.ok) throw new Error(resolved.reason);

    const access = createCentralRuntimeReadWorkspaceAccess({ ...original, workspaceIdentity: resolved.value });
    const ctx = { ...original, get workspaceIdentity() { return access.identity!; } };
    const source = createCentralRuntimeMaterials({ ctx, workspaceId: resolved.value.workspaceId, enabled: () => true });

    return { configuration: saved.value.configuration, basisConfiguration: saved.value.configuration,
      workspaceRoot: resolved.value.workspaceRoot, budgetScope: resolved.value.budgetScope, driver: { async drive(run) {
        access.observeSourceWorkspaceRoots(run.wake.sourceWorkspaceRoots ?? []);
        run.publish({ message: "fixture_source_snapshot_entered", sourceRefs: [] });
        const snapshot = await source.snapshot(run.scope.workspaceRoot, run.signal), text = JSON.stringify(snapshot.materials);
        if (text.includes("FOREIGN_PRIVATE_BODY")) throw new Error("fixture_foreign_body_leaked");
        return { state: "waiting", sourceRefs: snapshot.sourceRefs,
          reason: text.includes(nextText) ? "legacy_new_turn_visible" : text.includes(legacyText) ? "legacy_visible" : "legacy_hidden" };
      } } };
  } });
} else test("one live owner reads an explicitly resumed legacy case journal after actual worker proof without changing its root", { skip: path.sep !== "\\" }, async t => {
  const [{ isRunFailure, prepareRun }, { catalogHash }] = await Promise.all([import("./run-command.js"), import("./wiring-catalog.js")]);
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-active-case-")), workspace = path.join(root, "MixedWorkspace");
  const foreign = path.join(root, "ForeignWorkspace"), home = path.join(root, "Profile");

  mkdirSync(workspace);
  mkdirSync(foreign);
  mkdirSync(home);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("trylo-active-case-"));
    rmSync(root, { recursive: true, force: true }); });
  const native = realpathSync.native(workspace), caller = native.toUpperCase(), ctx = context(home, native), callerCtx = context(home, caller);
  const initial = await prepareRun(ctx, { options: { message: [], readStdin: false }, sink: ctx, permissionMode: "non_interactive" });

  assert.ok(!isRunFailure(initial), JSON.stringify(initial));
  if (isRunFailure(initial)) return;

  const print = { schemaVersion: "1", providerId: initial.providerId, model: initial.model,
    toolCatalogHash: catalogHash(caller), workspaceId: workspaceIdentity(caller) };
  const legacyFile = sessionPath(ctx.homeDir, ctx.env, "legacy-case"), journal = createNdjsonSessionStore({ path: legacyFile });

  await initial.close();
  await initial.execution?.close();

  try {
    assert.ok((await journal.start({ sessionId: "legacy-case", createdAt: at, fingerprint: print })).ok);
    assert.ok((await journal.append({ type: "turn_start", sessionId: "legacy-case", turnId: "legacy-original", at, payload: {} })).ok);
    assert.ok((await journal.append({ type: "turn_input", sessionId: "legacy-case", turnId: "legacy-original", at, payload: { text: legacyText } })).ok);
  } finally { await journal.release(); }

  const foreignFile = sessionPath(ctx.homeDir, ctx.env, "foreign-case"), foreignJournal = createNdjsonSessionStore({ path: foreignFile });

  try {
    assert.ok((await foreignJournal.start({ sessionId: "foreign-case", createdAt: at,
      fingerprint: { ...print, workspaceId: workspaceIdentity(foreign), workspaceRoot: foreign } })).ok);
  } finally { await foreignJournal.release(); }

  const foreignBytes = readFileSync(foreignFile, "utf8") + "FOREIGN_PRIVATE_BODY_AND_INVALID_JOURNAL\n";

  writeFileSync(foreignFile, foreignBytes);
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const budget = await ensureCentralLearningBudget({ boardRoot, scope: native, allowance,
    authorizationRef: "test-only:existing-root", enabled: () => true, now: () => at });
  assert.ok(budget.ok);
  const before = await createBoardReader(boardRoot).load();
  assert.ok(before.ok);
  const configuration = { schemaVersion: 1, providerId: initial.providerId, model: initial.model, endpointHash: contentHashOf(initial.endpoint),
    workspaceId: workspaceIdentity(native), allowance, userLearning: false, rootRef: budget.rootRef };
  const paths = runtimeScopePaths(home, native);
  const createHost = async () => {
    let carrier: CentralRuntimeWorkerDriver | undefined;
    return serveCentralRuntime({ paths, configuration, driver: { async drive(run) {
      carrier ??= await initializeCentralRuntimeWorker({ homeRoot: home, workspaceRoot: native, configuration,
        diagnostic() {}, entrypoint: new URL("./central-runtime-active-alias.test.js", import.meta.url) }, run.signal);
      if (carrier === undefined) throw new Error("fixture_worker_missing");
      carrier.acknowledgeMetadata();
      return carrier.driver.drive(run);
    }, async close() { await carrier?.driver.close?.(); } } });
  };
  const host = await createHost();
  const waitReason = async (currentHost: typeof host, reason: string) => {
    const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(), 5000);
    try { for (;;) {
      if (cancel.signal.aborted) throw new Error(`fixture_wait_timeout:${reason}:${JSON.stringify(currentHost.owner.snapshot())}`);
      const current = currentHost.owner.snapshot();
      if (current.reason === reason && current.state === "waiting") return current;
      if (current.state === "failed") throw new Error(current.reason);
      await currentHost.owner.wait(current.revision, cancel.signal);
    } } finally { clearTimeout(timer); }
  };

  try {
    await waitReason(host, "legacy_hidden");
    const ownerId = host.owner.snapshot().ownerId;
    const resumed = await prepareRun(callerCtx, { options: { message: [], readStdin: false, resume: "legacy-case" },
      sink: callerCtx, permissionMode: "non_interactive" });

    assert.ok(!isRunFailure(resumed), JSON.stringify(resumed));
    if (isRunFailure(resumed)) return;

    try {
      assert.equal(resumed.workspaceId, print.workspaceId);
      assert.equal(resumed.workspaceRoot, caller);
      assert.equal(resumed.workspaceIdentity?.workspaceId, configuration.workspaceId);
      assert.equal(resumed.workspaceIdentity?.workspaceRoot, native);
      const runtime = await openCentralRuntimeForTurn(callerCtx, resumed);
      assert.ok(runtime);

      try {
        await waitReason(host, "legacy_visible");
        assert.ok(resumed.session);
        assert.ok((await resumed.session.append({ type: "turn_start", sessionId: "legacy-case", turnId: "legacy-next", at, payload: {} })).ok);
        assert.ok((await resumed.session.append({ type: "turn_input", sessionId: "legacy-case", turnId: "legacy-next", at,
          payload: { text: nextText } })).ok);
        await runtime.afterTask("legacy-case", "legacy-next");
        await waitReason(host, "legacy_new_turn_visible");
        const rejected = await runtime.client.wake({ reason: "test_only_foreign_hint", sourceRefs: [], sourceWorkspaceRoots: [foreign] });

        assert.ok(!rejected.ok);
        assert.equal(rejected.reason, "runtime_scope_mismatch");
        assert.equal(host.owner.snapshot().ownerId, ownerId);
      } finally { runtime.close(); }
    } finally {
      await resumed.close();
      await resumed.execution?.close();
    }

    const saved = readRuntimeIntent(paths);
    assert.ok(saved.ok && saved.value !== undefined);
    assert.deepEqual(saved.value.configuration, configuration);
    assert.deepEqual(saved.value.sourceWorkspaceRoots, [caller]);
    assert.deepEqual(await createBoardReader(boardRoot).load(), before);
    assert.equal(readFileSync(foreignFile, "utf8"), foreignBytes);
    const recovered = await createNdjsonSessionStore({ path: legacyFile }).readRecords();
    assert.ok(recovered.ok);
    assert.deepEqual(recovered.view.records[0]?.payload.fingerprint, print);
    await host.close();
    const restored = await createHost();

    try {
      await waitReason(restored, "legacy_new_turn_visible");
      assert.deepEqual(await createBoardReader(boardRoot).load(), before);
      const intent = readRuntimeIntent(paths);
      assert.ok(intent.ok && intent.value !== undefined);
      assert.deepEqual(intent.value.configuration, configuration);
      assert.deepEqual(intent.value.sourceWorkspaceRoots, [caller]);
    } finally { await restored.close(); }
  } finally { await host.close(); }
});
