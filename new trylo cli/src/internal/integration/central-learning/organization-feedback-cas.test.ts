import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import type { OrganizationDecision, OrganizationFeedback } from "../../learning/central/organization/contracts.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { OrganizationCasBusyError } from "./organization-cas.js";
import { createCentralOrganizationFeedbackRefresh } from "./organization-feedback.js";
import { projectOrganizationCosts } from "./organization-feedback-cost.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createCentralOrganizationService } from "./organization-service.js";

const scope = "workspace:organization-feedback-cas", at = "2026-11-05T08:00:00.000Z";
const signal = new AbortController().signal;

type Append = ReturnType<typeof createRewardV2BoardPort>["append"];

type Hooks = {
  read?: () => Promise<void>;
  append?: (revision: number, draft: RewardV2Draft, commit: () => ReturnType<Append>) => ReturnType<Append>;
};

async function fixture(t: TestContext, reservations = 1) {
  const root = await mkdtemp(join(tmpdir(), "trylo-feedback-cas-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir()));
  assert.match(root.split(/[\\/]/u).at(-1)!, /^trylo-feedback-cas-/u);
    await rm(root, { recursive: true, force: true }); });
  const opened = await ensureCentralLearningBudget({ boardRoot: root, scope, enabled: () => true, now: () => at,
    authorizationRef: "authorization:original-cas", allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 10000, maxCalls: 16, maxSteps: 16, maxPromptChars: 20000 } });
  assert.ok(opened.ok);
  const funding = createCentralAccountingFundingAtRoot({ boardRoot: root, scope, budgetId: opened.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: "original-cas-deliberation" }, enabled: () => true, now: () => at });
  const reservationIds = Array.from({ length: reservations }, (_, index) => `reservation:cas:${index}`);

  for (const reservationId of reservationIds) assert.ok((await funding.reserve({ reservationId, maxTokens: 100 })).ok);

  const decision: OrganizationDecision = { kind: "decision", decisionRef: "decision:original-cas", purposeRef: "purpose:original-cas",
    context: { purpose: "Inspect the original accounting evidence", conditionKeys: [], known: [], residual: ["Actual usage is not settled"] },
    program: { programRef: "program:original-cas", depth: "bounded", timing: "now" },
    expectation: { change: "Preserve the original reported cost", uncertainties: ["Benefit remains unknown"] },
    alternatives: [], issueRefs: [], stageRefs: [], sourceRefs: [opened.rootRef.budgetId, ...reservationIds], experienceUse: null };
  const real = createRewardV2BoardPort(root, () => true), hooks: Hooks = {};
  const appended: RewardV2Draft[] = [], observed: { readonly value: OrganizationFeedback; readonly serialized: string }[] = [];
  const base = createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true, board: {
    read: real.read, async append(revision, draft) {
      appended.push(draft);
      const commit = () => real.append(revision, draft);
      return hooks.append === undefined ? commit() : hooks.append(revision, draft, commit);
    },
  } });
  const initial = await base.read();
  assert.ok(initial.status === "ready");
  assert.equal((await base.freezeDecision(decision, initial.revision)).status, "saved");
  appended.length = 0;
  const service: typeof base = { ...base, async read() {
    await hooks.read?.();
    return base.read();
  },

    async observe(value, revision) {
      observed.push({ value, serialized: canonicalJson(value) });
      return base.observe(value, revision);
    } };
  const observer = createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true });
  let seedSerial = 0;
  const seeded = await withBoardWriter(root, async store => {
    const send = (action: CoordinationAction) => store.apply({ type: "coordinate_learning", commandId: `fixture:feedback-cas-pa:${++seedSerial}`, issuedAt: at, action });

    assert.ok((await send({ kind: "report", scope, issueId: "issue:ordinary-pa", problemKey: "ordinary-pa-resource",
      report: { reportId: "report:ordinary-pa", source: { teamRunId: "team:pa", taskId: "task:pa", memberId: "personal_agent" },
        facts: ["Inspect the existing original resource"], evidenceRefs: [] } })).ok);
    assert.ok((await send({ kind: "decide", issueId: "issue:ordinary-pa", expectedRevision: 1,
      decision: "focused_learning", reason: "Inspect the existing resource", sourceRefs: [] })).ok);
    const current = await store.load();
    assert.ok(current.ok);

    return send({ kind: "fund", issueId: "issue:ordinary-pa", expectedRevision: 2, grantId: "grant:ordinary-pa", domain: "collaboration",
      budgetId: opened.rootRef.budgetId, authorizationRef: opened.rootRef.authorizationRef,
      planRef: "fixture:ordinary-pa-original-root", expectedSequence: current.state.sequence,
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 } });
  });
  assert.ok(seeded.ok, JSON.stringify(seeded));
  const grant = seeded.state.centralLearningGrants?.find(row => row.grantId === "grant:ordinary-pa");
  assert.ok(grant);
  const receipts = createCollaborationRuntimeReceiptWriter({ board: createFileCollaborationBoard(root), scope });
  let receiptCount = 0;
  const receipt = async () => {
    const index = ++receiptCount, id = `pa:resource:${index}`;
    const result = await receipts.record({ schemaVersion: 1, receiptId: id, phase: "resource_query", scope,
      issueId: grant.issueId, jobId: grant.jobId, grantId: grant.grantId, requestId: id, owner: "experience",
      query: "Inspect the existing personal-agent resource", resultRefs: [], summary: "Original PA resource query boundary", recordedAt: at,
      boundary: { executionId: `business:execution:${index}`, taskId: `business:task:${index}`, round: index, role: "personal_agent" } });
    assert.ok(result.ok, JSON.stringify(result));
  };
  const read = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const view = async () => {
    const current = await observer.read();
    assert.ok(current.status === "ready");
    return current;
  };
  const refresh = createCentralOrganizationFeedbackRefresh({ boardRoot: root, scope, workspaceId: "workspace-id:original-cas", enabled: () => true, service });

  return { root, hooks, appended, observed, service, observer, funding, reservationIds, receipt, read, view,
    run: () => refresh.refresh({ decisionRefs: [decision.decisionRef] }, signal) };
}

