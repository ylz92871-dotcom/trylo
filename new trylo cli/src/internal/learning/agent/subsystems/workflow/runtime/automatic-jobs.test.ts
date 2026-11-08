import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeLog } from "../../../../../adapters/learning-store/codec.js";
import {
  claimWorkflowLearningJob, enqueueWorkflowLearningJob, finishWorkflowLearningJob,
  readPendingWorkflowLearningJobs, readWorkflowLearningJob, readLearnedWorkflowJobForTurn, recoverWorkflowLearningJob, retryWorkflowLearningJob,
  workflowTerminalRetryId,
} from "./automatic-jobs.js";
import { readSuccessfulWorkflowClassificationRetry } from "./automatic-classification-retries.js";
import { parseWorkflowAutomaticInput, type WorkflowAutomaticInput } from "./automatic-job-contracts.js";
import { runWorkflowLearning } from "./runtime.js";

const issuedAt = "2026-11-03T00:00:00.000Z";

function input(jobId = "job-a", grantId = "grant-a"): WorkflowAutomaticInput {
  return { jobId, purpose: "segment", scope: "project-a", sessionId: "session-a", turnId: "turn-a",
    task: { scope: "project-a", taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" } },
    allowance: { grantId, maxCalls: 2, maxTokens: 4000 },
    observed: { sessionId: "session-a", turnId: "turn-a", terminal: "completed", tokens: 20, wallMs: 50,
      checks: [{ toolCallId: "check-a", command: "node check.cjs", status: "passed", evidenceRef: "receipt-a", sequence: 3 }], mutations: [] } };
}

async function fixture(run: (boardRoot: string) => Promise<void>) {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-jobs-"));
  try { await run(boardRoot); } finally { await rm(boardRoot, { recursive: true, force: true }); }
}

test("enqueue persists one canonical input and job; duplicate payload changes and reused grants fail closed", async () => fixture(async boardRoot => {
  const first = await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt });

  assert.ok(first.ok);
  assert.deepEqual(await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt: "2026-11-03T01:00:00.000Z" }), first);
  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: { ...input(), turnId: "changed" }, issuedAt })).ok, false);
  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: input("other-job", "grant-a"), issuedAt })).ok, false);
  const pending = await readPendingWorkflowLearningJobs({ boardRoot, scope: "project-a", limit: 1 });

  assert.ok(pending.ok);
  assert.equal(pending.value.length, 1);
  assert.equal(pending.value[0]?.state, "queued");
  const foreign = await readPendingWorkflowLearningJobs({ boardRoot, scope: "project-b", limit: 1 });

  assert.ok(foreign.ok);
  assert.deepEqual(foreign.value, []);
  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs.length, 1);
  assert.equal(board.state.assets.filter(asset => (asset.content as { type?: string }).type === "workflow_learning_input").length, 1);
}));

test("an interrupted proposal append binds its payload before an input asset exists", async () => fixture(async boardRoot => {
  const content = { type: "workflow_learning_input", schemaVersion: 1, attempt: 1, input: input() };
  const versionId = `wfli_${contentHashOf(["job-a", 1]).slice(0, 32)}`;
  const prepared = await withBoardWriter(boardRoot, async store => store.apply({ type: "submit_proposal",
    commandId: `${versionId}:submit`, issuedAt, proposal: { proposalId: `proposal_${versionId}`, domain: "workflow",
      scope: "project-a", assetKind: "workflow", candidateRef: versionId,
      hypothesis: `durable workflow work; no authority; payload=${contentHashOf(content)}`,
      observationRefs: ["turn-a"], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } }));

  assert.ok(prepared.ok);
  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: { ...input(), allowance: { ...input().allowance, maxTokens: 3000 } }, issuedAt })).ok, false);
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const read = await readWorkflowLearningJob({ boardRoot, jobId: "job-a" });
  assert.ok(read.ok);
  assert.equal(read.value.input.allowance.maxTokens, 4000);
}));

