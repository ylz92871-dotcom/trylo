import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralBudgetProjection } from "./central-budget-state.js";
import type { CoordinationAction } from "./coordination-contract.js";

const at = "2026-11-04T00:00:00.000Z", scope = "workspace:budget-store";
const open: CoordinationAction = { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope,
  unit: "total_model_tokens", limits: { tokens: 1000, calls: 4, steps: 4 }, authorizationRef: "host:explicit" } };
const command = (action: CoordinationAction, id: string) => ({ type: "coordinate_learning" as const, commandId: id, issuedAt: at, action });

async function directory(t: TestContext) {
  const base = testScratchPath("central-budget-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.ok(!path.relative(base, root).startsWith(".."));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("root-only snapshot uses version 3 and compact retains the new-action downgrade barrier", async t => {
  const root = await directory(t);
  const result = await withBoardWriter(root, async store => {
    const written = await store.apply(command(open, "open"));
    assert.ok(written.ok);
    const compacted = await store.compact(0);
    assert.ok(compacted.ok);
    return compacted;
  });
  assert.ok(result.ok);
  const snapshot: unknown = JSON.parse(await readFile(path.join(root, "board-snapshot.json"), "utf8"));

  assert.ok(typeof snapshot === "object" && snapshot !== null && "schemaVersion" in snapshot);
  assert.equal(snapshot.schemaVersion, 3);
  const log = await readFile(path.join(root, "board-events.ndjson"), "utf8");
  assert.match(log, /open_budget/);
  const loaded = await createBoardReader(root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.centralLearningBudgets?.length, 1);
});

test("process-style reopen preserves managed commitments and exact command replay", async t => {
  const root = await directory(t);
  const funded = await withBoardWriter(root, async store => {
    let revision = 0;

    for (const name of ["a", "b"]) {
      const reported = await store.apply(command({ kind: "report", scope, issueId: name, problemKey: name,
        report: { reportId: `report:${name}`, source: { subsystem: "method", taskId: name, versionId: name }, facts: ["grounded"], evidenceRefs: [name] } }, `report:${name}`));
      assert.ok(reported.ok);
      const decided = await store.apply(command({ kind: "decide", issueId: name, expectedRevision: 1, decision: "focused_learning", reason: "authorized", sourceRefs: [name] }, `decide:${name}`));
      assert.ok(decided.ok);
      revision = decided.state.sequence;
    }

    const opened = await store.apply(command({ ...open, expectedSequence: revision }, "open"));
    assert.ok(opened.ok);

    return store.apply(command({ kind: "fund", issueId: "a", expectedRevision: 2, grantId: "grant:a", domain: "prompt",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 800, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 },
      budgetId: "root", expectedSequence: opened.state.sequence, authorizationRef: "host:allocation", planRef: "plan:first" }, "fund:a"));
  });
  assert.ok(funded.ok);
  const loaded = await createBoardReader(root).load();
  assert.ok(loaded.ok);
  assert.equal(centralBudgetProjection(loaded.state, "root")?.available.tokens, 200);
  const raced = await Promise.all(["candidate:1", "candidate:2"].map(id => withBoardWriter(root, store => store.apply(command({ kind: "fund",
    issueId: "b", expectedRevision: 2, grantId: `grant:${id}`, domain: "tool", allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 200, maxCalls: 1, maxSteps: 1, maxPromptChars: 10000 }, budgetId: "root", expectedSequence: loaded.state.sequence,
    authorizationRef: "host:allocation", planRef: "plan:race" }, id)))));

  assert.equal(raced.filter(item => item.ok).length, 1);
  const final = await createBoardReader(root).load();
  assert.ok(final.ok);
  assert.equal(centralBudgetProjection(final.state, "root")?.occupied.tokens, 1000);
  assert.equal(final.state.centralLearningGrants?.length, 2);
});

