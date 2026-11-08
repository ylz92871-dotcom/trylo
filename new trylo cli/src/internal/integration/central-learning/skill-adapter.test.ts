import assert from "node:assert/strict";
import test from "node:test";
import { createCentralSkillExecution } from "./skill-adapter.js";
import type { CentralFundedStage } from "./contracts.js";
import { createSkillCoordination, skillReviewWorkResult } from "../../learning/agent/subsystems/skill/index.js";
import type { SkillManagedRuntime } from "../../learning/agent/subsystems/skill/index.js";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { BoardStore } from "../../learning/control/store-port.js";

const scope = "workspace:skill-adapter", at = "2026-11-04T13:00:00.000Z";
const signal = () => new AbortController().signal;

async function fixture() {
  let state = emptyBoardState(), serial = 0, invoked = 0;
  const board: Pick<BoardStore, "load" | "apply"> = {
    load: async () => ({ ok: true, state, generation: 0 }),

    apply: async command => {
      const next = reduce(state, command);
      if (next.ok) state = next.state;
      return next;
    },
  };
  const act = async (action: CoordinationAction) => {
    const result = await board.apply({ type: "coordinate_learning", commandId: `fixture:${++serial}`, issuedAt: at, action });
    assert.ok(result.ok);
    return result.state;
  };
  const coordination = createSkillCoordination({ board, scope, ownerId: "skill-adapter-contract", now: () => at });
  const reported = await coordination.report({ sourceRef: "source:skill-adapter", taskId: "turn:one", versionId: "session:one",
    facts: ["Synthetic source; these contracts verify binding and receipt projection, not native proposal generation."], evidenceRefs: ["journal:one"] });

  assert.ok(reported.ok);
  await act({ kind: "decide", issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Explicit bounded contract", sourceRefs: ["journal:one"] });
  await act({ kind: "open_budget", expectedSequence: state.sequence, budget: { schemaVersion: 1, budgetId: "root:skill-adapter",
    scope, unit: "total_model_tokens", limits: { tokens: 30000, calls: 8, steps: 8 }, authorizationRef: "host:independent-root" } });
  const runtime: SkillManagedRuntime = {
    prepareManaged: async () => ({ status: "ready", source: { stageRef: "stage:skill-adapter", sourceBindingRef: "source-binding:skill-adapter",
      sourceReportId: reported.issue.reports[0]!.reportId, sourceRefs: ["journal:one"] } }),

    runManaged: async () => {
      invoked += 1;
      throw new Error("This guard-only contract must not run a native worker");
    },
  };
  const adapter = createCentralSkillExecution({ board, scope, runtime });
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 20000,
    maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 };
  const prepared = await adapter.prepare({ issueId: reported.issue.issueId, authorizedAllowance: allowance }, signal());

  assert.equal(prepared.status, "ready");

  if (prepared.status !== "ready") throw new Error("stage_not_ready");

  const issue = state.learningIssues![0]!;

  await act({ kind: "fund", domain: "skill", issueId: issue.issueId, expectedRevision: issue.revision,
    grantId: prepared.source.grantId, budgetId: "root:skill-adapter", expectedSequence: state.sequence,
    authorizationRef: "host:independent-grant", planRef: "plan:skill-adapter", allowance });
  const input: CentralFundedStage = { issueId: issue.issueId, grantId: prepared.source.grantId,
    expectedIssueRevision: state.learningIssues![0]!.revision, stageRef: prepared.stageRef, policyRef: prepared.policyRef,
    sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };

  return { adapter, coordination, input, act, allowance, state: () => state, invoked: () => invoked };
}

test("a new explicit skill focus can retry a known failed review without reopening its old grant", async () => {
  const f = await fixture();

  assert.ok((await f.coordination.run({ issueId: f.input.issueId, signal: signal(),
    worker: async () => ({ kind: "failed", reason: "hermes_worker_operation_failed" }) })).ok);
  const old = JSON.stringify(f.state().centralLearningGrants![0]);

  assert.equal((await f.adapter.prepare({ issueId: f.input.issueId, authorizedAllowance: f.allowance }, signal())).status, "terminal");
  const issue = f.state().learningIssues![0]!;

  await f.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "Explicit retry after fixing the missing native interpreter", sourceRefs: ["journal:one"] });
  assert.ok((await f.adapter.nominate!(signal())).includes(issue.issueId));
  const retry = await f.adapter.prepare({ issueId: issue.issueId, authorizedAllowance: f.allowance }, signal());

  assert.ok(retry.status === "ready");
  assert.notEqual(retry.source.grantId, f.input.grantId);
  assert.equal(JSON.stringify(f.state().centralLearningGrants![0]), old);
  assert.equal(f.invoked(), 0);
});

