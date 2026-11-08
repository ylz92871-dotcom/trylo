import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { createWorkflowImprovementFunding } from "./improvement-funding.js";

test("prepare is source-canonical and idempotent without funding or consuming its original run allowance", async t => {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-funding-prepare-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const fixture = searchImprovementFixture();
  const record = { type: "workflow_improvement_opportunity" as const, schemaVersion: 1 as const,
    opportunity: fixture.opportunity, evidence: fixture.evidence };
  const funding = createWorkflowImprovementFunding({ boardRoot, scope: fixture.opportunity.task.scope,
    budgetId: "explicit-run", allowance: 4096, now: () => 1793761200000 });
  const prepared = await funding.prepare(record);
  assert.ok(prepared.ok);
  const first = await createBoardReader(boardRoot).load();
  assert.ok(first.ok);
  assert.equal(first.state.centralLearningGrants?.length ?? 0, 0);
  assert.equal(first.state.assets.length, 1);
  const repeated = await funding.prepare(record);
  assert.ok(repeated.ok);
  const second = await createBoardReader(boardRoot).load();
  assert.ok(second.ok);
  assert.equal(second.state.sequence, first.state.sequence);
  assert.deepEqual(repeated.value, prepared.value);
  const noncanonical = { ...record, ignoredLegacy: true };
  const invalid = await funding.prepare(noncanonical);

  assert.equal(invalid.ok, false);
  const unchanged = await createBoardReader(boardRoot).load();
  assert.ok(unchanged.ok);
  assert.equal(unchanged.state.sequence, second.state.sequence);
  const funded = await funding.fund(record);
  assert.ok(funded.ok);
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.centralLearningGrants?.[0]?.allowance.maxTokens, 4096);
  assert.equal(after.state.centralLearningGrants?.[0]?.focusRevision, prepared.value.expectedIssueRevision);
});

test("normal fund retains first funding and existing-grant replay without duplicate source or revision writes", async t => {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-funding-default-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const fixture = searchImprovementFixture();
  const record = { type: "workflow_improvement_opportunity" as const, schemaVersion: 1 as const,
    opportunity: fixture.opportunity, evidence: fixture.evidence };
  const funding = createWorkflowImprovementFunding({ boardRoot, scope: fixture.opportunity.task.scope,
    budgetId: "explicit-run", allowance: 4096, now: () => 1793761200000 });
  const first = await funding.fund(record);
  assert.ok(first.ok);
  assert.equal(first.value.state, "queued");
  const before = await createBoardReader(boardRoot).load();
  assert.ok(before.ok);
  const again = await funding.fund(record);
  assert.ok(again.ok);
  assert.equal(again.value.state, "existing");
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.sequence, before.state.sequence);
  assert.equal(again.value.grantId, first.value.grantId);
  assert.equal(after.state.assets.length, 1);
  assert.equal(after.state.learningIssues?.[0]?.reports.length, 1);
});
