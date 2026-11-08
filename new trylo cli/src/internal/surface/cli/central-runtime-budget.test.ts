import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { runtimeScopePaths, readRuntimeIntent, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import type { StoreLoadResult } from "../../learning/control/store-port.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { handleCentralRuntimeBudgetCommand } from "./central-runtime-budget.js";
import { parseCentralLearning } from "./args-central-learning.js";
import { handleCentralLearning } from "./commands-central-learning.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import type { CentralRuntimeBudgetNotice } from "./central-runtime-budget-contract.js";

const now = "2026-11-05T00:00:00.000Z";

type NoticeResult = { readonly ok: true; readonly notified: boolean } | { readonly ok: false; readonly reason: string };

async function fixture(t: { after(fn: () => void): void }, options: { readonly root?: boolean; readonly enabled?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-budget-command-")), workspace = path.join(root, "workspace"), home = path.join(root, "profile");

  mkdirSync(workspace);
  mkdirSync(home);
  const output: string[] = [], errors: string[] = [], notices: unknown[] = [];
  const ctx: CliContext = { homeDir: root, cwd: workspace, env: { TRYLO_HOME: home }, nodeVersion: "test", stdinIsTty: false,
    readFile: absolute => existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined, isDirectory: absolute => absolute === workspace,
    readDir: () => [], writeFile: () => false, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => output.push(text), stderr: text => errors.push(text), now: () => Date.parse(now), newId: () => { throw new Error("no random management identity"); } };

  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "trylo-budget-command-")));
    rmSync(root, { recursive: true, force: true });
  });
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), paths = runtimeScopePaths(home, workspace);
  const rootRef: CentralLearningBudgetRootRef = { budgetId: "budget:command", scope: workspace, openedSequence: 1, authorizationRef: "initial-host-authorization" };

  if (options.root !== false) {
    const opened = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:open", issuedAt: now,
      action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: rootRef.budgetId, scope: workspace,
        unit: "total_model_tokens", limits: { tokens: 1000, calls: 10, steps: 10 }, authorizationRef: rootRef.authorizationRef } } }));
    assert.ok(opened.ok);
    const reserved = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:reserve", issuedAt: now,
      action: { kind: "reserve_budget_usage", budgetId: rootRef.budgetId, scope: workspace, owner: { kind: "user_learning", ownerId: workspace },
        reservationId: "fixture:pending", maxTokens: 100, expectedSequence: 1 } }));
    assert.ok(reserved.ok);
  }

  function saveIntent(enabled: boolean, identity = rootRef) {
    const owner = tryAcquireRuntimeOwner(paths);
    assert.ok(owner.ok);
    try { assert.ok(owner.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
      enabled, wakeSequence: 1, consumedSequence: 1, wakeReason: "fixture", sourceRefs: [], configuration: {
        schemaVersion: 1, providerId: "fixture", model: "fixture", endpointHash: "fixture", workspaceId: "workspace:fixture", userLearning: true,
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 10, maxSteps: 10, maxPromptChars: 50000 }, rootRef: identity } }).ok); }
    finally { owner.value.close(); }
  }

  if (options.enabled !== undefined) saveIntent(options.enabled);

  async function command(input: unknown, notifyResult: NoticeResult = { ok: true, notified: true },
    readBoard?: (boardRoot: string) => Promise<StoreLoadResult>) {
    output.length = 0;
    const code = await handleCentralRuntimeBudgetCommand(ctx, input, { ...(readBoard === undefined ? {} : { readBoard }), notifyExistingEnabled: async notice => {
      notices.push(notice);
      return notifyResult;
    } });
    assert.equal(output.length, 1);
    return { code, reply: JSON.parse(output[0]!) as Record<string, unknown> };
  }

  const request = (changeId = "change:user:1", overrides: Record<string, unknown> = {}) => ({ workspaceRoot: workspace, action: "budget_set_limits",
    rootRef, expectedSequence: 2, changeId, limits: { tokens: 2000, calls: 20, steps: 20 }, ...overrides });
  const board = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  return { ctx, rootRef, workspace, boardRoot, paths, notices, saveIntent, command, request, board };
}

