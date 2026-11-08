import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { createCentralSkillExecution } from "../../../../../integration/central-learning/skill-adapter.js";
import { journalExperienceFixture } from "../host/journal-experience-fixture.js";
import { createHermesManagedSkillRuntime } from "../host/managed-runtime.js";
import { createSkillReviewProcess } from "../review-process.js";
import { createSkillCoordination } from "./coordination.js";

test("confirmed native outcome crosses unrelated global revisions without rerunning work or retrying unknown writes", async t => {
  const f = await fixture(t);
  let writes = 0, workers = 0;
  const contended: Pick<BoardStore, "load" | "apply"> = { load: f.board.load, async apply(command) {
    if (command.type === "record_reward_v2_fact" && ++writes <= 2) {
      const unrelated = await f.board.apply({ ...command, commandId: `${command.commandId}:other:${writes}`,
        fact: { ...command.fact, id: `unrelated:${writes}`, scope: "unrelated-domain" } });
      assert.ok(unrelated.ok);
      // The unchanged original command now meets an actual global-sequence CAS refusal.
    }
    return f.board.apply(command);
  } };
  const result = await f.restarted(contended).run({ issueId: f.issueId, signal: signal(), async worker() {
    workers += 1;
    return { kind: "completed", resultRefs: ["native:already-returned"] };
  } });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(workers, 1);
  assert.equal(writes, 3);
  const after = await f.load();
  assert.equal(after.jobs[0]!.state, "succeeded");
  assert.equal(after.centralLearningGrants![0]!.status, "closed");

  const unknown = await fixture(t);
  let unknownWrites = 0, unknownWorkers = 0;
  const ambiguous: Pick<BoardStore, "load" | "apply"> = { load: unknown.board.load, async apply(command) {
    if (command.type === "record_reward_v2_fact") { unknownWrites += 1; throw new Error("unknown append outcome"); }
    return unknown.board.apply(command);
  } };
  const stopped = await unknown.restarted(ambiguous).run({ issueId: unknown.issueId, signal: signal(), async worker() {
    unknownWorkers += 1;
    return { kind: "completed", resultRefs: ["native:separate-receipt"] };
  } });
  assert.deepEqual(stopped, { ok: false, reason: "board_unavailable" });
  assert.equal(unknownWrites, 1);
  assert.equal(unknownWorkers, 1);

  const changed = await fixture(t);
  let replaceOwner = false, changedWrites = 0;
  const ownership: Pick<BoardStore, "load" | "apply"> = { async load() {
    const loaded = await changed.board.load();
    if (!loaded.ok || !replaceOwner) return loaded;
    return { ...loaded, state: { ...loaded.state, centralLearningGrants: loaded.state.centralLearningGrants!.map(grant =>
      grant.claim === undefined ? grant : { ...grant, claim: { ...grant.claim, claimId: "different-owner" } }) } };
  }, async apply(command) {
    if (command.type === "record_reward_v2_fact") {
      changedWrites += 1; replaceOwner = true;
      return { ok: false, reason: "reward_v2_stale", detail: "Known reducer refusal before another owner's claim is observed" };
    }
    return changed.board.apply(command);
  } };
  const refused = await changed.restarted(ownership).run({ issueId: changed.issueId, signal: signal(),
    worker: async () => ({ kind: "completed", resultRefs: ["native:original-owner"] }) });
  assert.deepEqual(refused, { ok: false, reason: "hermes_review_outcome_binding" });
  assert.equal(changedWrites, 1);
});

const initial = "2026-11-05T20:00:00.000Z", expired = "2026-11-05T20:11:00.000Z";
const signal = () => new AbortController().signal;
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 20000, maxCalls: 4, maxSteps: 4, maxPromptChars: 10000 };

