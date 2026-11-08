import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import { attachCentralRuntime, type CentralRuntimeAttachment } from "../../adapters/central-learning-runtime/client.js";
import type { CentralRuntimeSnapshot, CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import { readRuntimeIntent, runtimeScopePaths, type RuntimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { handleCentralRuntimeCommand } from "./central-runtime-command.js";
import type { CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { controlCentralRuntimeFor } from "./central-runtime-control.js";
import { reconfigureCentralRuntimeFor } from "./central-runtime-reconfigure.js";
import { handleCentralRuntimeRecoveryCommand,
  type CentralRuntimeRecoveryDependencies, type CentralRuntimeRecoveryReply } from "./central-runtime-recovery.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-public-runtime-recovery-")), home = path.join(root, "profile"), workspace = path.join(root, "workspace");

  mkdirSync(home);
  mkdirSync(workspace);
  const owned = createProcessContext(), output: string[] = [];
  const ctx = { ...owned, cwd: workspace, homeDir: root, env: { TRYLO_HOME: home },
    nodeExecutable: path.join(root, "must-not-launch-node"), stdout(text: string) { output.push(text); }, stderr() {} };

  t.after(() => {
    owned.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-public-runtime-recovery-/u);
    rmSync(root, { recursive: true, force: true });
  });

  return { root, home, workspace, ctx, output };
}

type Fixture = ReturnType<typeof fixture>;

function configuration(workspace: string): CentralRuntimeConfiguration {
  return { schemaVersion: 1, providerId: "fixture", model: "original-model", endpointHash: contentHashOf(""),
    workspaceId: "workspace:public-recovery", userLearning: true,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 12000, maxCalls: 3, maxSteps: 3, maxPromptChars: 20000 },
    rootRef: { budgetId: "budget:original", scope: workspace, openedSequence: 1, authorizationRef: "authorization:original" } };
}

function register(f: Fixture, name: string, policy?: "eligible" | "paused", enabled = true) {
  const workspace = path.join(f.root, name), paths = runtimeScopePaths(f.home, workspace), config = configuration(workspace);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.intentPath, JSON.stringify({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    enabled, configuration: config, wakeSequence: 7, consumedSequence: 6, wakeReason: "original_source", sourceRefs: ["source:original"],
    ...(policy === undefined ? {} : { recoveryPolicy: policy }) }));
  return { paths, configuration: config };
}

async function command(f: Fixture, input: unknown, dependencies: CentralRuntimeRecoveryDependencies = {}) {
  f.output.length = 0;
  assert.equal(await handleCentralRuntimeRecoveryCommand(f.ctx, input, dependencies), EXIT_CODES.OK);
  assert.equal(f.output.length, 1);
  return JSON.parse(f.output[0]!) as CentralRuntimeRecoveryReply;
}

function attached(paths: RuntimeScopePaths, onDetach: () => void): Extract<CentralRuntimeAttachment, { ok: true }> {
  const snapshot: CentralRuntimeSnapshot = { schemaVersion: 1, scopeKey: paths.scopeKey, ownerId: "owner:injected",
    revision: 1, wakeSequence: 7, consumedSequence: 7, state: "waiting", recoveryPolicy: "eligible", paused: false };
  const initial = { ok: true as const, snapshot };
  const forbidden = async () => { assert.fail("recovery must not submit activation, wake or stop"); };
  return { ok: true, ownerSource: "existing", initial, client: { scopeKey: paths.scopeKey, ownerId: snapshot.ownerId,
    status: async () => initial, wait: async () => initial, activate: forbidden, wake: forbidden, stop: forbidden, pause: forbidden, detach: onDetach } };
}

test("public recovery skips missing, disabled and paused authority before attach, and cold legacy authority never launches", async t => {
  const f = fixture(t), missing = path.join(f.root, "missing");
  mkdirSync(missing);
  const disabled = register(f, "disabled", "eligible", false), paused = register(f, "paused", "paused"), legacy = register(f, "legacy");
  let attaches = 0;
  const dependencies: CentralRuntimeRecoveryDependencies = { attach: async () => {
    attaches++;
    assert.fail("skipped authority cannot attach");
  } };

  for (const [workspaceRoot, reason] of [[missing, "runtime_intent_missing"], [disabled.paths.workspaceRoot, "runtime_disabled"],
    [paused.paths.workspaceRoot, "runtime_paused"]] as const) {
    const reply = await command(f, { action: "recover", workspaceRoot }, dependencies);
    assert.ok(reply.ok && reply.action === "recover");
    assert.equal(reply.result.status, "skipped");
    assert.equal(reply.result.reason, reason);
  }

  assert.equal(attaches, 0);
  const before = readFileSync(legacy.paths.intentPath, "utf8");
  const reply = await command(f, { action: "recover", workspaceRoot: legacy.paths.workspaceRoot });

  assert.ok(reply.ok && reply.action === "recover");
  assert.equal(reply.result.status, "skipped");
  assert.equal(reply.result.reason, "runtime_recovery_unclassified");
  assert.equal(reply.result.recoveryPolicy, "legacy_unclassified");
  assert.equal(readFileSync(legacy.paths.intentPath, "utf8"), before);
  assert.equal(existsSync(legacy.paths.locatorPath), false);
  assert.equal(existsSync(legacy.paths.ownerLockPath), false);
});