test("budget inspect reads a missing original root without opening a Board or runtime", async t => {
  const f = await fixture(t, { root: false });
  const result = await f.command({ workspaceRoot: f.workspace, action: "budget_inspect" });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.deepEqual(result.reply, { schemaVersion: 1, domain: "central_runtime_budget", ok: true, enabled: false, budget: null });
  assert.equal(existsSync(f.boardRoot), false);
  assert.equal(existsSync(f.paths.directory), false);
  assert.equal(f.notices.length, 0);
});

test("explicit absolute cumulative limits retain original charges and retry one change idempotently", async t => {
  const f = await fixture(t, { enabled: true });
  const initial = await f.command({ workspaceRoot: f.workspace, action: "budget_inspect" });

  assert.equal(initial.code, EXIT_CODES.OK);
  const view = initial.reply.budget as { rootRef: unknown; boardSequence: number };
  assert.deepEqual(view.rootRef, f.rootRef);
  assert.equal(view.boardSequence, 2);
  const first = await f.command(f.request());
  assert.equal(first.code, EXIT_CODES.OK);
  assert.equal(first.reply.mutation, "applied");
  const budget = first.reply.budget as { limits: unknown; occupied: unknown; available: unknown };

  assert.deepEqual(budget.limits, { tokens: 2000, calls: 20, steps: 20 });
  assert.deepEqual(budget.occupied, { tokens: 100, calls: 1, steps: 1 });
  assert.deepEqual(budget.available, { tokens: 1900, calls: 19, steps: 19 });
  const repeated = await f.command(f.request());
  assert.equal(repeated.code, EXIT_CODES.OK);
  assert.equal(repeated.reply.mutation, "duplicate");
  assert.equal((await f.board()).centralLearningBudgets?.[0]?.limitChanges?.length, 1);
  assert.match((await f.board()).centralLearningBudgets![0]!.limitChanges![0]!.authorizationRef, /^explicit-user-budget:/);
  assert.equal(f.notices.length, 2, "an idempotent budget retry may redeliver the same source fact");
  assert.deepEqual((f.notices[0] as CentralRuntimeBudgetNotice).wake.sourceRefs, (f.notices[1] as CentralRuntimeBudgetNotice).wake.sourceRefs);
});

test("stale CAS, lower-than-occupied limits and changed-payload change reuse leave the root intact", async t => {
  const f = await fixture(t);
  const stale = await f.command(f.request("change:stale", { expectedSequence: 1 }));
  assert.equal(stale.reply.ok, false);
  assert.equal(stale.reply.reason, "learning_budget_stale");
  const lower = await f.command(f.request("change:lower", { limits: { tokens: 99, calls: 10, steps: 10 } }));
  assert.equal(lower.reply.ok, false);
  assert.equal(lower.reply.reason, "learning_budget_exhausted");
  assert.deepEqual((await f.board()).centralLearningBudgets?.[0]?.limits, { tokens: 1000, calls: 10, steps: 10 });
  assert.equal((await f.command(f.request())).reply.ok, true);
  const conflicting = await f.command(f.request("change:user:1", { limits: { tokens: 3000, calls: 30, steps: 30 } }));

  assert.equal(conflicting.reply.ok, false);
  assert.equal(conflicting.reply.reason, "learning_budget_conflict");
  assert.deepEqual((await f.board()).centralLearningBudgets?.[0]?.limits, { tokens: 2000, calls: 20, steps: 20 });
});

test("the command requires exact original and saved root identities and rejects caller authorization fields", async t => {
  const f = await fixture(t, { enabled: true });
  const wrong = await f.command(f.request("change:wrong-root", { rootRef: { ...f.rootRef, openedSequence: 2 } }));

  assert.equal(wrong.reply.ok, false);
  assert.equal(wrong.reply.reason, "learning_budget_binding");
  const forged = await f.command(f.request("change:forged", { authorizationRef: "caller-supplied" }));
  assert.equal(forged.code, EXIT_CODES.USAGE);
  f.saveIntent(true, { ...f.rootRef, budgetId: "other-root" });
  const mismatchedSaved = await f.command(f.request());
  assert.equal(mismatchedSaved.reply.ok, false);
  assert.equal(mismatchedSaved.reply.reason, "learning_budget_binding");
  assert.equal((await f.board()).sequence, 2);
  assert.equal(f.notices.length, 0);
});