test("real PA receipts between initial reads and at the original append CAS recover without changing the fixed feedback draft", async t => {
  const f = await fixture(t);
  let reads = 0, raced = false;

  f.hooks.read = async () => { if (++reads === 1) await f.receipt(); };
  f.hooks.append = async (_revision, _draft, commit) => {
    if (!raced) {
    raced = true;
    await f.receipt();
  }
    return commit();
  };
  const result = await f.run();
  assert.equal(result.status, "ready");
  assert.equal(f.appended.length, 2, "one definite physical append stale permits one unchanged retry");
  assert.equal(new Set(f.appended.map(draft => draft.id)).size, 1);
  assert.equal(new Set(f.observed.map(row => row.serialized)).size, 1);
  assert.ok(f.observed.every(row => row.value.supersedes === null));
  const current = await f.view();
  assert.equal(current.projection.feedbackHistory.length, 1);
  assert.equal(current.projection.feedback[0]!.factId, f.appended[0]!.id);
  assert.equal((await f.read()).collaborationRuntimeReceipts?.length, 2);
});

test("an actual source reservation settlement rejects both replacement candidates until a separate refresh reads the new unit", async t => {
  const f = await fixture(t);
  let raced = false;

  f.hooks.append = async (_revision, _draft, commit) => {
    if (!raced) {
      raced = true;
      assert.ok((await f.funding.settle({ reservationId: f.reservationIds[0]!, usage: { kind: "reported", totalTokens: 40 } })).ok);
    }
    return commit();
  };
  assert.deepEqual(await f.run(), { status: "rejected", reason: "organization_feedback_source_changed" });
  assert.equal(f.appended.length, 1);
  assert.equal((await f.view()).projection.feedbackHistory.length, 0);
  assert.ok(f.observed[0]!.value.result.kind === "cost" && f.observed[0]!.value.result.usage.kind === "unknown");
  delete f.hooks.append;
  assert.equal((await f.run()).status, "ready");
  const current = await f.view();
  assert.equal(current.projection.feedbackHistory.length, 1);
  assert.deepEqual(current.projection.feedback[0]!.value.result, { kind: "cost", usage: { kind: "reported", tokens: 40, calls: 1, steps: 1 } });
  assert.equal(current.projection.feedback[0]!.value.supersedes, null, "the rejected original candidate never became a semantic head");
});

test("a real competing semantic head rejects the original supersedes instead of silently attaching it to the new head", async t => {
  const f = await fixture(t);
  let competingId = "", raced = false;

  f.hooks.append = async (_revision, _draft, commit) => {
    if (!raced) {
      raced = true;
      const current = await f.view(), original = f.observed[0]!.value;
      const competing = await f.observer.observe({ ...original,
        result: { kind: "cost", usage: { kind: "unknown", reason: "another_original_observer" } } }, current.revision);
      assert.ok(competing.status === "saved");
      competingId = competing.factId;
    }
    return commit();
  };
  assert.deepEqual(await f.run(), { status: "rejected", reason: "organization_feedback_revision_conflict" });
  assert.equal(f.appended.length, 1, "the original service rejects the semantic conflict before another physical append");
  assert.ok(f.observed.every(row => row.value.supersedes === null));
  assert.equal(new Set(f.observed.map(row => row.serialized)).size, 1);
  const current = await f.view();
  assert.equal(current.projection.feedbackHistory.length, 1);
  assert.equal(current.projection.feedback[0]!.factId, competingId);
  assert.notEqual(competingId, f.appended[0]!.id);
});

