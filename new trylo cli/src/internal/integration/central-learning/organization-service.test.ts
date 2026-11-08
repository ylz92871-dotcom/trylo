import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRewardV2BoardPort, RewardV2BoardError } from "../reward/v2-board-port.js";
import { createCentralOrganizationService } from "./organization-service.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/index.js";

const scope = "repo:organization-contract";
const query = { purpose: "Resolve the same conditional failure", conditionKeys: ["contract-uncertain"], sourceRefs: [],
  maximumEntries: 4, maximumCharacters: 20000 };
const decision = (id = "decision:first"): OrganizationDecision => ({ kind: "decision", decisionRef: id, purposeRef: "intent:repair",
  context: { purpose: query.purpose, conditionKeys: query.conditionKeys, known: ["The failure occurred during handoff"], residual: ["Which premise failed?"] },
  program: { programRef: "tool:contract-research", depth: "bounded shallow investigation", timing: "now" },
  expectation: { change: "Find a testable parameter boundary", uncertainties: ["Economic benefit remains unidentified"] },
  alternatives: ["Investigate workflow ordering", "Wait for further use"], issueRefs: ["issue:original"], stageRefs: ["stage:original"],
  sourceRefs: ["journal:original"], experienceUse: null });
const progress = (): OrganizationFeedback => ({ kind: "feedback", decisionRef: "decision:first", unitRef: "worker-result:1", supersedes: null,
  sourceRefs: ["worker-result:1"], result: { kind: "progress", summary: "A parameter boundary was identified", remaining: ["Await use"], resultRefs: ["artifact:boundary"] } });
const knowledge = (supportFactId: string): OrganizationKnowledge => ({ kind: "knowledge", knowledgeId: "practice:contract-first", supersedes: null,
  statement: "Investigate the contract before rewriting the workflow", conditions: "When the parameter contract is not known",
  conditionKeys: ["contract-uncertain"], exceptions: "Does not apply when the contract is already demonstrated", exceptionKeys: ["contract-demonstrated"],
  implication: "Choose tool contract research before workflow research", supportFactIds: [supportFactId], counterexampleFactIds: [], state: "proposed" });

async function fixture(run: (service: ReturnType<typeof createCentralOrganizationService>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "trylo-organization-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  try { await run(createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true }), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function revision(service: ReturnType<typeof createCentralOrganizationService>) {
  const loaded = await service.read();
  assert.equal(loaded.status, "ready");
  if (loaded.status !== "ready") throw new Error("fixture_read_failed");
  return loaded.revision;
}

test("original Board persists conditional organization knowledge and the next decision records actual changed choice", async () => {
  await fixture(async (service, root) => {
    assert.equal((await service.freezeDecision(decision(), 0)).status, "saved");
    const result = await service.observe(progress(), await revision(service));
    assert.equal(result.status, "saved");

    if (result.status !== "saved") return;

    assert.equal((await service.reviseKnowledge(knowledge(result.factId), result.revision)).status, "saved");
    const reopened = createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true });
    const recalled = await reopened.prepareRecall(query);
    assert.equal(recalled.status, "ready");

    if (recalled.status !== "ready") return;

    assert.equal(recalled.packet.entries.length, 1);
    assert.match(recalled.packet.materialJson, /not_business_evidence/);
    assert.match(recalled.packet.materialJson, /Await use/);
    const changed: OrganizationDecision = { ...decision("decision:next"), experienceUse: { packet: recalled.packet,
      deliveryRef: "controlled-provider:actual-response", changes: [{ knowledgeFactId: recalled.packet.entries[0]!.factId,
        choice: "program", before: "workflow:rewrite", after: "tool:contract-research", reason: "Contract remains unknown in this task" }] } };

    assert.equal((await reopened.freezeDecision(changed, recalled.revision)).status, "saved");
    const final = await reopened.read();
    assert.equal(final.status, "ready");

    if (final.status !== "ready") return;

    assert.equal(final.projection.decisions[1]?.value.experienceUse?.changes[0]?.after, "tool:contract-research");
    const exception = await reopened.prepareRecall({ ...query, conditionKeys: ["contract-demonstrated"] });

    assert.equal(exception.status, "ready");

    if (exception.status === "ready") {
      assert.deepEqual(exception.packet.entries[0]?.matchedExceptions, ["contract-demonstrated"]);
      assert.deepEqual(exception.packet.entries[0]?.missingConditions, ["contract-uncertain"]);
    }

    const stable = await reopened.prepareRecall(query);
    assert.equal(stable.status, "ready");

    if (stable.status === "ready") assert.equal(stable.packet.recallRef, recalled.packet.recallRef, "consumption is not fresh evidence");
  });
});