test("claim reserves the grant before a model call and cannot issue a second claim after restart", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claimed.ok);
  assert.equal(claimed.value.attempt, 1);
  assert.equal(claimed.value.input.allowance.grantId, "grant-a");
  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs[0]?.state, "running");
  assert.equal(board.state.jobs[0]?.attempt, 1);
  assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt })).ok, false);
  const pending = await readPendingWorkflowLearningJobs({ boardRoot, scope: "project-a", limit: 5 });

  assert.ok(pending.ok);
  assert.equal(pending.value[0]?.state, "running");
}));

test("two simultaneous workers cannot both reserve the same grant", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claims = await Promise.all([claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt }), claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt })]);
  assert.equal(claims.filter(claim => claim.ok).length, 1);
  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs[0]?.attempt, 1);
}));

test("an interrupted running grant waits with unknown evidence and only a distinct fresh grant can requeue it", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claimed.ok);
  const recovered = await recoverWorkflowLearningJob({ boardRoot, jobId: "job-a", expectedAttempt: 1, issuedAt });
  assert.ok(recovered.ok);
  assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt })).ok, false);
  assert.equal((await retryWorkflowLearningJob({ boardRoot, jobId: "job-a", allowance: input().allowance, issuedAt })).ok, false);
  const retried = await retryWorkflowLearningJob({ boardRoot, jobId: "job-a", allowance: { ...input().allowance, grantId: "fresh-grant" }, issuedAt });
  assert.ok(retried.ok);
  assert.deepEqual(await retryWorkflowLearningJob({ boardRoot, jobId: "job-a", allowance: { ...input().allowance, grantId: "fresh-grant" }, issuedAt }), retried);
  const next = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(next.ok);
  assert.equal(next.value.attempt, 2);
  assert.equal(next.value.input.allowance.grantId, "fresh-grant");
  assert.equal((await finishWorkflowLearningJob({ boardRoot, claim: claimed.value, outcome: { kind: "abstained", code: "late" }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok, false);
}));

test("finish binds attempt and payload, records actual usage, and exact retries are idempotent", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claimed.ok);
  assert.equal((await finishWorkflowLearningJob({ boardRoot, claim: claimed.value,
    outcome: { kind: "learned", versionId: claimed.value.inputVersionId }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok, false);
  const result = { boardRoot, claim: claimed.value, outcome: { kind: "abstained" as const, code: "no-reusable-process" }, usage: { calls: 1, tokens: 20 }, issuedAt };
  const finished = await finishWorkflowLearningJob(result);
  assert.ok(finished.ok);
  assert.deepEqual(await finishWorkflowLearningJob(result), finished);
  assert.equal((await finishWorkflowLearningJob({ ...result, usage: { calls: 2, tokens: 30 } })).ok, false);
  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs[0]?.state, "succeeded");
}));

test("a hash-valid malformed asset cannot report learned while a real parsed workflow asset can", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claim = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claim.ok);
  const malformed = { type: "workflow_learning", schemaVersion: 2, scope: "project-a", taskFamily: input().task!.taskFamily };
  const committed = await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "submit_proposal", commandId: "malformed-submit", issuedAt,
      proposal: { proposalId: "malformed-proposal", domain: "workflow", scope: "project-a", assetKind: "workflow", candidateRef: "malformed",
        hypothesis: "hash-valid but no graph", observationRefs: ["fixture"], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } })).ok);
    return store.apply({ type: "commit_asset", commandId: "malformed-commit", issuedAt, proposalId: "malformed-proposal",
      versionId: "malformed", schemaVersion: 2, content: malformed });
  });

  assert.ok(committed.ok);
  assert.equal((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome: { kind: "learned", versionId: "malformed" }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok, false);
  const task = input().task!;
  const learned = await runWorkflowLearning({ boardRoot, issuedAt, request: { ...task, subsystem: "workflow", collect: true,
    requestId: "valid-workflow", budget: { maxEpisodes: 4, maxSteps: 8, maxTokens: 10000 },
    traces: [{ ...task, schemaVersion: 1, source: "imported", traceId: "supported", outcome: "success",
      steps: [{ nodeId: "build", input: "source", output: "result.json", dependsOn: [], check: "node check.cjs", status: "passed", evidenceRefs: ["actual-check"] }] }] } });

  assert.ok(learned.ok);
  assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome: { kind: "learned", versionId: learned.value.versionId }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok);
  const observed = input().observed!;
  const query = { boardRoot, scope: "project-a", sessionId: observed.sessionId, turnId: observed.turnId, observed };
  const reused = await readLearnedWorkflowJobForTurn(query);
  assert.ok(reused.ok);
  assert.equal(reused.value?.latestOutcome?.kind, "learned");
  const resumed = await readLearnedWorkflowJobForTurn({ ...query, observed: { ...observed, tokens: observed.tokens + 1 } });

  assert.ok(resumed.ok);
  assert.equal(resumed.value, null);
  const foreign = await readLearnedWorkflowJobForTurn({ ...query, scope: "another-project" });
  assert.ok(foreign.ok);
  assert.equal(foreign.value, null);
  assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome: { kind: "learned", versionId: learned.value.versionId }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok);
}));