async function fixture(t: TestContext) {
  const source = await journalExperienceFixture(t), turn = source.turn("source-turn", initial);

  await turn.start("Keep the observed release-manifest repair reusable.");
  await turn.item({ kind: "assistant_text", blockId: "observed-repair", text: "Read package.json and preserve its declared version before preparing release notes." });
  await turn.terminal();
  const scope = path.dirname(source.filename), boardRoot = path.join(scope, "learning", "board");
  let now = initial, serial = 0;
  const board = { load: () => createBoardReader(boardRoot).load(), apply: (command: BoardCommand) => withBoardWriter(boardRoot, store => store.apply(command)) };
  const load = async () => {
    const loaded = await board.load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await board.apply({ type: "coordinate_learning", commandId: `expired-contract:${++serial}`, issuedAt: now, action });
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const coordination = createSkillCoordination({ board, scope, ownerId: "original-owner", now: () => now });
  const report = await coordination.report({ sourceRef: "canonical:source-journal", versionId: source.sessionId, taskId: "source-turn",
    facts: ["The canonical terminal records the observed repair; this fixture tests recovery, not learning benefit."], evidenceRefs: ["canonical:source-journal"] });

  assert.ok(report.ok, JSON.stringify(report));
  let state = await act({ kind: "decide", issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    decision: "focused_learning", reason: "Bounded recovery contract", sourceRefs: ["canonical:source-journal"] });

  state = await act({ kind: "open_budget", expectedSequence: state.sequence, budget: { schemaVersion: 1,
    budgetId: "root:skill-expired-contract", scope, unit: "total_model_tokens", limits: { tokens: 100000, calls: 8, steps: 8 },
    authorizationRef: "contract:explicit-root" } });
  state = await act({ kind: "fund", domain: "skill", issueId: report.issue.issueId, expectedRevision: state.learningIssues![0]!.revision,
    grantId: "grant:skill-original", budgetId: "root:skill-expired-contract", expectedSequence: state.sequence,
    authorizationRef: "contract:skill-grant", planRef: "contract:original-review", allowance });
  const grant = state.centralLearningGrants![0]!;
  const claim = () => act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: "claim:old-owner", ownerId: "old-owner",
    expiresAt: "2026-11-05T20:10:00.000Z" });

  return { source, board, scope, boardRoot, coordination, grant, issueId: report.issue.issueId, load, act, claim,
    expire: () => { now = expired; }, advance: (at: string) => { now = at; }, now: () => now,
    restarted: (store: Pick<BoardStore, "load" | "apply"> = board) => createSkillCoordination({ board: store, scope, ownerId: "restarted-owner", now: () => now }) };
}

test("expired skill reservations without a confirmed native outcome never reopen review and retain unknown cost", async t => {
  const f = await fixture(t);
  await f.claim();
  await f.act({ kind: "reserve", grantId: f.grant.grantId, claimId: "claim:old-owner", reservationId: "provider:sent-before-crash", maxTokens: 1000 });
  f.expire();
  let workers = 0;
  const result = await f.restarted().run({ issueId: f.issueId, signal: signal(), async worker() {
    workers += 1;
    return { kind: "completed", resultRefs: [] };
  } });

  assert.equal(workers, 0, "A sent review has no cross-process native cursor and cannot be sampled again");
  assert.ok(result.ok, JSON.stringify(result));

  if (result.ok) assert.equal(result.status, "failed");

  const after = await f.load(), grant = after.centralLearningGrants![0]!;

  assert.equal(grant.status, "closed");
  assert.equal(grant.closedReason, "hermes_review_reconciliation_required");
  assert.deepEqual(centralLearningSpent(grant), { tokens: 1000, calls: 1, steps: 1 });
  assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
  assert.equal(after.centralLearningGrants!.length, 1);
});

test("a live original skill owner remains busy without provider work or Board mutation", async t => {
  const f = await fixture(t);
  await f.claim();
  const before = await f.load();
  let invoked = 0;
  const recovered = await f.restarted().recoverExpired(f.issueId, signal());

  assert.ok(recovered.ok);
  assert.equal(recovered.status, "busy");
  const dispatched = await f.restarted().run({ issueId: f.issueId, signal: signal(), async worker() {
    invoked += 1;
    return { kind: "completed", resultRefs: [] };
  } });

  assert.ok(dispatched.ok);
  assert.equal(dispatched.status, "busy");
  assert.equal(invoked, 0);
  assert.deepEqual(await f.load(), before);
});

test("central preparation reclaims only an unsent expired review, re-reads its real source and retains the original grant", async t => {
  const f = await fixture(t);
  await f.claim();
  f.expire();
  let reads = 0, seen = 0, reviews = 0;
  const coordination = f.restarted();
  const runtime = createHermesManagedSkillRuntime({ scope: f.scope, coordination,
    read: async source => {
      reads += 1;
      assert.equal(source.sessionId, f.source.sessionId);
      assert.equal(source.turnId, "source-turn");
      return f.source.opportunity(source.turnId);
    },
    seen: async () => {
      seen += 1;
      return false;
    },
    review: async () => {
      reviews += 1;
      return { status: "no_learning", candidateId: "readonly-preparation" };
    } });
  const adapter = createCentralSkillExecution({ board: f.board, scope: f.scope, runtime });
  const prepared = await adapter.prepare({ issueId: f.issueId, authorizedAllowance: allowance }, signal());

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));

  if (prepared.status !== "ready") throw new Error("unsent_recovery_not_ready");

  assert.equal(prepared.source.grantId, f.grant.grantId);
  assert.equal(reads, 1);
  assert.equal(seen, 1);
  assert.equal(reviews, 0);
  const ready = await f.load();
  assert.equal(ready.jobs[0]!.state, "queued");
  assert.equal(ready.centralLearningGrants![0]!.claim, undefined);
  assert.deepEqual(centralLearningSpent(ready.centralLearningGrants![0]!), { tokens: 0, calls: 0, steps: 0 });
  assert.equal(ready.centralLearningGrants!.length, 1);
  assert.equal(ready.centralLearningBudgets!.length, 1);
  const result = await runtime.runManaged({ issueId: f.issueId, grantId: f.grant.grantId,
    expectedIssueRevision: ready.learningIssues![0]!.revision, sourceBindingRef: prepared.source.sourceBindingRef,
    stageResources: { tokens: 20000, calls: 4, steps: 4 } }, signal());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(reviews, 1);
  assert.equal((await f.load()).centralLearningGrants!.length, 1);
});