test("a new focus cannot hide unconfirmed costs on the old skill review", async () => {
  const f = await fixture();

  assert.ok((await f.coordination.run({ issueId: f.input.issueId, signal: signal(), async worker({ funding }) {
    assert.ok((await funding.reserve({ reservationId: "call:unconfirmed", maxTokens: 500 })).ok);
    assert.ok((await funding.settle({ reservationId: "call:unconfirmed", usage: { kind: "unknown", reason: "transport_interrupted" } })).ok);
    return { kind: "failed", reason: "hermes_worker_operation_failed" };
  } })).ok);
  const issue = f.state().learningIssues![0]!;

  await f.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "A new focus still must retain unknown native work", sourceRefs: ["journal:one"] });
  assert.equal((await f.adapter.prepare({ issueId: issue.issueId, authorizedAllowance: f.allowance }, signal())).status, "terminal");
  assert.equal(f.state().centralLearningGrants!.length, 1);
  assert.equal(f.invoked(), 0);
});

test("the skill execution adapter rejects a substituted grant before invoking its original runtime", async () => {
  const f = await fixture(), before = JSON.stringify(f.state());
  const result = await f.adapter.dispatch({ ...f.input, grantId: "grant:unrelated" }, signal());
  assert.ok(!result.ok);
  assert.equal(f.invoked(), 0);
  assert.equal(JSON.stringify(f.state()), before);
});

test("a generic completed job is not a qualified Hermes proposal", async () => {
  const f = await fixture();
  const result = await f.coordination.run({ issueId: f.input.issueId, expectedGrantId: f.input.grantId,
    expectedIssueRevision: f.input.expectedIssueRevision, signal: signal(),
    worker: async () => ({ kind: "completed", resultRefs: ["ordinary-completion"] }) });

  assert.ok(result.ok);
  const observed = await f.adapter.observe(f.input, signal());

  assert.equal(observed.outcome, "pending");
  assert.equal(observed.reason, "hermes_native_proposal_not_confirmed");
});

test("native no-learning is a negative proposal receipt only after complete reported usage", async () => {
  for (const usage of [{ kind: "reported" as const, totalTokens: 100 }, { kind: "unknown" as const, reason: "provider_usage_missing" }]) {
    const f = await fixture();
    const result = await f.coordination.run({ issueId: f.input.issueId, expectedGrantId: f.input.grantId,
      expectedIssueRevision: f.input.expectedIssueRevision, signal: signal(), async worker({ funding }) {
        assert.ok((await funding.reserve({ reservationId: "reservation:one", maxTokens: 500 })).ok);
        assert.ok((await funding.settle({ reservationId: "reservation:one", usage })).ok);
        return skillReviewWorkResult({ status: "no_learning", candidateId: "native-response-fixture" });
      } });

    assert.ok(result.ok);
    const observed = await f.adapter.observe(f.input, signal());

    assert.equal(observed.outcome, usage.kind === "reported" ? "closed_no_result" : "pending");
    assert.equal(f.state().centralLearningGrants!.length, 1);
  }
});
