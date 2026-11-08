import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";

test("explicit scope resume admits the same registered unsent cancelled thought once through the original root", async t => {
  const parent = testScratchPath("central-cancel-admission");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  const scope = "workspace:original-cancelled-thought", sourceRef = "report:original-cancelled-thought";
  const issueId = "issue:original-cancelled-thought", now = () => "2026-11-06T00:00:00.000Z";
  let enabled = true, streams = 0;
  const original = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning",
    commandId: sourceRef, issuedAt: now(), action: { kind: "report", scope, issueId, problemKey: "method:original-question",
      report: { reportId: sourceRef, source: { subsystem: "method", taskId: "task:original", versionId: "method:original" },
        facts: ["The original applicability question is unresolved."], evidenceRefs: [sourceRef] } } }));

  assert.ok(original.ok);
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 200000, maxCalls: 8, maxSteps: 8, maxPromptChars: 50000 };
  const budget = await ensureCentralLearningBudget({ boardRoot, scope, allowance,
    authorizationRef: "user:original-learning-root", now, enabled: () => enabled });

  assert.ok(budget.ok);
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "config:original-cancel-resume",
    authorizationRef: "user:original-learning-root", allowance, rootRef: budget.rootRef };
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: budget.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: budget.rootRef.budgetId }, now, enabled: () => enabled });
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId: budget.rootRef.budgetId, enabled: () => enabled });
  const material = { ref: sourceRef, kind: "source" as const, text: "The original applicability question is unresolved.", sourceRefs: [] };
  const source: CentralRuntimeSourcePort = { async snapshot() {
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    return { boardSequence: board.state.sequence, opportunities: [{ subject: { plane: "agent", domain: "prompt", issueId },
      sourceRef, description: material.text, constraints: [] }], materials: [material], sourceRefs: [sourceRef] };
  }, async read() { throw new Error("Admission recovery adds no source read"); } };
  const execution: CentralRuntimeExecutionPort = {
    async consult() { throw new Error("No consultation was chosen"); },
    async prepare() { throw new Error("No dispatch was chosen"); },
    async execute() { throw new Error("No domain work was chosen"); }, async recover() { return null; },
  };
  const provider = (): ProviderPort => ({ responseFormats: ["json_object"], fork: () => provider(),

    async *stream(wire): AsyncGenerator<ProviderEvent> {
      streams += 1;
      assert.deepEqual(wire.tools, []);
      assert.equal(wire.responseFormat?.type, "json_object");
      const message = wire.messages.find(row => row.role === "user" && typeof row.content === "string"
        && row.content.includes('"checkpoint":'));

      assert.ok(message !== undefined && typeof message.content === "string");
      const view: unknown = JSON.parse(message.content);

      assert.ok(typeof view === "object" && view !== null && "checkpoint" in view && typeof view.checkpoint === "string");
      yield { type: "text_delta", blockId: "content:decision", text: canonicalJson({ checkpoint: view.checkpoint, changes: [],
        explanation: "Preserve the original unresolved question; no further operation is chosen." }) };
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 10,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 20 } };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } });
  const requests: CentralDeliberationRequest[] = [], stop = new AbortController();
  const make = (stage: "stop" | "resume") => {
    const model = createCentralModelDeliberation({ provider: provider(), model: "local-in-memory", outputMode: "json_object",
      funding, receipts, enabled: () => enabled, maxOutputTokens: 512 });
    const driver = createCentralLearningDriver({ boardRoot, scope, source, execution, now, enabled: () => enabled,
      deliberation: { ...model, async deliberate(request, signal, constraints) {
        requests.push(request);
        if (stage === "stop") stop.abort(); // Issued is already durable; reserve has not been entered.
        return model.deliberate(request, signal, constraints);
      } } });

    return { driver, model };
  };
  const input = (signal: AbortSignal, reason: string): CentralLearningDriveInput => ({ scope, configuration,
    signal, wake: { reason, sourceRefs: [sourceRef] }, publish() {} });
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const first = make("stop");
  await first.driver.drive(input(stop.signal, "original_source_available"));
  await first.driver.close?.();
  const failed = await store.read(scope), registered = failed.state.completed.at(-1);

  assert.ok(registered);
  assert.equal(registered.outcome, "unknown");
  assert.deepEqual(registered.resultRefs, []);
  const reservationId = centralDeliberationReservation({ scope, budgetId: budget.rootRef.budgetId,
    operationId: registered.operation.operationId });
  const block = failed.state.materials.find(row => row.ref.startsWith("central-semantic-recovery-blocked:")
    && row.sourceRefs.includes(registered.operation.operationId));

  assert.ok(block);
  const refusal: unknown = JSON.parse(block.text);

  assert.ok(typeof refusal === "object" && refusal !== null && "reason" in refusal && "failureClass" in refusal);
  assert.equal(refusal.reason, "central_deliberation_cancelled");
  assert.equal(refusal.failureClass, "cancelled");
  assert.equal("reservationId" in refusal, false);
  assert.equal(streams, 0);
  const unreserved = await funding.inspect();
  assert.ok(unreserved.ok);
  assert.equal(unreserved.projection.budget.accounting?.length ?? 0, 0);
  assert.equal(await receipts.read(registered.operation.operationId, new AbortController().signal), undefined);

  enabled = false;
  const paused = make("resume");
  await paused.driver.drive(input(new AbortController().signal, "ordinary_wake_while_stopped"));
  assert.equal((await store.read(scope)).stateRef, failed.stateRef);
  assert.equal(streams, 0);
  await paused.driver.close?.();
  // The existing upstream scope owner owns explicit resume/lease authority.
  // This driver test supplies its resulting enabled state and fresh signal.
  enabled = true;
  const resumed = make("resume"), signal = new AbortController().signal;
  const proof = await resumed.model.inspect!({ scope, budgetId: budget.rootRef.budgetId,
    operationId: registered.operation.operationId }, signal);

  assert.equal(proof.status, "not_sent");

  if (proof.status !== "not_sent") throw new Error("Original operation is not proved unsent");

  assert.equal(proof.admission?.ownerId, budget.rootRef.budgetId);
  assert.deepEqual(proof.admission?.rootRef, budget.rootRef);
  assert.equal(proof.admission?.reservationId, reservationId);
  await resumed.driver.drive(input(signal, "explicit_runtime_resume"));
  assert.equal(streams, 1, "the registered unsent operation must reach the normal funded provider exactly once");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.operation, registered.operation);
  const recovered = await store.read(scope);

  assert.equal(recovered.state.completed.find(row => row.operation.operationId === registered.operation.operationId)?.outcome, "returned");
  assert.equal(recovered.state.completed.filter(row => row.operation.operationId === registered.operation.operationId).length, 1);
  assert.equal(recovered.state.materials.some(row => row.ref === block.ref), false);
  assert.ok(recovered.history.materials.some(row => row.ref === block.ref), "original cancellation remains in verified history");
  const settled = await funding.inspect();
  assert.ok(settled.ok);
  assert.deepEqual(settled.projection.budget.limits, unreserved.projection.budget.limits);
  const accounting = settled.projection.budget.accounting ?? [];

  assert.equal(accounting.length, 1);
  assert.equal(accounting[0]!.reservationId, reservationId);
  const delivery = await receipts.read(registered.operation.operationId, signal);
  assert.ok(delivery);
  assert.deepEqual(delivery.request.operation, registered.operation);
  assert.equal((await resumed.model.inspect!({ scope, budgetId: budget.rootRef.budgetId,
    operationId: registered.operation.operationId }, signal)).status, "returned");
  await resumed.driver.drive(input(signal, "duplicate_explicit_runtime_resume"));
  assert.equal(streams, 1);
  assert.equal(requests.length, 2);
  const duplicate = await funding.inspect();
  assert.ok(duplicate.ok);
  assert.deepEqual(duplicate.projection.budget.accounting, accounting);
  await resumed.driver.close?.();
});

