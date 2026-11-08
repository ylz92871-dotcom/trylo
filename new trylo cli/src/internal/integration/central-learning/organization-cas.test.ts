import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralOrganizationService, type OrganizationPublication } from "./organization-service.js";
import { consumeOrganizationCasStale, createOrganizationCasRetryBudget, ORGANIZATION_CAS_ATTEMPTS,
  OrganizationCasBusyError, publishOrganizationWithCas } from "./organization-cas.js";

const scope = "workspace:organization-cas", now = "2026-11-05T00:00:00.000Z";
const decision = (decisionRef = "decision:original"): OrganizationDecision => ({ kind: "decision", decisionRef, purposeRef: "intent:original",
  context: { purpose: "Investigate the original handoff contract", conditionKeys: ["contract-unknown"], known: [], residual: ["Find the missing premise"] },
  program: { programRef: "tool:contract", depth: "bounded investigation", timing: "now" },
  expectation: { change: "Make the original premise explicit", uncertainties: ["Actual use remains unknown"] }, alternatives: ["Wait for actual use"],
  issueRefs: ["issue:original"], stageRefs: ["stage:original"], sourceRefs: ["journal:original"], experienceUse: null });
const knowledge = (supportFactId: string): OrganizationKnowledge => ({ kind: "knowledge", knowledgeId: "practice:original", supersedes: null,
  statement: "Inspect the original contract before changing the workflow", conditions: "The handoff premise remains unknown", conditionKeys: ["contract-unknown"],
  exceptions: "The premise was already demonstrated", exceptionKeys: ["contract-demonstrated"], implication: "Research the original contract first",
  supportFactIds: [supportFactId], counterexampleFactIds: [], state: "proposed" });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-organization-cas-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-organization-cas-/);
    await rm(root, { recursive: true, force: true });
  });
  let serial = 0;
  const seeded = await withBoardWriter(root, async store => {
    const send = (action: CoordinationAction) => store.apply({ type: "coordinate_learning", commandId: `fixture:pa:${++serial}`, issuedAt: now, action });
    assert.ok((await send({ kind: "report", scope, issueId: "issue:pa", problemKey: "ordinary-pa-resource",
      report: { reportId: "report:pa", source: { teamRunId: "team:pa", taskId: "task:pa", memberId: "personal_agent" }, facts: ["The original resource is needed"], evidenceRefs: [] } })).ok);
    assert.ok((await send({ kind: "decide", issueId: "issue:pa", expectedRevision: 1, decision: "focused_learning", reason: "Inspect the resource", sourceRefs: [] })).ok);
    return send({ kind: "fund", issueId: "issue:pa", expectedRevision: 2, grantId: "grant:pa", domain: "collaboration",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 } });
  });
  assert.ok(seeded.ok, JSON.stringify(seeded));
  const read = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const grant = (await read()).centralLearningGrants!.find(row => row.grantId === "grant:pa")!;
  const receipts = createCollaborationRuntimeReceiptWriter({ board: createFileCollaborationBoard(root), scope });
  const paReceipt = async () => {
    const id = `ordinary-pa:${++serial}`;
    const result = await receipts.record({ schemaVersion: 1, receiptId: id, phase: "resource_query", scope, issueId: grant.issueId,
      jobId: grant.jobId, grantId: grant.grantId, requestId: id, owner: "experience", query: "Inspect the existing personal-agent resource",
      resultRefs: [], summary: "Original PA resource query boundary", boundary: { executionId: "execution:pa", taskId: "task:pa", round: 1, role: "personal_agent" }, recordedAt: now });
    assert.ok(result.ok, JSON.stringify(result));
  };
  const service = createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true });
  const inputs = async () => {
    const first = await service.read();
    assert.equal(first.status, "ready");
    if (first.status !== "ready") throw new Error("fixture_read_failed");
    const frozen = await service.freezeDecision(decision(), first.revision);
    assert.equal(frozen.status, "saved");
    if (frozen.status !== "saved") throw new Error("fixture_freeze_failed");
    const feedback: OrganizationFeedback = { kind: "feedback", decisionRef: "decision:original", unitRef: "worker:original", supersedes: null,
      sourceRefs: ["worker:original"], result: { kind: "progress", summary: "The original premise was identified", remaining: ["Await actual use"], resultRefs: ["artifact:original"] } };
    const observed = await service.observe(feedback, frozen.revision);
    assert.equal(observed.status, "saved");
    if (observed.status !== "saved") throw new Error("fixture_feedback_failed");
    return knowledge(observed.factId);
  };

  return { root, service, read, paReceipt, inputs };
}