test("confirmed native finish survives two local finish crashes and restores only its exact pending locators without another review", async t => {
  const f = await fixture(t);
  let crash = true, reviews = 0, nativeFinishes = 0, reads = 0;
  const crashing: Pick<BoardStore, "load" | "apply"> = { load: f.board.load, async apply(command) {
    if (crash && command.type === "coordinate_learning" && command.action.kind === "finish") {
      crash = false;
      throw new Error("contract_crash_after_native_receipt");
    }
    return f.board.apply(command);
  } };
  const review = createSkillReviewProcess({
    async begin(opportunity) {
      assert.equal(opportunity.turnId, "source-turn");
      return { status: "ready", reviewId: "native:confirmed", prompt: "Canonical observed repair" };
    },
    async finish(reviewId, execution) {
      nativeFinishes += 1;
      assert.equal(reviewId, "native:confirmed");
      assert.equal(execution.status, "completed");
      assert.deepEqual(execution.proposals, [{ pendingId: "pending:exact", name: "manifest-repair", action: "create" }]);
      return { status: "staged", candidateId: reviewId, pendingId: "pending:exact", pendingIds: ["pending:exact"], approval: "required" };
    }, async release() {} });
  const coordination = f.restarted(crashing);
  const runtime = createHermesManagedSkillRuntime({ scope: f.scope, coordination,
    read: async source => {
      reads += 1;
      return f.source.opportunity(source.turnId);
    }, seen: async () => false,
    review: (opportunity, work) => review(opportunity, async () => {
      reviews += 1;
      assert.ok((await work.funding.reserve({ reservationId: "provider:confirmed", maxTokens: 1000 })).ok);
      assert.ok((await work.funding.settle({ reservationId: "provider:confirmed", usage: { kind: "reported", totalTokens: 500 } })).ok);
      return { answer: "Staged; Permission still owns approval.", proposals: [{ pendingId: "pending:exact", name: "manifest-repair", action: "create" }], status: "completed", toolFailures: 0 };
    }, work.signal) });
  const failedFinish = await coordination.run({ issueId: f.issueId, signal: signal(), worker: runtime.worker });

  assert.deepEqual(failedFinish, { ok: false, reason: "board_unavailable" });
  const saved = await f.load();
  assert.equal(saved.rewardV2Facts?.length, 1);
  const outcome = JSON.parse(saved.rewardV2Facts![0]!.payloadJson);

  assert.equal(outcome.issueId, f.issueId);
  assert.equal(outcome.grantId, f.grant.grantId);
  assert.equal(outcome.claimId, saved.centralLearningGrants![0]!.claim!.claimId);
  assert.deepEqual(outcome.result.resultRefs, ["hermes-review:native:confirmed:staged", "hermes-pending:skills:pending:exact"]);
  f.expire();
  crash = true;
  assert.deepEqual(await f.restarted(crashing).recoverExpired(f.issueId, signal()), { ok: false, reason: "board_unavailable" });
  const reclaimed = await f.load();
  assert.equal(reclaimed.jobs[0]!.attempt, 2);
  f.advance("2026-11-05T20:22:00.000Z");
  const recovered = await f.restarted().recoverExpired(f.issueId, signal());

  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(recovered.status, "recovered");
  const final = await f.load(), grant = final.centralLearningGrants![0]!;

  assert.equal(grant.status, "closed");
  assert.equal(grant.closedReason, "completed");
  assert.deepEqual(final.jobs[0]!.coordination!.resultRefs, outcome.result.resultRefs);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 500, calls: 1, steps: 1 });
  assert.equal(grant.reservations[0]!.usage?.kind, "reported");
  assert.equal(final.rewardV2Facts!.length, 1);
  assert.equal(final.centralLearningGrants!.length, 1);
  assert.equal(reviews, 1);
  assert.equal(nativeFinishes, 1);
  assert.equal(reads, 1);
  assert.equal(final.assets.length, 0, "local outcome recovery grants no approval or instruction asset");
  const again = await f.restarted().recoverExpired(f.issueId, signal());

  assert.ok(again.ok);
  assert.equal(again.status, "unchanged");
  assert.deepEqual(await f.load(), final);
});