test("recover_enabled follows scanned-key cursors and isolates one scope failure from its remaining enabled scopes", async t => {
  const f = fixture(t), rows = Array.from({ length: 5 }, (_, index) => register(f, `scope-${index}`, "eligible"))
    .sort((left, right) => left.paths.scopeKey.localeCompare(right.paths.scopeKey));
  const disabled = rows[0]!.paths, corrupt = rows[1]!.paths;
  const original = JSON.parse(readFileSync(disabled.intentPath, "utf8"));
  writeFileSync(disabled.intentPath, JSON.stringify({ ...original, enabled: false }));
  writeFileSync(corrupt.intentPath, "{");
  const calls: string[] = [];
  let detached = 0;
  const dependencies: CentralRuntimeRecoveryDependencies = { attach: async input => {
    assert.equal(input.activation, "recover");
    calls.push(input.workspaceRoot);
    if (input.workspaceRoot === rows[2]!.paths.workspaceRoot) throw new Error("controlled_scope_failure");
    return attached(runtimeScopePaths(input.homeRoot, input.workspaceRoot), () => { detached++; });
  } };
  const first = await command(f, { action: "recover_enabled", limit: 2 }, dependencies);

  assert.ok(first.ok && first.action === "recover_enabled");
  assert.deepEqual(first.results, []);
  assert.deepEqual(first.issues.map(item => item.scopeKey), [corrupt.scopeKey]);
  assert.equal(first.nextCursor, corrupt.scopeKey);
  assert.ok(first.nextCursor);
  const second = await command(f, { action: "recover_enabled", limit: 2, afterScopeKey: first.nextCursor }, dependencies);

  assert.ok(second.ok && second.action === "recover_enabled");
  assert.equal(second.results[0]?.status, "error");
  assert.equal(second.results[0]?.reason, "runtime_recovery_unconfirmed");
  assert.equal(second.results[1]?.status, "existing");
  assert.equal(second.nextCursor, rows[3]!.paths.scopeKey);
  assert.ok(second.nextCursor);
  const last = await command(f, { action: "recover_enabled", limit: 2, afterScopeKey: second.nextCursor }, dependencies);

  assert.ok(last.ok && last.action === "recover_enabled");
  assert.deepEqual(last.results.map(result => result.status), ["existing"]);
  assert.equal(last.nextCursor, undefined);
  assert.deepEqual(calls, rows.slice(2).map(row => row.paths.workspaceRoot));
  assert.equal(detached, 2);
});

test("a child admission refusal reports the later durable pause or stop instead of the first eligible projection", async t => {
  const f = fixture(t);
  for (const operation of ["pause", "stop"] as const) {
    const row = register(f, `later-${operation}`, "eligible");
    const reply = await command(f, { action: "recover", workspaceRoot: row.paths.workspaceRoot }, { attach: async () => {
      assert.ok((await controlCentralRuntimeFor(f.ctx, row.paths.workspaceRoot, operation)).ok);
      return { ok: false, reason: operation === "pause" ? "runtime_paused" : "runtime_disabled" };
    } });

    assert.ok(reply.ok && reply.action === "recover");
    assert.equal(reply.result.status, "skipped");
    assert.equal(reply.result.enabled, operation === "pause");
    assert.equal(reply.result.paused, operation === "pause");
    assert.equal(reply.result.recoveryPolicy, operation === "pause" ? "paused" : "eligible");
  }
});

