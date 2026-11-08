import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { decodeLog } from "../../adapters/learning-store/codec.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { methodPayloadHash } from "../../learning/control/method-replay.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import { createCentralAccountingFundingAtRoot } from "./central-accounting-funding.js";

const scope = "workspace:funding-atomic", budgetId = "root:original", issuedAt = "2026-11-05T00:00:00.000Z";
const owner = { kind: "central_deliberation" as const, ownerId: "central:original" };

test("default reserve reads inside the original writer after a controlled ordinary PA receipt and grants one dispatch", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-funding-atomic-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^trylo-funding-atomic-/);
    await rm(root, { recursive: true, force: true });
  });
  let serial = 0;
  const initial = await withBoardWriter(root, async store => {
    const send = (action: CoordinationAction) => store.apply({ type: "coordinate_learning", commandId: `fixture:atomic:${++serial}`, issuedAt, action });

    assert.ok((await send({ kind: "report", scope, issueId: "issue:pa", problemKey: "original-pa-resource", report: { reportId: "report:pa",
      source: { teamRunId: "team:pa", taskId: "task:pa", memberId: "personal_agent" }, facts: ["Inspect the original resource"], evidenceRefs: [] } })).ok);
    assert.ok((await send({ kind: "decide", issueId: "issue:pa", expectedRevision: 1, decision: "focused_learning", reason: "Inspect the resource", sourceRefs: [] })).ok);
    assert.ok((await send({ kind: "fund", issueId: "issue:pa", expectedRevision: 2, grantId: "grant:pa", domain: "collaboration",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 } })).ok);
    // This original independent PA grant predates the managed root; it is not rebound or re-funded.
    const current = await store.load();
    assert.ok(current.ok);

    return send({ kind: "open_budget", expectedSequence: current.state.sequence, budget: { schemaVersion: 1, budgetId, scope,
      unit: "total_model_tokens", limits: { tokens: 1000, calls: 4, steps: 4 }, authorizationRef: "host:original-authorization" } });
  });
  assert.ok(initial.ok, JSON.stringify(initial));
  const original = centralBudgetProjection(initial.state, budgetId);
  assert.ok(original);
  const grant = initial.state.centralLearningGrants?.find(row => row.grantId === "grant:pa");
  assert.ok(grant);
  const trace: string[] = [];
  let held!: () => void, release!: () => void, checks = 0;
  const writerHeld = new Promise<void>(resolve => { held = resolve; }), mayWrite = new Promise<void>(resolve => { release = resolve; });
  const paWriter = withBoardWriter(root, async store => {
    trace.push("pa_writer_held");
    held();
    await mayWrite;
    const receipts = createCollaborationRuntimeReceiptWriter({ board: store, scope });
    const recorded = await receipts.record({ schemaVersion: 1, receiptId: "pa:before-reserve", phase: "resource_query", scope,
      issueId: grant.issueId, jobId: grant.jobId, grantId: grant.grantId, requestId: "pa:resource-query", owner: "experience",
      query: "Inspect the original personal-agent resource", resultRefs: [], summary: "Original PA resource query boundary",
      boundary: { executionId: "execution:pa", taskId: "task:pa", round: 1, role: "personal_agent" }, recordedAt: issuedAt });

    assert.ok(recorded.ok, JSON.stringify(recorded));
    trace.push("pa_receipt_appended");
    return recorded;
  });

  await writerHeld;

  try {
    const port = createCentralAccountingFundingAtRoot({ boardRoot: root, budgetId, scope, owner, now: () => issuedAt,

      enabled: () => {
        if (++checks === 2) {
        trace.push("release_pa_writer");
        release();
      }
        return true;
      } });
    const first = await port.reserve({ reservationId: "model:atomic", maxTokens: 300 });
    trace.push("reserve_returned");
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.status, "reserved");
    const duplicate = await port.reserve({ reservationId: "model:atomic", maxTokens: 300 });
    assert.ok(duplicate.ok);
    assert.equal(duplicate.status, "duplicate");
    assert.equal([first, duplicate].filter(receipt => receipt.status === "reserved").length, 1, "duplicate grants no second model dispatch right");
    const final = await createBoardReader(root).load();
    assert.ok(final.ok);
    const projection = centralBudgetProjection(final.state, budgetId);
    assert.ok(projection);

    for (const key of ["budgetId", "scope", "authorizationRef", "openedSequence", "limits"] as const) assert.deepEqual(projection.budget[key], original.budget[key]);

    assert.equal(final.state.centralLearningBudgets?.length, 1);
    assert.equal(projection.budget.accounting?.length, 1);
    assert.equal(projection.occupied.tokens, 300);
    assert.equal(projection.occupied.calls, 1);
    assert.equal(projection.occupied.steps, 1);
    const log = decodeLog(await readFile(path.join(root, "board-events.ndjson"), "utf8"));
    assert.ok(log.ok);
    const receiptPosition = log.records.findIndex(row => row.command.type === "record_collaboration_runtime" && row.command.receipt.receiptId === "pa:before-reserve");
    const reservationPosition = log.records.findIndex(row => row.command.type === "coordinate_learning" && row.command.action.kind === "reserve_budget_usage");

    assert.ok(receiptPosition >= 0 && reservationPosition > receiptPosition);
    const receiptRecord = log.records[receiptPosition]!, reservationRecord = log.records[reservationPosition]!;

    assert.ok(reservationRecord.command.type === "coordinate_learning" && reservationRecord.command.action.kind === "reserve_budget_usage");
    assert.equal(reservationRecord.command.action.expectedSequence, receiptRecord.events.at(-1)?.sequence);
    assert.equal(reservationRecord.command.commandId, `central-accounting:${contentHashOf(reservationRecord.command.action)}`);
    assert.equal(final.state.appliedCommands.find(row => row.commandId === reservationRecord.command.commandId)?.payloadHash,
      methodPayloadHash(reservationRecord.command));
    assert.equal(log.records.filter(row => row.command.type === "coordinate_learning" && row.command.action.kind === "reserve_budget_usage").length, 1);
    assert.ok(trace.indexOf("pa_receipt_appended") < trace.indexOf("reserve_returned"));
  } finally {
    release();
    await paWriter;
  }
});