test("freeze retries the same fixed decision after a real PA receipt advances only the physical Board prefix", async t => {
  const f = await fixture(t), record = decision(), before = JSON.stringify(record);
  let reads = 0, writes = 0;
  const result = await publishOrganizationWithCas({ record, phase: "publication", enabled: () => true,

    read: async () => {
      reads++;
      return f.service.read();
    }, publish: async (same, revision) => {
      assert.equal(same, record);
      assert.equal(JSON.stringify(same), before);
      if (++writes === 1) await f.paReceipt();
      return f.service.freezeDecision(same, revision);
    } });

  assert.equal(result.status, "saved");
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal(JSON.stringify(record), before);
  const board = await f.read();
  assert.equal(board.collaborationRuntimeReceipts?.length, 1);
  assert.equal(board.rewardV2Facts?.filter(row => row.id === buildOrganizationRecord(scope, record).id).length, 1);
});

test("knowledge reuses the exact payload and fact identity when a real PA receipt wins the original append CAS", async t => {
  const f = await fixture(t), record = await f.inputs(), before = JSON.stringify(record), original = createRewardV2BoardPort(f.root, () => true);
  let appends = 0, writes = 0;
  const service = createCentralOrganizationService({ boardRoot: f.root, scope, enabled: () => true, board: { read: original.read,

    async append(revision, fact) {
      assert.equal(fact.id, buildOrganizationRecord(scope, record).id);
      if (++appends === 1) await f.paReceipt();
      return original.append(revision, fact);
    } } });
  const result = await publishOrganizationWithCas({ record, phase: "result", enabled: () => true, read: service.read,

    publish: (same, revision) => {
      writes++;
      assert.equal(same, record);
      return service.reviseKnowledge(same, revision);
    } });

  assert.equal(result.status, "saved");
  assert.equal(writes, 2);
  assert.equal(appends, 2);
  assert.equal(JSON.stringify(record), before);
  const view = await service.read();
  assert.equal(view.status, "ready");
  if (view.status === "ready") assert.equal(view.projection.knowledge.length, 1);
});

test("a changed semantic knowledge head returns the original candidate or strict rejection without repair or another retry", async t => {
  const f = await fixture(t), record = await f.inputs(), before = JSON.stringify(record);
  let writes = 0;
  const result = await publishOrganizationWithCas({ record, phase: "result", enabled: () => true, read: f.service.read,

    publish: async (same, revision) => {
      assert.equal(same, record);
      if (++writes === 1) assert.equal((await f.service.reviseKnowledge({ ...same, statement: "The other original head already exists" }, revision)).status, "saved");
      return f.service.proposeKnowledge(same, revision);
    } });

  assert.equal(result.status, "candidate_rejected");
  assert.equal(writes, 2);

  if (result.status === "candidate_rejected") assert.equal(result.reason, "organization_knowledge_revision_conflict");

  let strictWrites = 0;
  const strict = await publishOrganizationWithCas({ record, phase: "result", enabled: () => true, read: f.service.read,

    publish: (same, revision) => {
      strictWrites++;
      return f.service.reviseKnowledge(same, revision);
    } });

  assert.deepEqual(strict, { status: "rejected", reason: "organization_knowledge_revision_conflict" });
  assert.equal(strictWrites, 1);
  assert.equal(JSON.stringify(record), before);
});

test("an actual append followed by a lost acknowledgement remains unconfirmed and is never retried", async t => {
  const f = await fixture(t), original = createRewardV2BoardPort(f.root, () => true);
  let writes = 0;
  const service = createCentralOrganizationService({ boardRoot: f.root, scope, enabled: () => true,
    board: { read: original.read, async append(revision, fact) {
      writes++;
      await original.append(revision, fact);
      throw new Error("lost append acknowledgement");
    } } });
  const result = await publishOrganizationWithCas({ record: decision(), phase: "publication", enabled: () => true, read: service.read, publish: service.freezeDecision });

  assert.deepEqual(result, { status: "rejected", reason: "organization_write_unconfirmed" });
  assert.equal(writes, 1);
  assert.equal((await f.read()).rewardV2Facts?.length, 1, "the unknown write may already be committed");
  const next = await publishOrganizationWithCas({ record: decision(), phase: "publication", enabled: () => true, read: service.read, publish: service.freezeDecision });

  assert.deepEqual(next, { status: "rejected", reason: "organization_writer_suspended" });
  assert.equal(writes, 1);
});

test("four definite physical stale outcomes or four read-stale outcomes throw only the typed busy boundary", async t => {
  const f = await fixture(t), record = decision();
  let writes = 0, observedRevision = -1;
  const busy = (error: unknown) => error instanceof OrganizationCasBusyError && error.definiteUnwritten === true
    && error.phase === "publication" && error.attempts === ORGANIZATION_CAS_ATTEMPTS && error.message === "organization_publication_busy";

  await assert.rejects(publishOrganizationWithCas({ record, phase: "publication", enabled: () => true,

    read: async () => {
      const read = await f.service.read();
      if (read.status === "ready") observedRevision = read.revision;
      return read;
    },

    publish: async (same, revision) => {
      writes++;
      await f.paReceipt();
      return f.service.freezeDecision(same, revision);
    } }),
  error => busy(error) && error instanceof OrganizationCasBusyError && error.observedRevision === observedRevision);
  assert.equal(writes, 4);
  assert.equal((await f.read()).rewardV2Facts?.length ?? 0, 0);
  assert.equal((await f.read()).sequence, observedRevision + 1, "busy never guesses the revision after the final stale");
  let reads = 0;
  const unseen = createOrganizationCasRetryBudget();

  await assert.rejects(publishOrganizationWithCas({ record, phase: "publication", budget: unseen, enabled: () => true,

    read: async () => {
      reads++;
      return { status: "stale" };
    }, publish: async () => { throw new Error("stale reads cannot publish"); } }), busy);
  assert.equal(reads, 4);
  assert.equal(unseen.observedRevision, undefined);
  assert.ok(observedRevision >= 0);
});