test("late feedback replaces one source unit; exposure is required and unknown attribution remains unknown", async () => {
  await fixture(async service => {
    await service.freezeDecision(decision(), 0);
    const pending: OrganizationFeedback = { ...progress(), unitRef: "business:task-2", sourceRefs: ["business:task-2"],
      result: { kind: "outcome", state: "pending", summary: "No business use yet", exposureRef: null, attribution: "unknown" } };
    const first = await service.observe(pending, await revision(service));
    assert.equal(first.status, "saved");
    if (first.status !== "saved") return;

    await service.reviseKnowledge(knowledge(first.factId), first.revision);
    const observed: OrganizationFeedback = { ...pending, supersedes: first.factId,
      result: { kind: "outcome", state: "observed", summary: "Original business owner reported less rework", exposureRef: "exposure:2", attribution: "source_reported" } };

    assert.deepEqual(await service.observe(observed, await revision(service)), { status: "rejected", reason: "organization_outcome_not_exposed" });
    await service.observe({ ...progress(), unitRef: "use:2", sourceRefs: ["use:2"], result: { kind: "adoption", state: "used",
      artifactRefs: ["artifact:boundary"], exposureRef: "exposure:2" } }, await revision(service));
    const second = await service.observe(observed, await revision(service));
    assert.equal(second.status, "saved");
    if (second.status !== "saved") return;

    const replay = await service.observe(observed, 0);
    assert.equal(replay.status, "saved");

    if (replay.status === "saved") assert.equal(replay.idempotent, true);

    const correction = await service.observe({ ...observed, supersedes: second.factId, sourceRefs: ["business:corrected-owner"],
      result: { kind: "outcome", state: "unknown", summary: "Later evidence does not identify the improvement", exposureRef: "exposure:2", attribution: "unknown" } }, await revision(service));

    assert.equal(correction.status, "saved");
    if (correction.status !== "saved") return;

    const read = await service.read();
    assert.equal(read.status, "ready");
    if (read.status !== "ready") return;

    assert.equal(read.projection.feedback.filter(row => row.value.result.kind === "outcome").length, 1);
    const recall = await service.prepareRecall(query);
    assert.equal(recall.status, "ready");
    if (recall.status !== "ready") return;

    assert.ok(recall.packet.entries[0]?.evidence.some(row => row.factId === correction.factId));
    assert.deepEqual(recall.packet.entries[0]?.evidenceRevisions, [{ citedFactId: first.factId, effectiveFactId: correction.factId }]);
    const currentSource = await service.prepareRecall({ ...query, conditionKeys: [], sourceRefs: ["business:corrected-owner"] });
    if (currentSource.status !== "ready") throw new Error("fixture_recall_failed");

    assert.equal(currentSource.packet.entries.length, 1);
    assert.deepEqual(await service.reviseKnowledge({ ...knowledge(first.factId), knowledgeId: "practice:stale" }, await revision(service)),
      { status: "rejected", reason: "organization_knowledge_source_not_current" });
  });
});