test("management can commit while stopped and never enables or notifies that runtime", async t => {
  const f = await fixture(t, { enabled: false });
  const result = await f.command(f.request());
  assert.equal(result.reply.ok, true);
  assert.equal(result.reply.enabled, false);
  assert.equal((result.reply.wake as { status: string }).status, "skipped");
  assert.equal(f.notices.length, 0);
  const saved = readRuntimeIntent(f.paths);
  assert.ok(saved.ok);
  assert.equal(saved.value?.enabled, false);
  assert.equal(saved.value?.wakeSequence, 1);
});

test("a notification failure is reported after the confirmed limit change without reversing the budget", async t => {
  const f = await fixture(t, { enabled: true });
  const result = await f.command(f.request(), { ok: false, reason: "runtime_transport_unavailable" });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.reply.ok, true);
  assert.equal(result.reply.mutation, "applied");
  assert.deepEqual(result.reply.wake, { status: "unconfirmed", reason: "runtime_transport_unavailable" });
  assert.deepEqual((await f.board()).centralLearningBudgets?.[0]?.limits, { tokens: 2000, calls: 20, steps: 20 });
});

test("a failed readback reports an unconfirmed mutation and a same-change retry recovers the original commit", async t => {
  const f = await fixture(t, { enabled: true });
  let reads = 0;
  const result = await f.command(f.request(), { ok: true, notified: true }, async boardRoot => {
    reads++;
    return reads === 1 ? createBoardReader(boardRoot).load() : { ok: false, reason: "board_unavailable", detail: "injected_readback_failure" };
  });

  assert.equal(result.reply.ok, false);
  assert.equal(result.reply.reason, "central_runtime_budget_readback_unconfirmed");
  assert.equal(f.notices.length, 0);
  assert.deepEqual((await f.board()).centralLearningBudgets?.[0]?.limits, { tokens: 2000, calls: 20, steps: 20 });
  const recovered = await f.command(f.request());
  assert.equal(recovered.reply.ok, true);
  assert.equal(recovered.reply.mutation, "duplicate");
  assert.equal((await f.board()).centralLearningBudgets?.[0]?.limitChanges?.length, 1);
  assert.equal(f.notices.length, 1, "confirmed same-change readback can recover the missed source notification without another mutation");
});

test("the normal central command route accepts budget JSON while a stopped owner remains stopped", async t => {
  const f = await fixture(t, { enabled: false }), parsed = parseCentralLearning(["runtime", "-"]);

  assert.ok(parsed.kind === "learn" && parsed.options.subsystem === "central");
  const command = parsed.options;
  const output: string[] = [];
  const run = async (input: unknown) => {
    output.length = 0;
    const code = await handleCentralLearning({ ...f.ctx, readStdin: async () => JSON.stringify(input), stdout: text => output.push(text) }, command);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(output.length, 1);
    return JSON.parse(output[0]!) as Record<string, unknown>;
  };
  const inspected = await run({ workspaceRoot: f.workspace, action: "budget_inspect" });

  assert.equal(inspected.domain, "central_runtime_budget");
  assert.equal(inspected.enabled, false);
  const changed = await run(f.request());
  assert.equal(changed.domain, "central_runtime_budget");
  assert.equal(changed.mutation, "applied");
  assert.equal(changed.enabled, false);
  assert.equal((changed.wake as { status: string }).status, "skipped");
  const intent = readRuntimeIntent(f.paths);
  assert.ok(intent.ok);
  assert.equal(intent.value?.enabled, false);
  assert.equal(existsSync(f.paths.locatorPath), false, "management did not start a runtime owner");
});