test("the raw Board writer rejects skill yield after any sent or settled provider reservation", async t => {
  for (const usage of [undefined, { kind: "reported" as const, totalTokens: 200 }, { kind: "unknown" as const, reason: "provider_response_lost" }]) {
    const f = await fixture(t);
    await f.claim();
    await f.act({ kind: "reserve", grantId: f.grant.grantId, claimId: "claim:old-owner", reservationId: "provider:sent", maxTokens: 1000 });

    if (usage !== undefined) await f.act({ kind: "settle", grantId: f.grant.grantId, reservationId: "provider:sent", usage });

    const before = await f.load();
    const yielded = await f.board.apply({ type: "coordinate_learning", commandId: "contract:illegal-skill-yield", issuedAt: f.now(),
      action: { kind: "finish", jobId: f.grant.jobId, claimId: "claim:old-owner", expectedIssueRevision: before.learningIssues![0]!.revision,
        result: { kind: "yielded", reason: "must_not_reopen_native_review" } } });

    assert.ok(!yielded.ok);
    assert.equal(yielded.detail, "skill_yield_requires_unsent_review");
    assert.deepEqual(await f.load(), before);
  }
});

test("recovery finish CAS rejects a source revision changed after its reclaim", async t => {
  const f = await fixture(t);
  await f.claim();
  await f.act({ kind: "reserve", grantId: f.grant.grantId, claimId: "claim:old-owner", reservationId: "provider:unknown", maxTokens: 1000 });
  f.expire();
  let race = true;
  const racing: Pick<BoardStore, "load" | "apply"> = { load: f.board.load, async apply(command) {
    if (race && command.type === "coordinate_learning" && command.action.kind === "finish") {
      race = false;
      const issue = (await f.load()).learningIssues![0]!;
      await f.act({ kind: "report", scope: f.scope, issueId: issue.issueId, problemKey: issue.problemKey,
        report: { reportId: "report:changed-during-local-finish", source: { subsystem: "skill", taskId: "later-turn", versionId: f.source.sessionId },
          facts: ["Another exact source arrived before terminal accounting."], evidenceRefs: ["canonical:later-turn"] } });
    }
    return f.board.apply(command);
  } };
  const result = await f.restarted(racing).recoverExpired(f.issueId, signal());

  assert.deepEqual(result, { ok: false, reason: "learning_claim_conflict" });
  const final = await f.load();
  assert.equal(final.centralLearningGrants![0]!.status, "open");
  assert.equal(final.jobs[0]!.state, "running");
  assert.equal(final.learningIssues![0]!.reports.length, 2);
  assert.equal(final.centralLearningGrants![0]!.reservations[0]!.usage?.kind, "unknown");
});

test("research-request skill sources use the same coordination owner and unsent recovery boundary", async t => {
  const f = await fixture(t), issueId = "skill-issue:research-request-recovery";
  let state = await f.act({ kind: "report", scope: f.scope, issueId, problemKey: "skill-research:requested",
    report: { reportId: "report:research-request", source: { kind: "research_request", domain: "skill",
      requestRef: "request:skill-observed-repair", intentRef: "intent:explicit-skill-research" },
      facts: ["Explicit research request, without a fabricated execution turn."], evidenceRefs: ["request:skill-observed-repair"] } });
  const issue = state.learningIssues!.find(item => item.issueId === issueId)!;

  state = await f.act({ kind: "decide", issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "Request-owner recovery contract", sourceRefs: ["request:skill-observed-repair"] });
  state = await f.act({ kind: "fund", domain: "skill", issueId,
    expectedRevision: state.learningIssues!.find(item => item.issueId === issueId)!.revision,
    grantId: "grant:skill-research-request", budgetId: "root:skill-expired-contract", expectedSequence: state.sequence,
    authorizationRef: "contract:skill-request", planRef: "contract:request-review", allowance });
  const grant = state.centralLearningGrants!.find(item => item.issueId === issueId)!;

  await f.act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: "claim:request-old-owner", ownerId: "request-old-owner",
    expiresAt: "2026-11-05T20:10:00.000Z" });
  const inspected = await f.restarted().inspect(issueId);
  assert.ok(inspected.ok);
  assert.equal(inspected.issues[0]!.issueId, issueId);
  f.expire();
  const recovered = await f.restarted().recoverExpired(issueId, signal());

  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(recovered.status, "ready");
  const final = await f.load(), recoveredGrant = final.centralLearningGrants!.find(item => item.grantId === grant.grantId)!;

  assert.equal(recoveredGrant.claim, undefined);
  assert.equal(final.jobs.find(item => item.jobId === grant.jobId)!.state, "queued");
  assert.deepEqual(centralLearningSpent(recoveredGrant), { tokens: 0, calls: 0, steps: 0 });
  assert.equal(final.centralLearningGrants!.find(item => item.grantId === f.grant.grantId)!.claim, undefined);
});