test("classification can reserve only a prompt hash; private text and cross-turn observations are rejected", async () => fixture(async boardRoot => {
  const classified = { jobId: "classify-a", purpose: "classify" as const, scope: "project-a", sessionId: "session-a",
    turnId: `input:${"a".repeat(64)}`, promptHash: "a".repeat(64), allowance: { grantId: "classify-grant", maxCalls: 1, maxTokens: 1000 } };

  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: classified, issuedAt })).ok);
  assert.equal(parseWorkflowAutomaticInput({ ...classified, sourceTurnId: "actual-turn" }).ok, false);
  assert.equal(parseWorkflowAutomaticInput({ ...classified, sourceTurnId: "actual-turn", journalWatermark: 7 }).ok, true);
  assert.equal(parseWorkflowAutomaticInput({ ...classified, journalWatermark: -1 }).ok, false);
  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: { ...classified, jobId: "private", rawText: "private user body" }, issuedAt })).ok, false);
  const wrongObserved = { ...input(), observed: { ...input().observed!, turnId: "foreign-turn" } };

  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: wrongObserved, issuedAt })).ok, false);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "classify-a", issuedAt });
  assert.ok(claimed.ok);
  assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claimed.value, outcome: { kind: "classified", task: input().task! }, usage: { calls: 1, tokens: 100 }, issuedAt })).ok);
  const reused = await readWorkflowLearningJob({ boardRoot, jobId: "classify-a" });
  assert.ok(reused.ok);
  assert.equal(reused.value.job.state, "succeeded");
  assert.equal(reused.value.latestOutcome?.kind, "classified");
  assert.equal(reused.value.usage !== undefined && "calls" in reused.value.usage ? reused.value.usage.calls : -1, 1);
  assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId: "classify-a", issuedAt })).ok, false);
}));

test("readback artifact receipts remain metadata only and share the observation count limit", async () => fixture(async boardRoot => {
  const artifact = { toolCallId: "read-a", path: "result.json", evidenceRef: "read-receipt", sequence: 2 };
  const observed = { ...input().observed!, artifacts: [artifact] };
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: { ...input(), observed }, issuedAt })).ok);
  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: { ...input("private", "private-grant"), observed: { ...observed, artifacts: [{ ...artifact, content: "private-file-body" }] } }, issuedAt })).ok, false);
  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: { ...input("oversized", "oversized-grant"), observed: { ...observed, artifacts: Array.from({ length: 128 }, () => artifact) } }, issuedAt })).ok, false);
}));