function commandProcess(workspace: string, home: string, input: unknown): Promise<Record<string, unknown>> {
  const main = new URL("../../../cmd/trylo/main.ts", import.meta.url).href;
  const loader = new URL("../../../../scripts/skill-learning/source-loader.mjs", import.meta.url).href;
  // main.ts intentionally auto-starts only the packaged main.js name. Invoke its
  // actual exported entry with real argv/stdin and its default process context.
  const entry = `const { main } = await import(${JSON.stringify(main)}); process.exitCode = await main(process.argv.slice(1));`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "--import", loader, "--input-type=module", "--eval", entry,
      "learn", "central", "runtime", "-"], { cwd: workspace, env: { ...process.env, TRYLO_HOME: home }, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], timeout: 20000 });
    let stdout = "", stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => {
      try { assert.equal(code, 0, `actual CLI exit; stdout=${stdout}; stderr=${stderr}`);
        const lines = stdout.trim().split(/\r?\n/u);
      assert.equal(lines.length, 1);
        resolve(JSON.parse(lines[0]!) as Record<string, unknown>);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function observed(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("controlled runtime boundary was not observed")), 10000);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("actual Node CLI limit management wakes one original enabled owner and preserves its purpose and stop", async t => {
  const f = await fixture(t, { enabled: true });
  const settled = await withBoardWriter(f.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:unknown", issuedAt: now,
    action: { kind: "settle_budget_usage", budgetId: f.rootRef.budgetId, scope: f.workspace,
      owner: { kind: "user_learning", ownerId: f.workspace }, reservationId: "fixture:pending", usage: { kind: "unknown", reason: "fixture_no_final_bill" } } }));

  assert.ok(settled.ok);
  const exhausted = await withBoardWriter(f.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "fixture:exhaust", issuedAt: now,
    action: { kind: "set_budget_limit", budgetId: f.rootRef.budgetId, expectedSequence: 3, changeId: "fixture:initial-limit",
      limits: { tokens: 100, calls: 1, steps: 1 }, authorizationRef: "explicit-fixture-initial-cap" } }));
  assert.ok(exhausted.ok);
  const intent = readRuntimeIntent(f.paths);
  assert.ok(intent.ok && intent.value !== undefined);
  const originalPurpose = "compare the original User collaboration conditions";
  const continuations: string[] = [], wakes: string[] = [];
  let waiting: (() => void) | undefined, continued: (() => void) | undefined;
  const initialWaiting = new Promise<void>(resolve => { waiting = resolve; });
  const originalContinued = new Promise<void>(resolve => { continued = resolve; });
  const server = await serveCentralRuntime({ paths: f.paths, configuration: intent.value.configuration, driver: { async drive(input) {
    wakes.push(input.wake.reason);
    const projection = centralBudgetProjection(await f.board(), f.rootRef.budgetId);
    assert.ok(projection);
    if (projection.status === "exhausted") {
      waiting?.();
      return { state: "waiting", reason: "original-purpose-awaits-cumulative-budget" };
    }
    if (continuations.length === 0) {
      continuations.push(originalPurpose);
      continued?.();
    }
    return { state: "waiting", reason: "original-purpose-awaits-real-use-feedback", sourceRefs: ["purpose:original"] };
  } } });

  try {
    await observed(initialWaiting);
    const ownerId = server.address.ownerId, beforeWake = server.owner.snapshot().wakeSequence;
    const inspected = await commandProcess(f.workspace, f.paths.homeRoot, { workspaceRoot: f.workspace, action: "budget_inspect" });
    const original = inspected.budget as { rootRef: CentralLearningBudgetRootRef; boardSequence: number; occupied: unknown; status: string };

    assert.deepEqual(original.rootRef, f.rootRef);
    assert.equal(original.status, "exhausted");
    assert.deepEqual(original.occupied, { tokens: 100, calls: 1, steps: 1 });
    const request = f.request("change:live-owner", { expectedSequence: original.boardSequence });
    const changed = await commandProcess(f.workspace, f.paths.homeRoot, request);

    assert.equal(changed.ok, true);
    assert.equal(changed.mutation, "applied");
    assert.deepEqual(changed.wake, { status: "sent" });
    await observed(originalContinued);
    assert.equal(server.address.ownerId, ownerId);
    assert.equal(server.owner.snapshot().wakeSequence, beforeWake + 1);
    assert.deepEqual(continuations, [originalPurpose]);
    assert.equal(wakes.at(-1), "explicit_central_budget_limits_changed");
    const repeated = await commandProcess(f.workspace, f.paths.homeRoot, request);

    assert.equal(repeated.mutation, "duplicate");
    assert.equal((repeated.wake as { status: string }).status, "sent");
    assert.equal(server.owner.snapshot().wakeSequence, beforeWake + 2);
    assert.deepEqual(continuations, [originalPurpose]);
    const stopped = await commandProcess(f.workspace, f.paths.homeRoot, { workspaceRoot: f.workspace, action: "stop" });
    assert.equal(stopped.ok, true);
    await server.close();
    const afterStop = readRuntimeIntent(f.paths);
    assert.ok(afterStop.ok);
    assert.equal(afterStop.value?.enabled, false);
    const board = await f.board();
    const after = await commandProcess(f.workspace, f.paths.homeRoot, f.request("change:stopped", {
      expectedSequence: board.sequence, limits: { tokens: 3000, calls: 30, steps: 30 } }));

    assert.equal(after.ok, true);
    assert.equal(after.enabled, false);
    assert.equal((after.wake as { status: string }).status, "skipped");
    const saved = readRuntimeIntent(f.paths);
    assert.ok(saved.ok);
    assert.equal(saved.value?.enabled, false);
    assert.equal(existsSync(f.paths.locatorPath), false);
    assert.deepEqual(continuations, [originalPurpose]);
    assert.equal((await f.board()).centralLearningBudgets?.[0]?.accounting?.[0]?.state, "settled");
  } finally { await server.close(); }
});

