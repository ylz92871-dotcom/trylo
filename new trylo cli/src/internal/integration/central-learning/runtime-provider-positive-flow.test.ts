import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralLearningIntentDraft, CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { ProviderWaitObservation } from "../../learning/central/runtime/provider-positive.js";
import { createCentralRuntimeMaterials } from "../../surface/cli/central-runtime-materials.js";
import { centralLearningProviderConnectionRef } from "../../surface/cli/central-learning-model.js";
import type { CliContext } from "../../surface/cli/context.js";
import { methodBoardRoot } from "../../surface/cli/learning-sink.js";
import { createParentProviderReturnObserver } from "../../surface/cli/provider-return-observer.js";
import { sessionPath } from "../../surface/cli/session-paths.js";
import { createTurnRecorder } from "../../surface/cli/turn-recorder.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { createCentralModelDeliberation, CentralDeliberationError } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot, CentralDeliberationReceiptError, type CentralDeliberationReceiptsPort } from "./deliberation-receipts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { latestProviderWait, providerWaitForPositiveObservation, selectProviderPositiveAdmission } from "./runtime-provider-positive.js";
import { semanticResourceCondition } from "./runtime-recovery.js";
import { createCentralRuntimeStore } from "./runtime-store.js";

const connection = { providerId: "openai-compatible", providerKind: "openai-compatible" as const,
  model: "same-model", endpoint: "https://provider.invalid/chat/completions", accountId: "test:original-account" };
const sourceRef = "report:original-condition", workspaceId = "workspace:provider-positive-flow";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 300000, maxCalls: 10, maxSteps: 10, maxPromptChars: 100000 };

function localContext(root: string, clock: () => number): CliContext {
  return { homeDir: root, cwd: path.join(root, "workspace"), env: { TRYLO_HOME: path.join(root, "home") },
    nodeVersion: "v24.0.0", stdinIsTty: false, now: clock, newId: prefix => `${prefix}-local-flow`,
    readFile(file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } },

    readDir(directory) { try { return readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }); } catch { return []; } },

    writeFile(file, value) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },

    stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };
}

