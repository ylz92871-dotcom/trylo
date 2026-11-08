import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCentralScopeOwner } from "../../adapters/central-learning-runtime/owner.js";
import { isRuntimeIntent, type RuntimeIntent } from "../../adapters/central-learning-runtime/files.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { centralLearningProviderConnectionRef } from "../../surface/cli/central-learning-model.js";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriverProgress,
  CentralLearningIntentDraft, CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { createCentralModelDeliberation, CentralDeliberationError } from "./deliberation.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { semanticRecoveryBlock, semanticResourceCondition } from "./runtime-recovery.js";
import { createCentralRuntimeStore } from "./runtime-store.js";

const scope = "workspace:provider-recovery", sourceRef = "source:original-condition";
const providerConnection = { providerId: "openai-compatible", providerKind: "openai-compatible" as const,
  model: "same-model", endpoint: "https://provider.invalid/chat/completions", accountId: "test:original-account" };
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 300000, maxCalls: 10, maxSteps: 10, maxPromptChars: 100000 };
const subject = { plane: "agent" as const, domain: "prompt" as const, issueId: "issue:original-condition" };

function originalIntent(): CentralLearningIntentDraft {
  return { intentId: "intent:original-condition", subject, goal: "Identify the original missing condition",
    rationale: "The original source leaves the applicability condition unresolved", conditions: ["The source remains applicable"],
    knowledge: [], residual: ["The applicability condition remains unknown"], sourceRefs: [sourceRef],
    commitment: { purpose: "Resolve the original uncertainty", assumptions: ["The original source is authoritative"],
      reconsiderWhen: ["The original condition changes"] }, revisionReason: "Continue the original open purpose",
    continuation: { kind: "ready", operation: { kind: "think", operationId: "thought:original-condition",
      purpose: "Resolve the original applicability condition", expectedChange: "Choose the next useful original-source inquiry", sourceRefs: [sourceRef] } } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, refusal: "rate_limit" | "quota") {
  const parent = testScratchPath("central-provider-recovery");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  let clock = Date.parse("2026-11-05T03:00:00.000Z"), fetchCalls = 0, management = 0;
  const now = () => new Date(clock).toISOString(), enabled = () => true;
  const ready = await ensureCentralLearningBudget({ boardRoot, scope, allowance, authorizationRef: "host:original-root", now, enabled });

  assert.ok(ready.ok, JSON.stringify(ready));
  let configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "connection:original",
    providerConnectionRef: centralLearningProviderConnectionRef(providerConnection), authorizationRef: "host:original-root", allowance, rootRef: ready.rootRef,
    generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 } };
  const store = createCentralRuntimeStore({ boardRoot, enabled }), before = await store.read(scope);
  const material = { ref: sourceRef, kind: "source" as const, text: "The original applicability condition is unresolved.", sourceRefs: [sourceRef] };
  const seeded = await store.append({ expectedRevision: before.revision, previousRef: before.stateRef,
    state: { ...before.state, intents: [originalIntent()], materials: [material] }, reason: "test_original_open_purpose", sourceRefs: [sourceRef] });

  assert.equal(seeded.status, "written");
  const requests: CentralDeliberationRequest[] = [], failures: CentralDeliberationError[] = [];
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: ready.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:original-owner" }, enabled, now });
  const source: CentralRuntimeSourcePort = { async snapshot() {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return { boardSequence: loaded.state.sequence, opportunities: [{ subject, sourceRef, description: material.text, constraints: [] }],
      materials: [material], sourceRefs: [sourceRef] };
  }, async read() { throw new Error("This communication recovery does not run a domain inquiry"); } };
  const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No consultation requested"); },
    async prepare() { throw new Error("No domain dispatch requested"); }, async execute() { throw new Error("No worker requested"); },
    async recover() { return null; } };
  const makeDriver = () => {
    const provider = createOpenAiCompatibleProvider({ endpoint: providerConnection.endpoint, model: providerConnection.model,
      apiKey: "test-only-key", maxAttemptsBeforeHeaders: 1, fetchImpl: async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ error: { code: refusal === "quota" ? "insufficient_quota" : "rate_limit_exceeded" } }),
          { status: 429, headers: refusal === "quota" ? {} : { "Retry-After": "1" } });
      } });
    const model = createCentralModelDeliberation({ provider, model: providerConnection.model, funding, enabled, secrets: ["test-only-key"] });

    return createCentralLearningDriver({ boardRoot, scope, source, execution, enabled, now,
      deliberation: { ...model, async selectAutomaticOutput() { return 4096; }, async deliberate(request, signal) {
        requests.push(request);
        try { return await model.deliberate(request, signal); }
        catch (error) {
          if (error instanceof CentralDeliberationError) failures.push(error);
          throw error;
        }
      } }, semanticRecoveryDelayMs: 25 });
  };
  const increaseRoot = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    const root = loaded.state.centralLearningBudgets!.find(row => row.budgetId === ready.rootRef.budgetId)!;
    const changed = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: `test:increase:${++management}`,
      issuedAt: now(), action: { kind: "set_budget_limit", budgetId: root.budgetId, expectedSequence: loaded.state.sequence,
        changeId: `test:increase:${management}`, authorizationRef: "host:explicit-increase",
        limits: { tokens: root.limits.tokens + 1000, calls: root.limits.calls + 1, steps: root.limits.steps + 1 } } }));

    assert.ok(changed.ok, JSON.stringify(changed));
  };
  const addLocalWait = async () => {
    const current = await store.read(scope), inspected = await funding.inspect();
    assert.ok(inspected.ok);
    // Match an already-running domain's returned resource block; this fixture
    // does not launch another worker or introduce an additional provider call.
    const condition = Object.assign(new Error("learning_budget_exhausted"), { failureClass: "resources" as const });
    const localWait = semanticRecoveryBlock("domain:already-running", condition, inspected.projection, configuration.configurationRef);
    const appended = await store.append({ expectedRevision: current.revision, previousRef: current.stateRef,
      state: { ...current.state, materials: [...current.state.materials, localWait] },
      reason: "test_already_running_domain_resource_returned", sourceRefs: [localWait.ref] });

    assert.equal(appended.status, "written");
  };
  const projection = async () => {
    const inspected = await funding.inspect();
    assert.ok(inspected.ok);
    return inspected.projection;
  };
  const account = async () => (await projection()).budget;
  const runOwner = () => {
    const driver = makeDriver(), mechanicalScope = { homeRoot: parent, workspaceRoot: boardRoot, scopeKey: "test:provider-recovery" };
    let saved: RuntimeIntent = { schemaVersion: 1, homeRoot: parent, workspaceRoot: boardRoot, enabled: true,
      configuration: {}, wakeSequence: 0, consumedSequence: 0, wakeReason: "test:start", sourceRefs: [sourceRef] };
    let returned = deferred<CentralLearningDriverProgress>();
    const timers: { run: () => void; delay: number; cancelled: boolean }[] = [];
    const owner = createCentralScopeOwner({ scope: mechanicalScope, ownerId: "test:scope-owner", intent: saved, now: () => clock,
      store: { owns: () => true, writeIntent(value) {
        assert.ok(isRuntimeIntent(value));
        saved = value;
        return { ok: true };
      } },

      schedule(run, delay) {
        const timer = { run, delay, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },

      driver: { async drive(input) {
        const result = await driver.drive({ scope, configuration, wake: input.wake, signal: input.signal,
          publish(value) { input.publish({ ...value, message: value.reason }); } });
        returned.resolve(result);
        return result;
      }, close: () => driver.close?.() ?? Promise.resolve() } });

    t.after(() => owner.close());

    return { owner, async result() {
      const result = await returned.promise;
      await nextTurn();
      returned = deferred();
      return result;
    },

      timer() {
        const timer = [...timers].reverse().find(row => !row.cancelled);
        assert.ok(timer);
        return timer;
      },

      activeTimers: () => timers.filter(row => !row.cancelled).length,
      wake() { assert.ok(owner.wake({ reason: "test:actual-source-wake", sourceRefs: [sourceRef] }).ok); },
      consumed: () => saved.consumedSequence === saved.wakeSequence };
  };

  return { get configuration() { return configuration; }, store, requests, failures, runOwner, increaseRoot, addLocalWait, account, projection,
    changeLocalConfiguration() { configuration = { ...configuration, configurationRef: "connection:local-operation-change",
      allowance: { ...configuration.allowance, maxPromptChars: 99999 } }; },
    changeProviderConnection() { configuration = { ...configuration, configurationRef: "connection:provider-change",
      providerConnectionRef: centralLearningProviderConnectionRef({ ...providerConnection, accountId: "test:replacement-account" }) }; }, fetchCalls: () => fetchCalls,
    time: () => clock, advance: (milliseconds: number) => { clock += milliseconds; } };
}