test("recovering a live failed owner observes its status without waking, reactivating or repeating its driver", async t => {
  const f = fixture(t), row = register(f, "failed-owner", "eligible");
  let drives = 0;
  const host = await serveCentralRuntime({ paths: row.paths, configuration: row.configuration,
    driver: { async drive() {
      drives++;
      throw new Error("controlled_driver_failure");
    } } });

  try {
    const signal = AbortSignal.timeout(2000);

    while (host.owner.snapshot().state !== "failed" && !signal.aborted) await host.owner.wait(host.owner.snapshot().revision, signal);

    assert.equal(host.owner.snapshot().state, "failed");
    assert.equal(drives, 1);
    const before = readFileSync(row.paths.intentPath, "utf8");
    const reply = await command(f, { action: "recover", workspaceRoot: row.paths.workspaceRoot });

    assert.ok(reply.ok && reply.action === "recover");
    assert.equal(reply.result.status, "existing");
    assert.equal(reply.result.owner?.state, "failed");
    assert.equal(drives, 1);
    assert.equal(readFileSync(row.paths.intentPath, "utf8"), before);
  } finally { await host.close(); }
});

test("public pause without an owner remains visible to inspect and a later configuration save preserves the pause", async t => {
  const f = fixture(t), row = register(f, "paused-config", "eligible"), before = readRuntimeIntent(row.paths);
  assert.ok(before.ok && before.value);

  for (const action of ["pause", "inspect"] as const) {
    f.output.length = 0;
    assert.equal(await handleCentralRuntimeCommand(f.ctx, { action, workspaceRoot: row.paths.workspaceRoot }), EXIT_CODES.OK);
    const reply = JSON.parse(f.output[0]!);
    assert.equal(reply.ok, true);
    assert.equal(reply.enabled, true);
    assert.equal(reply.recoveryPolicy, "paused");
    assert.equal(reply.paused, true);
    assert.equal(reply.owner, undefined);
  }

  let launchReads = 0;
  const result = await reconfigureCentralRuntimeFor({ ...f.ctx, get nodeExecutable(): string {
    launchReads++;
    throw new Error("paused configuration must not attach");
  } },
    row.paths.workspaceRoot, { userLearning: false, thoughtMaxTokens: 32000 });

  assert.ok(result.ok);
  assert.equal(result.paused, true);
  assert.equal(result.recoveryPolicy, "paused");
  assert.equal(result.enabled, true);
  assert.equal(launchReads, 0);
  const after = readRuntimeIntent(row.paths);
  assert.ok(after.ok && after.value);
  assert.equal(after.value.configuration.userLearning, false);
  assert.equal(after.value.configuration.thoughtMaxTokens, 32000);
  assert.equal(after.value.recoveryPolicy, "paused");
  assert.equal(after.value.wakeSequence, before.value.wakeSequence);
  assert.deepEqual(after.value.configuration.rootRef, row.configuration.rootRef);
  assert.equal(existsSync(row.paths.locatorPath), false);
});

test("public recovery can cold-start a local fake-driver owner on the original pending notification without a new PA", async t => {
  const f = fixture(t), row = register(f, "cold-owner", "eligible");
  let host: Awaited<ReturnType<typeof serveCentralRuntime>> | undefined;
  const wakes: CentralRuntimeWake[] = [];
  const dependencies: CentralRuntimeRecoveryDependencies = { attach: async (input, launch) => {
    assert.equal(input.activation, "recover");
    assert.equal(existsSync(row.paths.locatorPath), false);
    host = await serveCentralRuntime({ paths: row.paths, configuration: input.configuration,
      driver: { async drive(request) {
        wakes.push(request.wake);
        return { state: "waiting" };
      } } });
    const joined = await attachCentralRuntime(input, launch);
    assert.ok(joined.ok);
    return { ...joined, ownerSource: "launched" };
  } };

  try {
    const reply = await command(f, { action: "recover", workspaceRoot: row.paths.workspaceRoot }, dependencies);

    assert.ok(reply.ok && reply.action === "recover");
    assert.equal(reply.result.status, "launched");
    assert.ok(host);
    const signal = AbortSignal.timeout(2000);

    while (host.owner.snapshot().consumedSequence !== 7 && !signal.aborted) await host.owner.wait(host.owner.snapshot().revision, signal);

    assert.equal(host.owner.snapshot().consumedSequence, 7);
    assert.equal(host.owner.snapshot().wakeSequence, 7);
    assert.deepEqual(wakes, [{ reason: "original_source", sourceRefs: ["source:original"] }]);
    const saved = readRuntimeIntent(row.paths);
    assert.ok(saved.ok && saved.value);
    assert.deepEqual(saved.value.configuration, row.configuration);
    assert.equal(saved.value.recoveryPolicy, "eligible");
  } finally { await host?.close(); }
});
