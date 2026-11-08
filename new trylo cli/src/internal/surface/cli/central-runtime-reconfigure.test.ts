import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import { requestCentralRuntime } from "../../adapters/central-learning-runtime/transport.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { isPublicCentralRuntimeEndpoint } from "./central-runtime-endpoint.js";
import { reconfigureCentralRuntimeFor } from "./central-runtime-reconfigure.js";
import type { CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { methodBoardRoot } from "./learning-sink.js";
import { parseCentralLearning } from "./args-central-learning.js";
import { handleCentralLearning } from "./commands-central-learning.js";
import { releaseLock, tryAcquireLock } from "../../adapters/learning-store/lock.js";

function fixture(enabled: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-runtime-config-")), home = path.join(root, "profile"), workspace = path.join(root, "workspace");

  mkdirSync(home);
  mkdirSync(workspace);
  const owned = createProcessContext(), ctx = { ...owned, cwd: workspace, homeDir: root, env: { TRYLO_HOME: home }, stdout() {}, stderr() {} };
  const paths = runtimeScopePaths(home, workspace);
  const configuration: CentralRuntimeConfiguration = { schemaVersion: 1, providerId: "fixture", model: "original-model", endpointHash: contentHashOf(""),
    workspaceId: "workspace:config", userLearning: true,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 12000, maxCalls: 3, maxSteps: 3, maxPromptChars: 20000 },
    rootRef: { budgetId: "budget:original", scope: workspace, openedSequence: 1, authorizationRef: "authorization:original" } };
  const acquired = tryAcquireRuntimeOwner(paths);
  assert.ok(acquired.ok);
  assert.ok(acquired.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    enabled, configuration, wakeSequence: 7, consumedSequence: 6, wakeReason: "original_source", sourceRefs: ["source:original"] }).ok);
  acquired.value.close();

  return { ctx, paths, configuration, close() { owned.close();
  assert.equal(path.dirname(root), tmpdir());
  assert.match(path.basename(root), /^trylo-runtime-config-/);
    rmSync(root, { recursive: true, force: true }); } };
}

test("public endpoint capture rejects credentials and unknown URL data without stripping or changing the target", () => {
  assert.equal(isPublicCentralRuntimeEndpoint("https://service.example/v1/chat/completions"), true);
  for (const value of ["https://name:password@service.example/v1", "https://service.example/v1?api_key=secret",
    "https://service.example/v1?unknown=opaque", "https://service.example/v1#secret", "ftp://service.example/v1"]) {
    assert.equal(isPublicCentralRuntimeEndpoint(value), false);
  }
  assert.equal(isPublicCentralRuntimeEndpoint("https://service.example/private-secret/v1", "private-secret"), false);
});

test("an explicit configuration update preserves the original root, operation allowance, wake cursor and saved stop", async () => {
  const f = fixture(false);
  try {
    const result = await reconfigureCentralRuntimeFor(f.ctx, f.ctx.cwd, { userLearning: false,
      connection: { providerId: "fixture", model: "new-explicit-model" } });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.enabled, false);
    assert.equal(result.configuration?.model, "new-explicit-model");
    const read = readRuntimeIntent(f.paths);
    assert.ok(read.ok && read.value);
    assert.deepEqual(read.value.configuration.rootRef, f.configuration.rootRef);
    assert.deepEqual(read.value.configuration.allowance, f.configuration.allowance);
    assert.equal(read.value.configuration.userLearning, false);
    assert.equal(read.value.wakeSequence, 7);
    assert.equal(read.value.consumedSequence, 6);
    const before = read.value;

    assert.equal((await reconfigureCentralRuntimeFor(f.ctx, f.ctx.cwd, { connection: { providerId: "fixture", endpoint: "https://service.example?token=secret" } })).ok, false);
    assert.deepEqual(readRuntimeIntent(f.paths), { ok: true, value: before });
  } finally { f.close(); }
});

