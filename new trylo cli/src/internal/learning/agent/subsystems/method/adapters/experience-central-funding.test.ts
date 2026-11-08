import assert from "node:assert/strict";
import test from "node:test";
import { applyLearningCoordination } from "../../../../control/apply-coordination.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { isCentralLearningGrant, isCoordinationAction, isLearningIssueReport } from "../../../../control/coordination-parse.js";
import { validCoordinationState } from "../../../../control/coordination-state.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "../../../../control/state.js";
import { createCollaborationControl } from "../../collaboration/index.js";

const AT = "2026-11-03T04:00:00.000Z";
const ALLOWANCE = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 5000, maxCalls: 1, maxSteps: 1, maxPromptChars: 6000 };

function apply(state: BoardState, commandId: string, action: unknown): BoardState {
  assert.ok(isCoordinationAction(action), `invalid action: ${JSON.stringify(action)}`);
  const result = applyLearningCoordination(state, { type: "coordinate_learning", commandId, issuedAt: AT, action });
  assert.equal(result.ok, true, result.ok ? undefined : `${result.reason}: ${result.detail}`);
  assert.ok(result.ok);
  assert.equal(validCoordinationState(result.state), true);
  return result.state;
}

function funded(domain?: string): BoardState {
  let state = apply(emptyBoardState(), "report", { kind: "report", scope: "project:test", problemKey: "method-review",
    issueId: "issue", report: { reportId: "report", source: domain === "prompt"
      ? { subsystem: "method", taskId: "task", versionId: "v1" } : { teamRunId: "run", taskId: "task", memberId: "member" },
      facts: ["eligible evidence snapshot"], evidenceRefs: ["evidence:1"] } });

  state = apply(state, "decide", { kind: "decide", issueId: "issue", expectedRevision: 1,
    decision: "focused_learning", reason: "review eligible method", sourceRefs: ["evidence:1"] });

  return apply(state, "fund", { kind: "fund", issueId: "issue", expectedRevision: 2,
    grantId: "grant", allowance: ALLOWANCE, ...(domain === undefined ? {} : { domain }) });
}

function claimed(state: BoardState): BoardState {
  return apply(state, "claim", { kind: "claim", jobId: state.jobs[0]!.jobId, expectedAttempt: 0,
    claimId: "claim", ownerId: "method", expiresAt: "2026-11-03T04:05:00.000Z" });
}

test("method funding uses the shared central grant lifecycle and survives normalization", () => {
  let state = claimed(funded("prompt"));

  assert.equal(state.jobs[0]!.domain, "prompt");
  assert.match(state.jobs[0]!.jobId, /^central-prompt:/);
  state = apply(state, "reserve", { kind: "reserve", grantId: "grant", claimId: "claim", reservationId: "call", maxTokens: 4000 });
  const restored = normalizeBoardState(JSON.parse(JSON.stringify(state)));

  assert.ok(restored);
  state = apply(restored, "settle", { kind: "settle", grantId: "grant", reservationId: "call",
    usage: { kind: "reported", totalTokens: 2300, inputTokens: 1700, outputTokens: 600 } });
  assert.deepEqual(centralLearningRemaining(state.centralLearningGrants![0]!), { tokens: 2700, calls: 0, steps: 0 });
  const blocked = applyLearningCoordination(state, { type: "coordinate_learning", commandId: "overspend", issuedAt: AT,
    action: { kind: "reserve", grantId: "grant", claimId: "claim", reservationId: "call-2", maxTokens: 1 } });

  assert.equal(blocked.ok, false);

  if (!blocked.ok) assert.equal(blocked.reason, "learning_grant_exhausted");

  state = apply(state, "finish", { kind: "finish", jobId: state.jobs[0]!.jobId, claimId: "claim",
    result: { kind: "completed", resultRefs: ["method-review:1"] } });
  assert.equal(state.centralLearningGrants![0]!.status, "closed");
  assert.equal(state.jobs[0]!.state, "succeeded");
});

test("legacy central grants preserve their collaboration domain and serialized shape", () => {
  const state = funded();
  assert.equal(state.jobs[0]!.domain, "collaboration");
  assert.match(state.jobs[0]!.jobId, /^central-collaboration:/);
  assert.equal(Object.hasOwn(state.centralLearningGrants![0]!, "domain"), false);
  assert.ok(normalizeBoardState(JSON.parse(JSON.stringify(state))));
});