test("the same committed change retries a failed notification and wakes the original purpose through the normal route", async t => {
  const f = await fixture(t, { enabled: true }), saved = readRuntimeIntent(f.paths);
  assert.ok(saved.ok && saved.value !== undefined);
  const originalPurpose = "finish the original collaboration-boundary comparison";
  const continuations: string[] = [], receivedRefs: (readonly string[])[] = [];
  let waiting: (() => void) | undefined, continued: (() => void) | undefined;
  const initialWaiting = new Promise<void>(resolve => { waiting = resolve; });
  const originalContinued = new Promise<void>(resolve => { continued = resolve; });
  const server = await serveCentralRuntime({ paths: f.paths, configuration: saved.value.configuration, driver: { async drive(input) {
    const projection = centralBudgetProjection(await f.board(), f.rootRef.budgetId);
    assert.ok(projection);
    if (projection.available.tokens < 1500) {
      waiting?.();
      return { state: "waiting", reason: "original-purpose-awaits-budget" };
    }
    receivedRefs.push(input.wake.sourceRefs);
    continuations.push(originalPurpose);
    continued?.();
    return { state: "waiting", reason: "original-purpose-awaits-real-use-feedback" };
  } } });

  try {
    await observed(initialWaiting);
    const ownerId = server.address.ownerId, beforeWake = server.owner.snapshot().wakeSequence;
    const request = f.request("change:notification-retry");
    const first = await f.command(request, { ok: false, reason: "injected_notify_unavailable" });

    assert.equal(first.reply.ok, true);
    assert.equal(first.reply.mutation, "applied");
    assert.deepEqual(first.reply.wake, { status: "unconfirmed", reason: "injected_notify_unavailable" });
    assert.equal(server.owner.snapshot().wakeSequence, beforeWake);
    assert.deepEqual(continuations, []);
    const parsed = parseCentralLearning(["runtime", "-"]);
    assert.ok(parsed.kind === "learn" && parsed.options.subsystem === "central");
    const output: string[] = [];
    const code = await handleCentralLearning({ ...f.ctx, readStdin: async () => JSON.stringify(request), stdout: text => output.push(text) }, parsed.options);

    assert.equal(code, EXIT_CODES.OK);
    const retry = JSON.parse(output[0]!) as Record<string, unknown>;

    assert.equal(retry.mutation, "duplicate");
    assert.deepEqual(retry.wake, { status: "sent" });
    await observed(originalContinued);
    assert.equal(server.address.ownerId, ownerId);
    assert.equal(server.owner.snapshot().wakeSequence, beforeWake + 1);
    assert.deepEqual(continuations, [originalPurpose]);
    assert.deepEqual(receivedRefs.at(-1), (f.notices[0] as CentralRuntimeBudgetNotice).wake.sourceRefs,
      "retry delivers the original change fact, without a second notification identity");
    const budget = (await f.board()).centralLearningBudgets![0]!;

    assert.equal(budget.limitChanges?.length, 1);
    assert.equal(budget.accounting?.length, 1);
    assert.deepEqual(budget.limits, { tokens: 2000, calls: 20, steps: 20 });
  } finally { await server.close(); }
});