test("typed HTTP rate limit survives restart and root increase, then the original owner timer funds one same-purpose attempt and stops after refusal", { timeout: 15000 }, async t => {
  const f = await fixture(t, "rate_limit"), firstOwner = f.runOwner();
  firstOwner.owner.start();
  const first = await firstOwner.result(), deadline = f.time() + 1000;

  assert.equal(f.fetchCalls(), 1, JSON.stringify({ first, failures: f.failures.map(row => ({ reason: row.reason })) }));
  assert.deepEqual(f.failures[0]?.providerFailure, { class: "rate_limit", retryable: true,
    recovery: { kind: "after", delayMs: 1000, source: "retry_after" } });
  assert.equal(first.wakeAt, deadline);
  const originalRoot = await f.account(), originalReceipt = structuredClone(originalRoot.accounting![0]!);

  assert.equal(originalReceipt.state, "settled");
  assert.equal(originalReceipt.usage?.kind, "unknown");
  assert.equal(originalRoot.accounting!.length, 1);
  const persisted = await f.store.read(scope), wait = persisted.state.materials.find(row =>
    row.ref.startsWith("central-semantic-recovery-blocked:") || row.ref.startsWith("central-provider-"));

  assert.ok(wait);
  assert.equal(JSON.parse(wait.text).providerRecovery.at, deadline);
  await firstOwner.owner.close();
  f.advance(250);
  const resumed = f.runOwner();
  resumed.owner.start();
  assert.equal((await resumed.result()).wakeAt, deadline, "restart retains the absolute deadline instead of adding Retry-After again");
  f.changeLocalConfiguration();
  resumed.wake();
  assert.equal((await resumed.result()).wakeAt, deadline, "a local operation or User configuration change does not change the provider connection");
  assert.equal(f.fetchCalls(), 1);
  await f.addLocalWait();
  await f.increaseRoot();
  resumed.wake();
  assert.equal((await resumed.result()).wakeAt, deadline);
  assert.equal(f.fetchCalls(), 1, "root funds do not prove provider recovery");
  f.advance(749);
  const earlyTimer = resumed.timer();
  earlyTimer.cancelled = true;
  earlyTimer.run();
  await nextTurn();
  assert.equal(f.fetchCalls(), 1);
  assert.equal(resumed.timer().delay, 1);
  f.advance(1);
  const dueTimer = resumed.timer();
  dueTimer.cancelled = true;
  dueTimer.run();
  const refused = await resumed.result();
  assert.equal(refused.reason, "provider_recovery_exhausted");
  assert.equal(refused.wakeAt, undefined);
  assert.equal(f.fetchCalls(), 2);
  assert.equal(resumed.activeTimers(), 0);
  assert.ok(resumed.consumed());
  assert.equal(f.requests[1]!.operation.purpose, f.requests[0]!.operation.purpose);
  assert.notEqual(f.requests[1]!.operation.operationId, f.requests[0]!.operation.operationId);
  assert.equal(f.requests[0]!.operation.kind === "think" && f.requests[0]!.operation.maxOutputTokens, undefined,
    "the model-owned original keeps its generation policy");
  assert.equal(f.requests[1]!.operation.kind === "think" && f.requests[1]!.operation.maxOutputTokens, 4096,
    "a new host recovery is sized even when it retains the original learning intent");
  const spent = await f.account();
  assert.equal(spent.budgetId, originalRoot.budgetId);
  assert.equal(spent.accounting!.length, 2);
  assert.deepEqual(spent.accounting![0], originalReceipt);
  assert.notEqual(spent.accounting![1]!.reservationId, originalReceipt.reservationId);
  const completed = (await f.store.read(scope)).state.completed;

  assert.deepEqual(completed.map(row => row.intentId), ["intent:original-condition", "intent:original-condition"]);
  f.advance(100000);
  resumed.wake();
  assert.equal((await resumed.result()).reason, "provider_recovery_exhausted");
  assert.equal(f.fetchCalls(), 2);
  assert.equal(resumed.activeTimers(), 0);
  const archived = await f.store.read(scope);
  const historical = semanticResourceCondition({ ...archived.state, materials: [wait], completed: [archived.state.completed[0]!] },
    await f.projection(), f.configuration.configurationRef, f.time(), archived.history, f.configuration.providerConnectionRef);

  assert.equal(historical.blocked, true);
  assert.equal(historical.reason, "provider_recovery_exhausted");
  assert.equal(historical.recovery, undefined, "archiving the failed recovery row cannot issue its already-recorded operation again");
  f.changeProviderConnection();
  const { providerConnectionRef: _connection, ...legacyBody } = JSON.parse(wait.text);
  const legacy = semanticResourceCondition({ ...archived.state, materials: [{ ...wait, text: JSON.stringify(legacyBody) }],
    completed: [archived.state.completed[0]!] }, await f.projection(), f.configuration.configurationRef,
    f.time(), archived.history, f.configuration.providerConnectionRef);

  assert.equal(legacy.blocked, true);
  assert.equal(legacy.reason, "provider_recovery_exhausted");
  assert.equal(legacy.recovery, undefined, "an old missing connection identity cannot prove a provider change");
  resumed.wake();
  const changed = await resumed.result();
  assert.equal(f.fetchCalls(), 3);
  assert.equal(changed.wakeAt, f.time() + 1000);
  resumed.wake();
  assert.equal((await resumed.result()).wakeAt, changed.wakeAt);
  assert.equal(f.fetchCalls(), 3);
  const newConnectionRoot = await f.account();
  assert.equal(newConnectionRoot.budgetId, originalRoot.budgetId);
  assert.equal(newConnectionRoot.accounting!.length, 3);
  assert.deepEqual(newConnectionRoot.accounting![0], originalReceipt);
});

test("quota without a provider reset hint remains blocked after time and a real original-root increase", { timeout: 15000 }, async t => {
  const f = await fixture(t, "quota"), run = f.runOwner();
  run.owner.start();
  const first = await run.result();
  assert.equal(first.wakeAt, undefined);
  assert.equal(run.activeTimers(), 0);
  assert.equal(f.failures[0]?.providerFailure?.class, "quota", JSON.stringify({ first, calls: f.fetchCalls(), failures: f.failures.map(row => ({ reason: row.reason, providerFailure: row.providerFailure })) }));
  assert.equal(f.failures[0]?.providerFailure?.recovery, undefined);
  const originalReceipt = structuredClone((await f.account()).accounting![0]!);

  f.advance(100000);
  await f.increaseRoot();
  run.wake();
  const unchanged = await run.result();
  assert.equal(unchanged.wakeAt, undefined);
  assert.equal(run.activeTimers(), 0);
  assert.equal(f.fetchCalls(), 1);
  assert.deepEqual((await f.account()).accounting, [originalReceipt]);
});