test("the original Board writer atomically claims the expected source revision while legacy claims remain compatible", async t => {
  const root = await directory(t);
  let serial = 0;
  const send = (action: CoordinationAction) => withBoardWriter(root, store => store.apply(command(action, `source-claim-cas:${++serial}`)));
  const accept = async (action: CoordinationAction) => {
    const result = await send(action);
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const read = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  await accept(open);
  await accept({ kind: "report", scope, issueId: "source-cas", problemKey: "method:source-cas", report: {
    reportId: "report:source-cas", source: { subsystem: "method", taskId: "task:source-cas", versionId: "method:source-cas" },
    facts: ["Original source before preparation"], evidenceRefs: ["evidence:source-cas"] } });
  await accept({ kind: "decide", issueId: "source-cas", expectedRevision: 1, decision: "focused_learning",
    reason: "TEST explicit source selection", sourceRefs: ["report:source-cas"] });
  let state = await read();

  state = await accept({ kind: "fund", issueId: "source-cas", expectedRevision: state.learningIssues![0]!.revision,
    grantId: "grant:source-cas", domain: "prompt", expectedSequence: state.sequence, budgetId: "root",
    authorizationRef: "host:source-cas", planRef: "plan:source-cas", allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 600, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } });
  const preparedRevision = state.learningIssues![0]!.revision, grant = state.centralLearningGrants![0]!, jobId = grant.jobId;

  assert.equal(state.jobs.find(row => row.jobId === jobId)?.state, "queued");
  assert.equal(grant.claim, undefined);
  const updated = await accept({ kind: "report", scope, issueId: "source-cas", problemKey: "method:source-cas",
    expectedRevision: preparedRevision, report: { reportId: "report:source-cas-new-evidence",
      source: { subsystem: "method", taskId: "task:new-evidence", versionId: "method:source-cas" },
      facts: ["New source evidence arrives before the queued claim"], evidenceRefs: ["evidence:new-source-cas"] } });
  const job = updated.jobs.find(row => row.jobId === jobId)!;

  assert.equal(job.state, "queued");
  assert.equal(job.attempt, 0);
  assert.ok(updated.learningIssues![0]!.revision > preparedRevision);
  const stale = await send({ kind: "claim", jobId, expectedAttempt: job.attempt, expectedIssueRevision: preparedRevision,
    claimId: "claim:stale-source", ownerId: "worker:source-cas", expiresAt: "2026-11-04T00:01:00.000Z" });

  assert.ok(!stale.ok, "a queued job does not make a stale source revision claimable");
  assert.equal(stale.reason, "learning_claim_conflict");
  assert.equal(stale.detail, "source_issue_revision_changed");
  assert.deepEqual(await read(), updated, "the rejected writer transaction changes no sequence, attempt, claim or applied command");
  const fresh = await accept({ kind: "claim", jobId, expectedAttempt: job.attempt,
    expectedIssueRevision: updated.learningIssues![0]!.revision, claimId: "claim:fresh-source", ownerId: "worker:source-cas",
    expiresAt: "2026-11-04T00:01:00.000Z" });

  assert.equal(fresh.jobs.find(row => row.jobId === jobId)?.attempt, 1);
  assert.equal(fresh.centralLearningGrants![0]!.claim?.claimId, "claim:fresh-source");
  await accept({ kind: "finish", jobId, claimId: "claim:fresh-source", result: { kind: "yielded", reason: "TEST original worker boundary" } });
  state = await accept({ kind: "report", scope, issueId: "source-cas", problemKey: "method:source-cas", report: {
    reportId: "report:legacy-next-evidence", source: { subsystem: "method", taskId: "task:legacy-next", versionId: "method:source-cas" },
    facts: ["A later report preserves the optional legacy claim contract"], evidenceRefs: ["evidence:legacy-next"] } });
  assert.equal(state.jobs.find(row => row.jobId === jobId)?.state, "queued");
  const legacy = await accept({ kind: "claim", jobId, expectedAttempt: 1, claimId: "claim:legacy-source", ownerId: "worker:legacy",
    expiresAt: "2026-11-04T00:01:00.000Z" });

  assert.equal(legacy.jobs.find(row => row.jobId === jobId)?.attempt, 2);
  assert.equal(legacy.centralLearningGrants![0]!.claim?.claimId, "claim:legacy-source");
});