function sse(text: string): Response {
  const frames = [{ choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

for (const outcome of ["complete_rejection", "network_failure", "accepted_receipt_ack_unknown"] as const) test(`a natural same-connection PA return admits one fresh central computation: ${outcome}`, { timeout: 20000 }, async t => {
  const base = testScratchPath("central-provider-positive-flow");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-"));
  assert.ok(!path.relative(base, root).startsWith(".."));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-06T03:00:00.000Z"), centralCalls = 0, paCalls = 0;
  const ctx = localContext(root, () => clock), scope = ctx.cwd, boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const now = () => new Date(clock).toISOString(), enabled = () => true, signal = new AbortController().signal;
  const subject = { plane: "agent" as const, domain: "prompt" as const, issueId: "issue:original-condition" };
  const material = { ref: sourceRef, kind: "source" as const, text: "The original applicability condition is unresolved.", sourceRefs: [sourceRef] };
  const reported = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "report:original", issuedAt: now(),
    action: { kind: "report", scope, issueId: subject.issueId, problemKey: "original-condition", report: { reportId: sourceRef,
      source: { subsystem: "method", taskId: "task:original", versionId: "method:original" }, facts: [material.text], evidenceRefs: [sourceRef] } } }));

  assert.ok(reported.ok, JSON.stringify(reported));
  const ready = await ensureCentralLearningBudget({ boardRoot, scope, allowance, authorizationRef: "host:original-root", now, enabled });

  assert.ok(ready.ok, JSON.stringify(ready));
  if (!ready.ok) return;

  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "connection:original",
    providerConnectionRef: centralLearningProviderConnectionRef(connection), authorizationRef: "host:original-root", allowance, rootRef: ready.rootRef };
  const store = createCentralRuntimeStore({ boardRoot, enabled }), before = await store.read(scope);
  const intent: CentralLearningIntentDraft = { intentId: "intent:original-condition", subject, goal: "Identify the missing applicability condition",
    rationale: "The original report leaves this condition unresolved", conditions: [], knowledge: [], residual: ["The applicability condition is unknown"],
    commitment: { purpose: "Resolve the original uncertainty", assumptions: [], reconsiderWhen: ["Actual original evidence changes"] },
    revisionReason: "The original report establishes an open purpose", sourceRefs: [sourceRef], continuation: { kind: "ready", operation: {
      kind: "think", operationId: "thought:original-condition", purpose: "Resolve the original applicability condition",
      expectedChange: "Choose a useful original-source inquiry", sourceRefs: [sourceRef] } } };

  assert.equal((await store.append({ expectedRevision: before.revision, previousRef: before.stateRef,
    state: { ...before.state, intents: [intent], materials: [material] }, reason: "Original report establishes an open purpose", sourceRefs: [sourceRef] })).status, "written");
  const business = createCentralRuntimeMaterials({ ctx, workspaceId, enabled });
  const source: CentralRuntimeSourcePort = { async snapshot(requestedScope, cancellation, query) {
    const actual = await business.snapshot(requestedScope, cancellation, query);
    return { ...actual, opportunities: [{ subject, sourceRef, description: material.text, constraints: [] }],
      materials: [material, ...actual.materials], sourceRefs: [sourceRef, ...actual.sourceRefs] };
  }, read: (...args) => business.read(...args) };
  const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No domain consultation belongs to this flow"); },
    async prepare() { throw new Error("No domain dispatch belongs to this flow"); }, async execute() { throw new Error("No worker belongs to this flow"); },
    async recover() { return null; } };
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: ready.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:original-owner" }, enabled, now });
  const failures: CentralDeliberationError[] = [], requests: CentralDeliberationRequest[] = [];
  const originalReceipts = () => createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId: ready.rootRef.budgetId, enabled,
    secrets: ["local-only-key"] });
  let lostAcknowledgements = 0, committedDeliveryRef: string | undefined;
  const inspectedReceiptOperations: string[] = [];
  const receipts: CentralDeliberationReceiptsPort = {
    async read(operationId, cancellation) {
      inspectedReceiptOperations.push(operationId);
      return originalReceipts().read(operationId, cancellation);
    },

    async save(value, cancellation) {
      const saved = await originalReceipts().save(value, cancellation);
      committedDeliveryRef = saved.deliveryRef;
      if (lostAcknowledgements === 0) {
        lostAcknowledgements += 1;
        throw new CentralDeliberationReceiptError("central_deliberation_receipt_write_unconfirmed");
      }
      return saved;
    },
  };
  const provider = createOpenAiCompatibleProvider({ endpoint: connection.endpoint, model: connection.model, apiKey: "local-only-key",
    responseFormats: ["json_object"], maxAttemptsBeforeHeaders: 1, fetchImpl: async (_url, init) => {
      centralCalls += 1;

      if (centralCalls <= 2) return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "Retry-After": "1" } });

      assert.equal(centralCalls, 3, "the same receipt cannot purchase another computation");

      if (outcome === "network_failure") throw new TypeError("The local fake fetch encountered a real transport exception");

      if (outcome === "accepted_receipt_ack_unknown") {
        const wire = JSON.parse(String(init?.body));
        const views = wire.messages.flatMap((message: { readonly role: string; readonly content: string }) => {
          if (message.role !== "user" || !message.content.startsWith("{")) return [];
          const value = JSON.parse(message.content);
          return value.role === "central_learning_public_input" ? [value] : [];
        });

        assert.equal(views.length, 1);
        const view = views[0];
        assert.equal(typeof view.checkpoint, "string");
        const source = view.materials.find((item: { readonly delivery: string; readonly kind: string }) => item.delivery === "body" && item.kind === "source");

        assert.ok(source);
        assert.equal(typeof source.handle, "string");

        return sse(JSON.stringify({ checkpoint: view.checkpoint, changes: [], explanation: "Wait for actual use.", sources: [source.handle] }));
      }

      return sse("This clean complete response is invalid JSON.");
    } });
  const model = createCentralModelDeliberation({ provider, model: connection.model, funding, enabled, maxOutputTokens: 512, secrets: ["local-only-key"],
    ...(outcome === "accepted_receipt_ack_unknown" ? { receipts } : {}) });
  const makeDriver = () => createCentralLearningDriver({ boardRoot, scope, source, execution, enabled, now, semanticRecoveryDelayMs: 25,
    deliberation: { ...model, async deliberate(request, cancellation, constraints) {
      requests.push(request);
      try { return await model.deliberate(request, cancellation, constraints); }
      catch (error) {
        if (error instanceof CentralDeliberationError) failures.push(error);
        throw error;
      }
    } } });
  const driver = makeDriver();
  t.after(() => driver.close?.());
  const input: CentralLearningDriveInput = { scope, configuration, wake: { reason: "normal_entry", sourceRefs: [sourceRef] }, signal, publish() {} };
  const first = await driver.drive(input);
  assert.equal(centralCalls, 1);
  assert.equal(first.wakeAt, clock + 1000);
  clock += 1000;
  const exhausted = await driver.drive(input);
  assert.equal(centralCalls, 2);
  assert.equal(exhausted.reason, "provider_recovery_exhausted");
  assert.equal(exhausted.wakeAt, undefined);
  assert.ok(exhausted.providerWait);
  assert.equal((await driver.drive(input)).reason, "provider_recovery_exhausted");
  assert.equal(centralCalls, 2);
  const descriptor = exhausted.providerWait!;

  assert.equal(descriptor.connectionRef, configuration.providerConnectionRef);
  assert.equal(descriptor.budgetId, ready.rootRef.budgetId);
  const inspected = await funding.inspect();
  assert.ok(inspected.ok);
  if (!inspected.ok) return;

  const oldCharges = structuredClone(inspected.projection.budget.accounting!);

  assert.equal(oldCharges.length, 2);
  assert.ok(oldCharges.every(row => row.state === "settled" && row.usage?.kind === "unknown"));
  assert.equal(failures[0]?.providerFailure?.class, "rate_limit");
  assert.equal(failures[1]?.providerFailure?.class, "rate_limit");

  const sessionId = "normal-positive", turnId = "ordinary-turn", session = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  t.after(() => session.release());
  assert.ok((await session.start({ sessionId, createdAt: now(), fingerprint: { schemaVersion: "1", workspaceId,
    providerId: connection.providerId, model: connection.model, toolCatalogHash: "ordinary-catalog" } })).ok);
  const capture: ProviderWaitObservation = { schemaVersion: 1, ...descriptor, sessionId, turnId, model: connection.model };
  const observer = createParentProviderReturnObserver({ sessionId, turnId, providerWaitObservation: capture });
  const recorder = createTurnRecorder({ session, sessionId, turnId, now: () => clock,
    ...(observer.capture === undefined ? {} : { providerWaitObservation: observer.capture }), readProviderReturnObservation: observer.read });

  assert.ok(recorder);
  await recorder.start({ startedAt: clock, toolCatalogHash: "ordinary-catalog" });
  const userText = "Review the actual interface boundary before changing the handoff.";

  assert.ok((await recorder.session.append({ type: "turn_input", sessionId, turnId, at: now(), payload: { text: userText } })).ok);
  const pa = observer.wrap(createOpenAiCompatibleProvider({ endpoint: connection.endpoint, model: connection.model, apiKey: "local-only-key",
    maxAttemptsBeforeHeaders: 1, fetchImpl: async (_url, init) => { paCalls += 1;
      const wire = JSON.parse(String(init?.body));
    assert.equal(wire.stream_options?.include_usage, true);
      return sse("The ordinary interface boundary has one explicit reviewer and a documented handoff."); } }));
  let answer = "";

  for await (const event of pa.stream({ attemptId: "ordinary-attempt", model: connection.model,
    messages: [{ role: "user", content: userText }], tools: [] }, signal)) {
    assert.notEqual(event.type, "error");
    if (event.type === "text_delta") answer += event.text;
  }

  assert.equal(paCalls, 1);
  assert.ok(observer.read());
  assert.ok((await recorder.progress.flush({ transcript: [{ kind: "assistant_text", sequence: 0, blockId: "ordinary-answer", text: answer }], envelopes: [] })).ok);
  clock += 1;
  await recorder.finish({ status: "completed", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  const originalJournal = await session.readRecords();
  assert.ok(originalJournal.ok);
  if (!originalJournal.ok) return;

  const terminal = originalJournal.view.records.at(-1)!;
  assert.equal(terminal.type, "terminal");
  assert.ok(terminal.payload.providerReturnObservation);
  const snapshot = await business.snapshot(scope, signal);
  assert.equal(snapshot.providerPositiveNotes?.length, 1);
  const note = snapshot.providerPositiveNotes[0]!;

  assert.equal(note.capture.wait.ref, descriptor.wait.ref);
  assert.deepEqual(note.returned, observer.read());
  assert.ok(snapshot.sourceRefs.length > 0);
  assert.ok(snapshot.materials.some(row => row.text.includes(userText)));
  assert.equal(JSON.stringify(snapshot.materials).includes("providerReturnObservation"), false);
  const returned = await driver.drive(input);
  assert.equal(centralCalls, 3, JSON.stringify(returned));
  assert.equal(failures.at(-1)?.delivery, outcome === "complete_rejection" ? "returned" : "unknown");
  assert.equal(model.receipts().at(-1)?.response, outcome === "complete_rejection" ? "rejected"
    : outcome === "network_failure" ? "unavailable" : "accepted");
  assert.equal(returned.wakeAt, undefined);

  if (outcome === "complete_rejection") {
    assert.notEqual(returned.reason, "provider_recovery_exhausted");
    assert.equal(returned.providerWait, undefined, "the completed contract rejection retires its old provider wait");
  } else if (outcome === "network_failure") {
    assert.equal(failures.at(-1)?.providerFailure?.class, "network");
    assert.equal(returned.reason, "provider_recovery_exhausted");
    assert.ok(returned.providerWait);
    assert.notEqual(returned.providerWait.wait.ref, descriptor.wait.ref);
  } else {
    assert.equal(failures.at(-1)?.reason, "central_deliberation_response_write_unconfirmed");
    assert.equal(failures.at(-1)?.failureClass, "accounting");
    assert.match(returned.reason, /^central_deliberation_response_write_unconfirmed/);
    assert.equal(lostAcknowledgements, 1);
    assert.ok(committedDeliveryRef);
  }

  assert.ok(requests[2]!.operation.sourceRefs.some(ref => snapshot.sourceRefs.includes(ref)), "the new computation is selected by actual fresh business input");
  const settled = await funding.inspect();
  assert.ok(settled.ok);
  if (!settled.ok) return;

  assert.equal(settled.projection.budget.budgetId, ready.rootRef.budgetId);
  assert.deepEqual(settled.projection.budget.accounting!.slice(0, 2), oldCharges);
  assert.equal(settled.projection.budget.accounting!.length, 3);
  assert.equal(settled.projection.budget.accounting![2]!.usage?.kind, outcome === "network_failure" ? "unknown" : "reported");
  const cold = await createCentralRuntimeStore({ boardRoot, enabled }).read(scope);
  let gateCursor = cold;

  assert.equal(cold.history.providerPositiveAdmissions?.length, 1);
  assert.equal(cold.history.providerPositiveAdmissions[0]!.admission.noteRef, note.ref);
  const gate = semanticResourceCondition(cold.state, settled.projection, configuration.configurationRef, clock, cold.history, configuration.providerConnectionRef, configuration);

  if (outcome === "complete_rejection") {
    assert.ok(cold.history.retiredProviderWaitRefs?.includes(descriptor.wait.ref));
    assert.equal(latestProviderWait(cold.state, cold.history)?.ref, descriptor.wait.ref, "the latest retired original remains a tombstone over older waits");
    assert.equal(providerWaitForPositiveObservation(cold.state, cold.history, configuration.providerConnectionRef!, ready.rootRef.budgetId, cold.revision), undefined);
    assert.ok(!gate.reason?.startsWith("provider_"), "a contract rejection remains separate from the retired provider gate");
  } else if (outcome === "network_failure") {
    assert.ok(!cold.history.retiredProviderWaitRefs?.includes(descriptor.wait.ref), "a transport failure never proves the old wait recovered");
    const newest = latestProviderWait(cold.state, cold.history), locator = cold.history.materials.find(row => row.ref === newest?.ref);

    assert.ok(newest && locator?.sequence !== undefined);
    assert.equal(newest.ref, returned.providerWait!.wait.ref);
    assert.equal(note.capture.wait.ref, descriptor.wait.ref);
    assert.notEqual(note.capture.wait.ref, newest.ref);
    assert.equal(selectProviderPositiveAdmission({ state: cold.state, history: cold.history, scope, budgetId: ready.rootRef.budgetId,
      connectionRef: configuration.providerConnectionRef!, boardSequence: cold.revision, now: clock,
      wait: { material: newest, factRef: locator.factRef, sequence: locator.sequence }, selectedOperation: {
        kind: "think", operationId: "thought:requires-a-new-natural-note", purpose: "Read the actual changed condition",
        expectedChange: "Resolve a fresh original question", sourceRefs: snapshot.sourceRefs },
      freshBusinessRefs: snapshot.sourceRefs, notes: snapshot.providerPositiveNotes }), undefined,
    "the actual old normal receipt cannot authorize a different newer wait");
    assert.equal(gate.blocked, true);
    assert.equal(gate.reason, "provider_recovery_exhausted");
    assert.equal(gate.wakeAt, undefined);
  } else {
    const operationId = requests[2]!.operation.operationId;

    assert.equal(cold.state.completed.find(row => row.operation.operationId === operationId)?.outcome, "unknown",
      "a committed receipt with lost acknowledgement stays inspectable instead of being mislabeled failed by the old provider gate");
    assert.ok(!cold.history.retiredProviderWaitRefs?.includes(descriptor.wait.ref));
    const original = await originalReceipts().read(operationId, signal);

    assert.ok(original);
    assert.equal(original.deliveryRef, committedDeliveryRef);
    assert.deepEqual(original.request.operation, requests[2]!.operation);
    assert.equal(gate.reason, "provider_recovery_exhausted", "the old wait remains durable until original receipt recovery confirms return");
  }

  await driver.close?.();
  const restarted = makeDriver();
  t.after(() => restarted.close?.());
  const receiptReadsBeforeRecovery = inspectedReceiptOperations.length;
  const repeat = await restarted.drive(input);
  assert.equal(centralCalls, 3);
  assert.equal(repeat.wakeAt, undefined);

  if (outcome === "accepted_receipt_ack_unknown") {
    gateCursor = await createCentralRuntimeStore({ boardRoot, enabled }).read(scope);
    const operationId = requests[2]!.operation.operationId;

    assert.ok(inspectedReceiptOperations.slice(receiptReadsBeforeRecovery).includes(operationId), "cold recovery inspects the original accepted receipt");
    assert.equal(gateCursor.state.completed.find(row => row.operation.operationId === operationId)?.outcome, "returned");
    assert.ok(gateCursor.history.retiredProviderWaitRefs?.includes(descriptor.wait.ref));
    assert.equal(providerWaitForPositiveObservation(gateCursor.state, gateCursor.history, configuration.providerConnectionRef!, ready.rootRef.budgetId, gateCursor.revision), undefined);
    const afterRecovery = await funding.inspect();
    assert.ok(afterRecovery.ok);
    if (!afterRecovery.ok) return;

    assert.deepEqual(afterRecovery.projection.budget.accounting, settled.projection.budget.accounting,
      "receipt recovery neither refunds old unknown fees nor settles or purchases the third reported operation again");
    assert.equal(lostAcknowledgements, 1);
  }

  clock += 100000;
  const later = await restarted.drive(input);
  assert.equal(centralCalls, 3);
  assert.equal(later.wakeAt, undefined);
  assert.equal(paCalls, 1);
  assert.equal((await store.read(scope)).history.providerPositiveAdmissions?.length, 1);
  assert.ok((await recorder.session.append({ type: "turn_input", sessionId, turnId: "later-original-question", at: now(),
    payload: { text: "The original reviewer changed; inspect the actual new boundary before continuing." } })).ok);
  const fresh = await business.snapshot(scope, signal), freshRefs = fresh.sourceRefs.filter(ref => !snapshot.sourceRefs.includes(ref));

  assert.ok(freshRefs.length > 0, "a later real ordinary question supplies distinct original business input");
  const freshGate = semanticResourceCondition(gateCursor.state, settled.projection, configuration.configurationRef, clock,
    gateCursor.history, configuration.providerConnectionRef, { ...configuration, researchSourceRefs: freshRefs, operation: {
      kind: "think", operationId: "thought:later-original-question", purpose: "Inspect the changed original boundary",
      expectedChange: "Reconsider the new original fact", sourceRefs: freshRefs } });

  if (outcome !== "network_failure") assert.ok(!freshGate.reason?.startsWith("provider_"), "new original input is not rejected by a resurrected older provider wait");
  else {
    assert.equal(freshGate.blocked, true);
    assert.equal(freshGate.reason, "provider_recovery_exhausted");
    assert.equal(freshGate.wakeAt, undefined, "new business input without a newer natural note cannot reopen the new provider wait");
  }

  assert.equal(centralCalls, 3, "the read-only gate assertion purchases no additional interpretation");
});