test("four continuing physical races retain earlier committed feedback and a new refresh only fills the original missing unit", async t => {
  const f = await fixture(t, 2);
  let firstId = "";

  f.hooks.append = async (_revision, draft, commit) => {
    if (firstId === "") firstId = draft.id;
    if (draft.id !== firstId) await f.receipt();
    return commit();
  };
  await assert.rejects(f.run(), error => error instanceof OrganizationCasBusyError && error.phase === "recall"
    && error.definiteUnwritten === true && error.attempts === 4);
  assert.equal(f.appended.length, 5);
  assert.equal(f.appended.filter(draft => draft.id === firstId).length, 1);
  assert.equal(new Set(f.appended.slice(1).map(draft => draft.id)).size, 1);
  const partial = await f.view();
  assert.equal(partial.projection.feedbackHistory.length, 1);
  assert.equal(partial.projection.feedback[0]!.factId, firstId);
  delete f.hooks.append;
  assert.equal((await f.run()).status, "ready");
  const final = await f.view();
  assert.equal(final.projection.feedbackHistory.length, 2);
  assert.equal(final.projection.feedbackHistory.filter(row => row.factId === firstId).length, 1);
  assert.equal(new Set(final.projection.feedback.map(row => row.value.unitRef)).size, 2);
  assert.ok(final.projection.feedback.every(row => row.value.supersedes === null));
  assert.equal((await f.read()).collaborationRuntimeReceipts?.length, 4);
});

test("a real committed append with a lost acknowledgement stays unconfirmed and is never blindly retried", async t => {
  const f = await fixture(t);
  f.hooks.append = async (_revision, _draft, commit) => {
    await commit();
    throw new Error("fixture_lost_append_acknowledgement");
  };
  assert.deepEqual(await f.run(), { status: "rejected", reason: "organization_write_unconfirmed" });
  assert.equal(f.appended.length, 1);
  const current = await f.view();
  assert.equal(current.projection.feedbackHistory.length, 1);
  assert.deepEqual(await f.service.observe(f.observed[0]!.value, current.revision), { status: "rejected", reason: "organization_writer_suspended" });
  assert.equal(f.appended.length, 1, "the suspended original service cannot dispatch another append");
});

test("a previously matching skipped source cannot survive another entry's rebase after its real source and semantic head change", async t => {
  const f = await fixture(t, 2), initial = await f.view();
  const originalA = projectOrganizationCosts(await f.read(), initial.projection, initial.projection.decisions[0]!)
    .find(row => row.sourceRefs.includes(f.reservationIds[0]!));
  assert.ok(originalA);
  const seeded = await f.observer.observe(originalA, initial.revision);
  assert.ok(seeded.status === "saved");
  let correctedId = "", raced = false;

  f.hooks.append = async (_revision, _draft, commit) => {
    if (!raced) {
      raced = true;
      assert.ok((await f.funding.settle({ reservationId: f.reservationIds[0]!, usage: { kind: "reported", totalTokens: 40 } })).ok);
      const current = await f.view();
      const changedA = projectOrganizationCosts(await f.read(), current.projection, current.projection.decisions[0]!)
        .find(row => row.unitRef === originalA.unitRef);
      assert.ok(changedA);
      const corrected = await f.observer.observe({ ...changedA, supersedes: seeded.factId }, current.revision);

      assert.ok(corrected.status === "saved");
      correctedId = corrected.factId;
    }
    return commit();
  };
  assert.deepEqual(await f.run(), { status: "rejected", reason: "organization_feedback_source_changed" });
  assert.equal(f.appended.length, 1, "only B attempted an append; A was initially skipped and B must not commit a mixed snapshot");
  assert.equal(f.observed.length, 1);
  assert.ok(f.observed[0]!.value.sourceRefs.includes(f.reservationIds[1]!));
  const final = await f.view();
  assert.equal(final.projection.feedbackHistory.length, 2);
  assert.equal(final.projection.feedback.length, 1);
  assert.equal(final.projection.feedback[0]!.factId, correctedId);
  assert.equal(final.projection.feedback[0]!.value.supersedes, seeded.factId);
});

test("an exact concurrent feedback commit remains idempotently ready while ordinary PA receipts advance later read prefixes", async t => {
  const f = await fixture(t);
  let committedId = "", committedSequence = -1, raced = false;

  f.hooks.append = async (_revision, _draft, commit) => {
    if (!raced) {
      raced = true;
      const current = await f.view();
      const same = await f.observer.observe(f.observed[0]!.value, current.revision);
      assert.ok(same.status === "saved");
      committedId = same.factId;
      committedSequence = same.revision;
      await f.receipt();
      f.hooks.read = f.receipt;
    }
    return commit();
  };
  const result = await f.run();
  assert.ok(result.status === "ready");
  assert.equal(f.appended.length, 1);
  assert.equal(f.observed.length, 1, "known commit verification is read-only, never another publication");
  const current = await f.view();
  assert.equal(current.projection.feedbackHistory.length, 1);
  assert.equal(current.projection.feedback[0]!.factId, committedId);
  assert.equal(current.projection.feedback[0]!.sequence, committedSequence);
  assert.ok(result.revision > committedSequence);
  assert.equal(result.revision, (await f.read()).sequence);
  assert.ok(result.materials.some(material => readOrganizationFeedbackMaterial(material, scope)?.factId === committedId));
  assert.equal((await f.read()).collaborationRuntimeReceipts?.length, 2);
});