test("normal runtime configure sets and clears independent thought tokens while preserving stopped root spending and unknown usage", async () => {
  const f = fixture(false), boardRoot = methodBoardRoot(f.ctx.homeDir, f.ctx.env), at = "2026-11-05T00:00:00.000Z";
  try {
    const originalRoot = f.configuration.rootRef!;
    const opened = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "thought:open", issuedAt: at,
      action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: originalRoot.budgetId, scope: f.ctx.cwd,
        unit: "total_model_tokens", limits: { tokens: 200000, calls: 10, steps: 10 }, authorizationRef: originalRoot.authorizationRef } } }));
    assert.ok(opened.ok);
    const owner = { kind: "user_learning" as const, ownerId: f.ctx.cwd };

    for (const action of [
      { kind: "reserve_budget_usage", budgetId: originalRoot.budgetId, scope: f.ctx.cwd, owner, reservationId: "thought:spent", maxTokens: 100, expectedSequence: 1 },
      { kind: "settle_budget_usage", budgetId: originalRoot.budgetId, scope: f.ctx.cwd, owner, reservationId: "thought:spent", usage: { kind: "reported", totalTokens: 40 } },
      { kind: "reserve_budget_usage", budgetId: originalRoot.budgetId, scope: f.ctx.cwd, owner, reservationId: "thought:unknown", maxTokens: 80, expectedSequence: 3 },
      { kind: "settle_budget_usage", budgetId: originalRoot.budgetId, scope: f.ctx.cwd, owner, reservationId: "thought:unknown", usage: { kind: "unknown", reason: "controlled_missing_bill" } },
    ] as const) {
      const written = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `thought:${action.kind}:${action.reservationId}`, issuedAt: at, action }));
      assert.ok(written.ok);
    }

    const before = await createBoardReader(boardRoot).load();
    assert.ok(before.ok);
    const projection = centralBudgetProjection(before.state, originalRoot.budgetId);
    assert.ok(projection);
    assert.deepEqual(projection.occupied, { tokens: 120, calls: 2, steps: 2 });
    const parsed = parseCentralLearning(["runtime", "-"]);
    assert.ok(parsed.kind === "learn" && parsed.options.subsystem === "central");
    const command = parsed.options;
    const run = async (thoughtMaxTokens: unknown) => {
      const lines: string[] = [];
      const code = await handleCentralLearning({ ...f.ctx, stdout: text => lines.push(text), readStdin: async () =>
        JSON.stringify({ workspaceRoot: f.ctx.cwd, action: "configure", patch: { thoughtMaxTokens } }) }, command);
      assert.equal(lines.length, 1);
      return { code, reply: JSON.parse(lines[0]!) as Record<string, unknown> };
    };
    const set = await run(32000);
    assert.equal(set.code, EXIT_CODES.OK);
    assert.equal(set.reply.enabled, false);
    const explicit = readRuntimeIntent(f.paths);
    assert.ok(explicit.ok && explicit.value);
    assert.equal(explicit.value.enabled, false);
    assert.equal(explicit.value.configuration.thoughtMaxTokens, 32000);
    assert.deepEqual(explicit.value.configuration.rootRef, originalRoot);
    assert.deepEqual(explicit.value.configuration.allowance, f.configuration.allowance);

    for (const value of [0, -1, 1.5, 1_000_000_001, "32000", true]) {
      const invalid = await run(value);
      assert.equal(invalid.code, EXIT_CODES.USAGE);
      assert.equal(invalid.reply.reason, "runtime_configuration_patch_invalid");
      assert.deepEqual(readRuntimeIntent(f.paths), explicit);
    }

    const clear = await run(null);
    assert.equal(clear.code, EXIT_CODES.OK);
    assert.equal(clear.reply.enabled, false);
    const legacy = readRuntimeIntent(f.paths);
    assert.ok(legacy.ok && legacy.value);
    assert.equal(legacy.value.enabled, false);
    assert.equal(Object.hasOwn(legacy.value.configuration, "thoughtMaxTokens"), false);
    assert.deepEqual(legacy.value.configuration, f.configuration);
    assert.equal(legacy.value.wakeSequence, 7);
    assert.equal(legacy.value.consumedSequence, 6);
    const after = await createBoardReader(boardRoot).load();
    assert.ok(after.ok);
    assert.deepEqual(after.state, before.state);
    assert.equal(existsSync(f.paths.locatorPath), false);
  } finally { f.close(); }
});