test("unrelated Board changes do not change recall identity; stale writes, fake consumption and self evidence are rejected", async () => {
  await fixture(async (service, root) => {
    await service.freezeDecision(decision(), 0);
    const source = await service.observe(progress(), await revision(service));
    if (source.status !== "saved") throw new Error("fixture_write_failed");

    await service.reviseKnowledge(knowledge(source.factId), source.revision);
    const before = await service.prepareRecall(query);
    if (before.status !== "ready") throw new Error("fixture_recall_failed");

    const board = createRewardV2BoardPort(root, () => true);

    await board.append(before.revision, { id: "unrelated:1", scope: "repo:elsewhere", kind: "projection", algorithmVersion: "unrelated-v1", payloadJson: "{}" });
    const after = await service.prepareRecall(query);
    if (after.status !== "ready") throw new Error("fixture_recall_failed");

    assert.equal(after.packet.recallRef, before.packet.recallRef);
    assert.equal((await service.freezeDecision(decision("decision:stale"), before.revision)).status, "stale");
    assert.deepEqual(await service.observe({ ...progress(), unitRef: "summary:fake", sourceRefs: [source.factId] }, after.revision),
      { status: "rejected", reason: "organization_record_invalid" });
    assert.deepEqual(await service.observe({ ...progress(), unitRef: "recall:fake", sourceRefs: [before.packet.recallRef] }, after.revision),
      { status: "rejected", reason: "organization_record_invalid" });
    const invalidUse: OrganizationDecision = { ...decision("decision:fake"), experienceUse: { packet: after.packet,
      deliveryRef: "controlled-provider:response", changes: [{ knowledgeFactId: "not-delivered", choice: "wait", before: "run", after: "wait", reason: "invalid use" }] } };

    assert.deepEqual(await service.freezeDecision(invalidUse, after.revision), { status: "rejected", reason: "organization_use_not_delivered" });
    const bounded = await service.prepareRecall({ ...query, maximumCharacters: 512 });
    if (bounded.status === "ready") assert.equal(bounded.packet.entries.length, 0, "do not truncate away contrary conditions");
  });
});

test("a new credential policy rechecks previously saved organization text on read and recall", async () => {
  await fixture(async (service, root) => {
    await service.freezeDecision(decision(), 0);
    const source = await service.observe({ ...progress(), result: { kind: "progress", summary: "fixture-later-private-value",
      remaining: [], resultRefs: [] } }, await revision(service));

    assert.equal(source.status, "saved");
    const guarded = createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true, secrets: ["fixture-later-private-value"] });

    assert.deepEqual(await guarded.read(), { status: "rejected", reason: "organization_sensitive_content" });
    assert.deepEqual(await guarded.prepareRecall(query), { status: "rejected", reason: "organization_sensitive_content" });
  });
});

test("disabled service does no I/O, sensitive input is rejected, and unknown append suspends retry", async () => {
  let reads = 0, writes = 0;
  const board = { async read() {
    reads++;
    return { revision: 0, facts: [] };
  },

    async append() {
      writes++;
      throw new Error("lost acknowledgement");
    } };
  const disabled = createCentralOrganizationService({ boardRoot: "unused", scope, enabled: () => false, board });

  assert.equal((await disabled.prepareRecall(query)).status, "disabled");
  assert.equal((await disabled.freezeDecision(decision(), 0)).status, "disabled");
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const service = createCentralOrganizationService({ boardRoot: "unused", scope, enabled: () => true, board, secrets: ["fixture-private-token"] });

  assert.deepEqual(await service.freezeDecision({ ...decision(), expectation: { change: "fixture-private-token", uncertainties: [] } }, 0),
    { status: "rejected", reason: "organization_sensitive_content" });
  assert.equal(reads, 0);
  assert.deepEqual(await service.freezeDecision(decision(), 0), { status: "rejected", reason: "organization_write_unconfirmed" });
  assert.deepEqual(await service.freezeDecision(decision(), 0), { status: "rejected", reason: "organization_writer_suspended" });
  assert.equal(writes, 1);
});

test("definite pre-entry contention can resume but an unknown contention outcome still suspends", async () => {
  let attempts = 0;
  const read = async () => ({ revision: 0, facts: [] });
  const service = createCentralOrganizationService({ boardRoot: "unused", scope, enabled: () => true,
    board: { read, async append() {
      if (++attempts === 1) throw new RewardV2BoardError("multi_writer", "not_started");
      return { status: "written", revision: 1, idempotent: false };
    } } });

  assert.deepEqual(await service.freezeDecision(decision(), 0), { status: "stale" });
  assert.equal((await service.freezeDecision(decision(), 0)).status, "saved");
  assert.equal(attempts, 2);

  let unknownAttempts = 0;
  const unknown = createCentralOrganizationService({ boardRoot: "unused", scope, enabled: () => true,
    board: { read, async append() {
      unknownAttempts++;
      throw new RewardV2BoardError("multi_writer");
    } } });

  assert.deepEqual(await unknown.freezeDecision(decision(), 0), { status: "rejected", reason: "organization_write_unconfirmed" });
  assert.deepEqual(await unknown.freezeDecision(decision(), 0), { status: "rejected", reason: "organization_writer_suspended" });
  assert.equal(unknownAttempts, 1);
});