test("a shared stale budget preserves earlier success and bounds the whole fixed-payload batch", async t => {
  const f = await fixture(t), budget = createOrganizationCasRetryBudget();
  let first = 0, second = 0;
  const committed = await publishOrganizationWithCas({ record: decision("decision:first"), phase: "publication", budget, enabled: () => true, read: f.service.read,

    publish: async (same, revision) => {
      if (++first === 1) await f.paReceipt();
      return f.service.freezeDecision(same, revision);
    } });

  assert.equal(committed.status, "saved");
  assert.equal(budget.staleAttempts, 1);
  await assert.rejects(publishOrganizationWithCas({ record: decision("decision:pending"), phase: "result", budget, enabled: () => true, read: f.service.read,

    publish: async (same, revision) => {
      second++;
      await f.paReceipt();
      return f.service.freezeDecision(same, revision);
    } }),
  error => error instanceof OrganizationCasBusyError && error.phase === "result" && error.definiteUnwritten);
  assert.equal(second, 3);
  assert.equal(budget.staleAttempts, 4);
  assert.equal((await f.read()).rewardV2Facts?.length, 1);
  const recall = createOrganizationCasRetryBudget();

  for (let index = 1; index < 4; index++) consumeOrganizationCasStale(recall, "recall");

  assert.throws(() => consumeOrganizationCasStale(recall, "recall"), error => error instanceof OrganizationCasBusyError && error.phase === "recall");
  const metadata = createOrganizationCasRetryBudget(), revisions = [10, NaN, 8, 12];
  let reads = 0;

  await assert.rejects(publishOrganizationWithCas({ record: decision("decision:metadata"), phase: "publication", budget: metadata, enabled: () => true,
    read: async () => ({ status: "ready", revision: revisions[reads++]! }), publish: async (): Promise<OrganizationPublication> => ({ status: "stale" }) }),
  error => error instanceof OrganizationCasBusyError && error.observedRevision === 12);
});

test("cancel and disabled gates stop before or after reads and writes without consuming stale budget", async t => {
  const f = await fixture(t);
  for (const stop of ["cancel", "disable"] as const) for (const boundary of ["before_read", "after_read", "before_write", "after_write"] as const) {
    let enabled = true, checks = 0, reads = 0, writes = 0;
    const signal = new AbortController(), budget = createOrganizationCasRetryBudget();
    const halt = () => { if (stop === "cancel") signal.abort();else enabled = false; };

    if (boundary === "before_read") halt();

    const result = await publishOrganizationWithCas({ record: decision(), phase: "publication", signal: signal.signal, budget,

      enabled: () => {
        if (++checks === 3 && boundary === "before_write") halt();
        return enabled;
      },

      read: async () => {
        reads++;
        const value = await f.service.read();
        if (boundary === "after_read") halt();
        return value;
      },

      publish: async (): Promise<OrganizationPublication> => {
        writes++;
        halt();
        return { status: "stale" };
      } });

    assert.deepEqual(result, stop === "cancel" ? { status: "rejected", reason: "organization_cancelled" } : { status: "disabled" });
    assert.equal(reads, boundary === "before_read" ? 0 : 1);
    assert.equal(writes, boundary === "after_write" ? 1 : 0);
    assert.equal(budget.staleAttempts, 0);
  }
});

test("rejected statuses and original throws never become physical stale retries", async t => {
  const f = await fixture(t), record = decision(), rejected = { status: "rejected" as const, reason: "stale" };
  let writes = 0;
  const result = await publishOrganizationWithCas({ record, phase: "publication", enabled: () => true, read: async () => rejected,

    publish: async () => {
      writes++;
      return rejected;
    } });
  assert.equal(result, rejected);
  assert.equal(writes, 0);
  const failure = new Error("original read or append error");

  await assert.rejects(publishOrganizationWithCas({ record, phase: "publication", enabled: () => true,
    read: async () => { throw failure; }, publish: async () => rejected }), error => error === failure);
  await assert.rejects(publishOrganizationWithCas({ record, phase: "publication", enabled: () => true, read: f.service.read,

    publish: async () => {
      writes++;
      throw failure;
    } }), error => error === failure);
  assert.equal(writes, 1);
});