test("zero allowance captures executed facts without a claim and an explicit fresh grant can fund them later", async () => fixture(async boardRoot => {
  const deferred = { ...input(), allowance: { grantId: "facts-only", maxCalls: 0, maxTokens: 0 } };
  const queued = await enqueueWorkflowLearningJob({ boardRoot, input: deferred, issuedAt });
  assert.ok(queued.ok);
  assert.equal(queued.value.state, "waiting_evidence");
  assert.deepEqual(await enqueueWorkflowLearningJob({ boardRoot, input: deferred, issuedAt }), queued);
  assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt })).ok, false);
  const saved = await readWorkflowLearningJob({ boardRoot, jobId: "job-a" });
  assert.ok(saved.ok);
  assert.deepEqual(saved.value.latestOutcome, { kind: "budget_exhausted", code: "awaiting_allowance" });
  assert.deepEqual(saved.value.usage, { calls: 0, tokens: 0 });
  assert.equal(saved.value.input.observed?.checks.length, 1);
  const funded = await retryWorkflowLearningJob({ boardRoot, jobId: "job-a", allowance: { grantId: "new-funding", maxCalls: 1, maxTokens: 2000 }, issuedAt });
  assert.ok(funded.ok);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claimed.ok);
  assert.equal(claimed.value.attempt, 2);
  const classified = { jobId: "not-funded-classify", purpose: "classify", scope: "project-a", sessionId: "session-a",
    turnId: `input:${"a".repeat(64)}`, promptHash: "a".repeat(64), allowance: { grantId: "not-funded", maxCalls: 0, maxTokens: 0 } };

  assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: classified, issuedAt })).ok, false);
}));

test("a crash in facts-only staging resumes known zero usage rather than inventing an unknown model call", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: { ...input(), allowance: { grantId: "facts-only", maxCalls: 0, maxTokens: 0 } }, issuedAt })).ok);
  const lines = (await readFile(path.join(boardRoot, "board-events.ndjson"), "utf8")).trimEnd().split("\n");
  const prefix = lines.slice(0, 4), decoded = decodeLog(`${prefix.join("\n")}\n`);
  assert.ok(decoded.ok);
  assert.equal(decoded.records[3]?.command.type, "start_job");
  const crashed = path.join(boardRoot, "interrupted-prefix");
  await mkdir(crashed);
  await writeFile(path.join(crashed, "board-events.ndjson"), `${prefix.join("\n")}\n`);
  const recovered = await recoverWorkflowLearningJob({ boardRoot: crashed, jobId: "job-a", expectedAttempt: 1, issuedAt });
  assert.ok(recovered.ok);
  const saved = await readWorkflowLearningJob({ boardRoot: crashed, jobId: "job-a" });
  assert.ok(saved.ok);
  assert.deepEqual(saved.value.usage, { calls: 0, tokens: 0 });
  assert.equal(saved.value.job.state, "waiting_evidence");
}));

test("explicit fresh grants fork known terminal jobs while retaining exact retry provenance and old results", async () => fixture(async boardRoot => {
  for (const kind of ["failed", "cancelled", "budget_exhausted"] as const) {
    const jobId = `terminal-${kind}`;

    assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(jobId, `grant-${kind}`), issuedAt })).ok);
    const claim = await claimWorkflowLearningJob({ boardRoot, jobId, issuedAt });
    assert.ok(claim.ok);
    assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome: { kind, code: "known-terminal" }, usage: { calls: 1, tokens: 20 }, issuedAt })).ok);
    const before = await readWorkflowLearningJob({ boardRoot, jobId });
    assert.ok(before.ok);
    const allowance = { grantId: `fresh-${kind}`, maxCalls: 1, maxTokens: 2000 };
    const retried = await retryWorkflowLearningJob({ boardRoot, jobId, allowance, issuedAt });
    assert.ok(retried.ok);
    assert.notEqual(retried.value.jobId, jobId);
    assert.deepEqual(retried.value.input.retryOf, { jobId, attempt: 1 });
    assert.deepEqual(await readWorkflowLearningJob({ boardRoot, jobId }), before);
    assert.deepEqual(await retryWorkflowLearningJob({ boardRoot, jobId, allowance, issuedAt }), retried);
    assert.equal((await enqueueWorkflowLearningJob({ boardRoot, input: { ...retried.value.input,
      task: { ...input().task!, taskFamily: { ...input().task!.taskFamily, id: "wrong-family" } } }, issuedAt })).ok, false);
  }
}));