test("a stop committed while a configuration handoff drains wins and never starts a replacement owner", async () => {
  const f = fixture(true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const host = await serveCentralRuntime({ paths: f.paths, configuration: f.configuration,
    driver: { async drive() {
      entered();
      await gate;
      return { state: "waiting" };
    } } });

  try {
    await started;
    const result = await reconfigureCentralRuntimeFor(f.ctx, f.ctx.cwd, { userLearning: false }, { async sleep() {
      assert.equal((await requestCentralRuntime(host.address, { operation: "stop" })).ok, true);
      release();
      await host.close();
    } });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.enabled, false);

    const read = readRuntimeIntent(f.paths);
    assert.ok(read.ok && read.value);
    assert.equal(read.value.enabled, false);
    assert.equal(read.value.configuration.userLearning, false);
    assert.deepEqual(read.value.configuration.rootRef, f.configuration.rootRef);
  } finally {
    release();
    await host.close();
    f.close();
  }
});

test("configuration maintenance fences a recovering old-configuration owner across the original drain", async () => {
  const f = fixture(true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const host = await serveCentralRuntime({ paths: f.paths, configuration: f.configuration,
    driver: { async drive() {
      entered();
      await gate;
      return { state: "waiting" };
    } } });
  let replacement: Awaited<ReturnType<typeof serveCentralRuntime>> | undefined, interleaved = false;

  try {
    await started;
    const result = await reconfigureCentralRuntimeFor(f.ctx, f.ctx.cwd, { userLearning: false }, { async sleep() {
      if (interleaved) return;
      interleaved = true;
      release();
      await host.close();
      // A cold recover/ordinary client uses this same startup lease before launching.
      const contender = tryAcquireLock(path.join(f.paths.directory, "startup.lock"));
      if (!("ok" in contender)) {
        try {
          replacement = await serveCentralRuntime({ paths: f.paths, configuration: f.configuration,
            driver: { async drive() { return { state: "waiting" }; } } });
        } finally { releaseLock(contender); }
      } else {
        const stop = tryAcquireRuntimeOwner(f.paths);
        assert.ok(stop.ok);
        try {
          const latest = readRuntimeIntent(f.paths);
          assert.ok(latest.ok && latest.value);
          assert.ok(stop.value.writeIntent({ ...latest.value, enabled: false }).ok);
        } finally { stop.value.close(); }
      }
    } });

    assert.equal(interleaved, true);
    assert.equal(replacement, undefined, "a competing recovery must not launch the old configuration during maintenance");
    assert.ok(result.ok);
    assert.equal(result.enabled, false);
    const latest = readRuntimeIntent(f.paths);
    assert.ok(latest.ok && latest.value);
    assert.equal(latest.value.configuration.userLearning, false);
    assert.equal(latest.value.enabled, false);
    assert.deepEqual(latest.value.configuration.rootRef, f.configuration.rootRef);
    assert.equal(existsSync(path.join(f.paths.directory, "startup.lock")), false);
  } finally {
    release();
    await replacement?.close();
    await host.close();
    f.close();
  }
});

test("an explicitly chosen public Desktop endpoint is restored by the independent provider without persisting its environment credential", async () => {
  const f = fixture(false), endpoint = "http://127.0.0.1:1/v1/chat/completions", secret = "fixture-credential-local-only";
  try {
    const result = await reconfigureCentralRuntimeFor({ ...f.ctx, env: { ...f.ctx.env, TRYLO_OPENAI_API_KEY: secret } }, f.ctx.cwd,
      { connection: { providerId: "openai-compatible", model: "controlled-local", endpoint } });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.enabled, false);
    assert.equal(result.configuration?.endpoint, endpoint);
    assert.equal(result.configuration?.accountId, "env");
    assert.equal(result.configuration?.endpointHash, contentHashOf(endpoint));
    const read = readRuntimeIntent(f.paths);
    assert.ok(read.ok && read.value);
    assert.equal(JSON.stringify(read.value).includes(secret), false);
    assert.deepEqual(read.value.configuration.rootRef, f.configuration.rootRef);
  } finally { f.close(); }
});
