import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createWorkflowImprovementRuntime } from "../runtime/improvement-runtime.js";
import { createWorkflowImprovementTools } from "./improvement-tools.js";
import { deferred, resultRecord, runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";
import { record } from "../domain/trace-parse.js";

for (const operation of ["opportunity", "context", "feedback"] as const) test(`cancelling a workflow ${operation} during its read prevents later learning commits and paid work`, async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot), reading = deferred<void>(), release = deferred<void>();
  let report: JsonObject = JSON.parse(JSON.stringify(fx.fixture.opportunity));

  if (operation !== "opportunity") {
    resultRecord(await fx.runtime.opportunity("seed", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    report = { task: JSON.parse(JSON.stringify(fx.fixture.opportunity.task)), boundary: "before actual work" };

    if (operation === "feedback") {
      const frozen = resultRecord(await fx.runtime.context("adopt", report));
      assert.ok(record(frozen.use));
      fx.state.snapshot = { ...fx.state.snapshot, executionId: "session:contract/actual", watermark: 120,
        receipts: [{ ref: "actual-receipt", sequence: 110, executionId: "session:contract/actual", toolCallId: "read", tool: "read_file", outcome: "succeeded" }] };
      report = { useId: String(frozen.use.useId), exposure: "reported_used", evidenceRefs: ["actual-receipt"],
        followedStepIds: ["confirm-owner"], explanation: "Actual use with an unknown quality result" };
    }
  }

  const before = await fx.ports.store.read();
  assert.ok(before.ok);
  const runtime = createWorkflowImprovementRuntime({ ...fx.options, ...fx.ports, store: { ...fx.ports.store,
    async read() {
      reading.resolve();
      await release.promise;
      return fx.ports.store.read();
    } } });
  const cancel = new AbortController();

  try {
    const pending = createWorkflowImprovementTools(runtime).execute({ toolCallId: "cancelled-operation", name: "workflow_learning",
      arguments: { operation, report } }, cancel.signal);

    await reading.promise;
    cancel.abort();
    release.resolve();
    const outcome = await pending;
    await runtime.settlePending();
    const after = await fx.ports.store.read();
    assert.ok(after.ok);
    assert.equal(fx.calls(), operation === "opportunity" ? 0 : 1);
    assert.equal(after.value.uses.length, before.value.uses.length);
    assert.equal(after.value.feedback.length, before.value.feedback.length);
    assert.equal(outcome.outcome, "cancelled");

    if (operation === "opportunity") {
      const state = await createBoardReader(boardRoot).load();
      assert.ok(state.ok);
      assert.equal(state.state.centralLearningGrants?.length ?? 0, 0);
    }
  } finally {
    release.resolve();
    await runtime.close();
    await fx.runtime.close();
  }
}));