test("charged quota and observed usage lower bounds remain distinct in an uncertain result", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claim = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claim.ok);
  const outcome = { kind: "failed" as const, code: "provider-outcome-unknown" };

  assert.equal((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome, usage: { calls: 1, tokens: 20, observedTokens: 21 }, issuedAt })).ok, false);
  const usage = { calls: 1, tokens: 4000, observedTokens: 20, uncertain: true };

  assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome, usage, issuedAt })).ok);
  const read = await readWorkflowLearningJob({ boardRoot, jobId: "job-a" });
  assert.ok(read.ok);
  assert.deepEqual(read.value.usage, usage);
  assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt })).ok, false);
}));

test("input is detached before awaits and allowance overruns cannot finish as successful learning", async () => fixture(async boardRoot => {
  const observed = { ...input().observed!, checks: input().observed!.checks.map(check => ({ ...check })) };
  const supplied = { ...input(), observed };
  const pending = enqueueWorkflowLearningJob({ boardRoot, input: supplied, issuedAt });

  observed.checks[0]!.command = "changed-after-boundary";
  const queued = await pending;
  assert.ok(queued.ok);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claimed.ok);
  assert.equal(claimed.value.input.observed?.checks[0]?.command, "node check.cjs");
  const result = await finishWorkflowLearningJob({ boardRoot, claim: claimed.value,
    outcome: { kind: "abstained", code: "proposed-success" }, usage: { calls: 3, tokens: 4100 }, issuedAt });
  assert.ok(result.ok);
  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs[0]?.state, "expired");
}));

test("restart settles a result committed before the terminal write instead of charging another model attempt", async () => fixture(async boardRoot => {
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: input(), issuedAt })).ok);
  const claimed = await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt });
  assert.ok(claimed.ok);
  const resultVersionId = `wflr_${contentHashOf(["job-a", 1]).slice(0, 32)}`, proposalId = `proposal_${resultVersionId}`;
  const prefix = await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "submit_proposal", commandId: "crash-prefix-submit", issuedAt,
      proposal: { proposalId, domain: "workflow", scope: "project-a", assetKind: "workflow", candidateRef: resultVersionId,
        hypothesis: "persisted finish prefix", observationRefs: [claimed.value.inputVersionId], risk: "low",
        requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } })).ok);
    assert.ok((await store.apply({ type: "commit_asset", commandId: "crash-prefix-commit", issuedAt, proposalId,
      versionId: resultVersionId, schemaVersion: 1, content: { type: "workflow_learning_result", schemaVersion: 1,
        jobId: "job-a", attempt: 1, inputVersionId: claimed.value.inputVersionId, inputHash: claimed.value.inputHash,
        outcome: { kind: "abstained", code: "nothing-reusable" }, usage: { calls: 1, tokens: 30 }, nextState: "succeeded" } })).ok);

    return { ok: true as const };
  });

  assert.ok(prefix.ok);
  const recovered = await recoverWorkflowLearningJob({ boardRoot, jobId: "job-a", expectedAttempt: 1, issuedAt });
  assert.ok(recovered.ok);
  assert.equal(recovered.value.state, "succeeded");
  const reread = await readWorkflowLearningJob({ boardRoot, jobId: "job-a" });
  assert.ok(reread.ok);
  assert.equal(reread.value.latestOutcome?.kind, "abstained");
  assert.equal(reread.value.job.attempt, 1);
  assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId: "job-a", issuedAt })).ok, false);
}));