test("central funding rejects unsupported domains and mismatched persisted domain bindings", () => {
  const base = { kind: "fund", issueId: "issue", expectedRevision: 2, grantId: "grant", allowance: ALLOWANCE };

  assert.equal(isCoordinationAction({ ...base, domain: "unsupported_method_probe" }), false);
  assert.equal(isCoordinationAction({ ...base, domain: null }), false);
  const state = funded("prompt"), grant = state.centralLearningGrants![0]!;

  assert.equal(isCentralLearningGrant({ ...grant, domain: "unsupported_method_probe" }), false,
    "tool is supported by the parallel shared protocol; a genuinely unknown domain must still fail");
  assert.equal(validCoordinationState({ ...state, jobs: state.jobs.map(job => ({ ...job, domain: "collaboration" })) }), false);
  const { domain: _domain, ...withoutDomain } = grant;

  assert.equal(validCoordinationState({ ...state, centralLearningGrants: [withoutDomain] }), false);
});

test("cancelled method grant accepts late usage without reopening its job", () => {
  let state = claimed(funded("prompt"));

  state = apply(state, "reserve", { kind: "reserve", grantId: "grant", claimId: "claim", reservationId: "call", maxTokens: 4000 });
  state = apply(state, "cancel", { kind: "finish", jobId: state.jobs[0]!.jobId, claimId: "claim",
    result: { kind: "cancelled", reason: "task cancelled" } });
  state = apply(state, "late", { kind: "settle", grantId: "grant", reservationId: "call",
    usage: { kind: "reported", totalTokens: 2100 } });
  assert.equal(state.jobs[0]!.state, "cancelled");
  assert.equal(state.centralLearningGrants![0]!.status, "closed");
  assert.equal(state.centralLearningGrants![0]!.reservations[0]!.usage?.kind, "reported");
});

test("method reports have an honest source and bounded yielded work keeps its original grant", () => {
  const report = { reportId: "method-source", source: { subsystem: "method", taskId: "task", versionId: "v1" },
    facts: ["future evidence"], evidenceRefs: [] };

  assert.equal(isLearningIssueReport(report), true);
  assert.equal(isLearningIssueReport({ ...report, source: { ...report.source, teamRunId: "invented" } }), false);
  let state = claimed(funded("prompt"));

  state = apply(state, "yield", { kind: "finish", jobId: state.jobs[0]!.jobId, claimId: "claim",
    result: { kind: "yielded", reason: "wait for new method evidence" } });
  assert.equal(state.jobs[0]!.state, "queued");
  assert.equal(state.centralLearningGrants![0]!.status, "open");
  assert.equal(state.centralLearningGrants![0]!.claim, undefined);
  state = apply(state, "claim-next", { kind: "claim", jobId: state.jobs[0]!.jobId, expectedAttempt: 1,
    claimId: "claim-next", ownerId: "method", expiresAt: "2026-11-03T04:05:00.000Z" });
  assert.equal(state.centralLearningGrants![0]!.allowance.maxCalls, ALLOWANCE.maxCalls);
  const legacy = claimed(funded());
  const yielded = applyLearningCoordination(legacy, { type: "coordinate_learning", commandId: "legacy-yield", issuedAt: AT,
    action: { kind: "finish", jobId: legacy.jobs[0]!.jobId, claimId: "claim", result: JSON.parse('{"kind":"yielded","reason":"wait"}') } });

  assert.ok(yielded.ok, "the shared collaboration owner also has a bounded yield contract");
  assert.equal(yielded.state.jobs[0]!.state, "queued");
  assert.equal(yielded.state.centralLearningGrants![0]!.status, "open");
  assert.equal(yielded.state.centralLearningGrants![0]!.claim, undefined);
  assert.deepEqual(yielded.state.centralLearningGrants![0]!.allowance, ALLOWANCE);
});

test("the existing collaboration dispatcher never claims a method-funded job", async () => {
  const legacy = funded();
  const state: BoardState = { ...legacy, jobs: legacy.jobs.map(job => ({ ...job, domain: "prompt" })),
    centralLearningGrants: legacy.centralLearningGrants!.map(grant => ({ ...grant, domain: "prompt" })) };
  let writes = 0;
  const control = createCollaborationControl({ now: () => AT, ownerId: "collaboration", board: {
    async load() { return { ok: true, state, generation: 0 }; },
    async apply() {
      writes += 1;
      return { ok: false, reason: "board_unavailable", detail: "Unexpected claim of method job" };
    },
  }, worker: { async run() { assert.fail("collaboration worker claimed method work"); } } });
  const dispatched = await control.dispatch({ scope: "project:test" });

  assert.deepEqual(dispatched, { ok: true, status: "idle" });
  assert.equal(writes, 0);
});