for (const invalid of ["running_parent", "noncanonical_child", "reused_parent_grant", "reused_unrelated_grant"] as const) {
for (const boundary of ["claim", "reader"] as const) test(`classification retry ${boundary} rejects ${invalid} even when generic Board facts are hash-valid`, async () => fixture(async boardRoot => {
  const promptHash = contentHashOf("Make a checked report.");
  const original = { jobId: "classification-base", purpose: "classify" as const, scope: "project-a", sessionId: "session-a",
    turnId: `input:${promptHash}`, promptHash, sourceTurnId: "turn-a", journalWatermark: 7,
    allowance: { grantId: "base-grant", maxCalls: 1, maxTokens: 1000 } };

  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: original, issuedAt })).ok);
  const parent = await claimWorkflowLearningJob({ boardRoot, jobId: original.jobId, issuedAt });
  assert.ok(parent.ok);

  if (invalid !== "running_parent") assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: parent.value,
    outcome: { kind: "abstained", code: "no_classification" }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok);

  const grantId = invalid === "reused_parent_grant" ? original.allowance.grantId
    : invalid === "reused_unrelated_grant" ? "unrelated-grant" : "forged-fresh-grant";

  if (invalid === "reused_unrelated_grant") assert.ok((await enqueueWorkflowLearningJob({ boardRoot, issuedAt,
    input: { ...original, jobId: "unrelated-owner", allowance: { ...original.allowance, grantId } } })).ok);

  const jobId = invalid === "noncanonical_child" ? "forged-child"
    : workflowTerminalRetryId(original.jobId, 1, grantId);
  const child = { ...original, jobId, retryOf: { jobId: original.jobId, attempt: 1 }, allowance: { grantId, maxCalls: 1, maxTokens: 1000 } };
  const inputVersionId = `wfli_${contentHashOf([jobId, 1]).slice(0, 32)}`, proposalId = `proposal_${inputVersionId}`;
  const forged = await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "submit_proposal", commandId: `${jobId}:submit`, issuedAt,
      proposal: { proposalId, domain: "workflow", scope: child.scope, assetKind: "workflow", candidateRef: inputVersionId,
        hypothesis: "generic persistence is not authorized retry provenance", observationRefs: [child.turnId],
        risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } })).ok);
    assert.ok((await store.apply({ type: "commit_asset", commandId: `${jobId}:commit`, issuedAt, proposalId,
      versionId: inputVersionId, schemaVersion: 1, content: { type: "workflow_learning_input", schemaVersion: 1, attempt: 1, input: child } })).ok);

    return store.apply({ type: "enqueue_job", commandId: `${jobId}:enqueue`, issuedAt, job: { jobId, observationId: inputVersionId,
      domain: "workflow", scope: child.scope, maxAttempts: 8, dedupeKey: `workflow-job:${jobId}` } });
  });

  assert.ok(forged.ok);

  if (boundary === "claim") {
    assert.equal((await claimWorkflowLearningJob({ boardRoot, jobId, issuedAt })).ok, false);
    return;
  }

  const resultVersionId = `wflr_${contentHashOf([jobId, 1]).slice(0, 32)}`, resultProposal = `proposal_${resultVersionId}`;
  const result = await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", commandId: `${jobId}:start`, jobId, issuedAt })).ok);
    assert.ok((await store.apply({ type: "submit_proposal", commandId: `${jobId}:result-submit`, issuedAt, proposal: {
      proposalId: resultProposal, domain: "workflow", scope: child.scope, assetKind: "workflow", candidateRef: resultVersionId,
      hypothesis: "hash-valid generic result is not a paid retry", observationRefs: [inputVersionId], risk: "low",
      requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } })).ok);
    assert.ok((await store.apply({ type: "commit_asset", commandId: `${jobId}:result-commit`, issuedAt, proposalId: resultProposal,
      versionId: resultVersionId, schemaVersion: 1, content: { type: "workflow_learning_result", schemaVersion: 1, jobId, attempt: 1,
        inputVersionId, inputHash: contentHashOf({ type: "workflow_learning_input", schemaVersion: 1, attempt: 1, input: child }),
        nextState: "succeeded", outcome: { kind: "classified", task: input().task! }, usage: { calls: 1, tokens: 30 } } })).ok);

    return store.apply({ type: "complete_job", commandId: `${jobId}:finish`, issuedAt, jobId, next: "succeeded" });
  });

  assert.ok(result.ok);
  const read = await readSuccessfulWorkflowClassificationRetry({ boardRoot, input: original });

  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.code, invalid.startsWith("reused_") ? "job_grant_reused" : "invalid_job_retry");
}));
}
