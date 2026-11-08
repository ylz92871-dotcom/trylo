import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBoardWriter, createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import { createLearningContentService } from "./service.js";
import { topicDomainCandidates } from "../learning-topics/domain-candidates.js";

test("canonical PA content reaches semantic materials, Board persists results, WS1 consumes residual, and next preparation retrieves the old application", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "trylo-content-")), scope = "repo:a";
  try {
    const report = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "report:1",
      issuedAt: "2026-11-04T10:00:00Z", action: { kind: "report", issueId: "issue:1", problemKey: "conditional-result", scope,
        report: { reportId: "report:1", source: { subsystem: "tool", taskId: "task:1", versionId: "v1" },
          facts: ["Original conditional requirement"], evidenceRefs: ["request"] } } }));

    assert.ok(report.ok);
    const focused = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "focus:1",
      issuedAt: "2026-11-04T10:01:00Z", action: { kind: "decide", issueId: "issue:1", expectedRevision: 1,
        decision: "focused_learning", reason: "Preserve the original requirement and investigate the conditional residue.", sourceRefs: ["request"] } }));

    assert.ok(focused.ok);
    const service = createLearningContentService({ boardRoot, scope, domain: "tool", enabled: () => true });
    const seed = { issueId: "issue:1", records: [{ ref: "request", runId: "run:1", sequence: 0, scope,
      origin: "user_statement" as const, text: "Use the known answer for A; find whether it extends to B." }],
      requirements: [{ id: "requirement:1", requirement: "Conditional use of the known answer", conditions: ["A or B"],
        answerRequirement: "Preserve original conditions", sourceRefs: ["request"] }], answers: [], materials: [] };
    const guarded = createLearningContentService({ boardRoot, scope, domain: "tool", enabled: () => true, secrets: ["sensitive-fixture-token"] });

    assert.deepEqual(await guarded.prepare({ ...seed, records: [{ ...seed.records[0]!, text: "sensitive-fixture-token" }] }, new AbortController().signal),
      { ok: false, reason: "topic_sensitive_content" });
    const prepared = await service.prepare(seed, new AbortController().signal);
    assert.ok(prepared.ok);
    assert.equal(prepared.value.focus?.decision.kind, "focused_learning");
    const source = prepared.value.focus?.reports[0]?.source;

    assert.ok(source !== undefined && "taskId" in source);
    assert.equal(source.taskId, "task:1");
    const applied = { schemaVersion: 1, knowledge: [], applications: [{ id: "a", requirementRefs: ["request"], answerRefs: ["request"],
      binding: "A in the original requirement", result: "The given answer already covers A.", conditions: "A only",
      citations: [{ evidenceRef: "request", quote: "known answer for A" }] }],
      relations: [{ id: "r", question: "Does the answer extend to B?", whenRelevant: "Original B condition", expectedChange: "Use the answer under the stated condition.",
        citations: [{ evidenceRef: "request", quote: "whether it extends to B" }] }], preparations: [{ description: "Retrieve support covering B.", sourceRefs: ["request"] }] };
    const review = { schemaVersion: 1, assessments: [{ relationId: "r", disposition: "residual", applicationIds: ["a"], reason: "A does not cover B." }],
      comparisons: [], selectedRelationId: "r", recommendation: { kind: "continue", reason: "B remains within the original requirement.", citations: [] } };
    const output = compileContentProcess(prepared.value, JSON.stringify(applied), JSON.stringify(review));
    assert.ok(output.ok);
    const published = await service.publish(prepared.value, output.value, prepared.value.boardSequence);

    assert.equal(published.status, "published");
    const read = await service.read();
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0]?.output.applied.preparations.length, 1);
    const retry = await service.publish(prepared.value, output.value, read.revision);

    assert.equal(retry.status, "published");
    assert.equal((await service.read()).records.length, 1);
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    const topics = topicDomainCandidates(board.state.rewardV2Facts ?? [], scope, "tool", board.state.sequence);
    assert.equal(topics.length, 1);
    const again = await service.prepare(seed, new AbortController().signal);
    assert.ok(again.ok);
    assert.ok(again.value.answers.some(row => row.answer === "The given answer already covers A."));
    assert.ok(again.value.records.some(row => row.origin === "model_proposal"));
    // No-new-topic still persists Knowledge/Preparation and preserves the PA decision.
    const finished = compileContentProcess(again.value, JSON.stringify({ ...applied, relations: [] }), JSON.stringify({ ...review, assessments: [], selectedRelationId: null }));

    assert.ok(finished.ok);
    const saved = await service.publish(again.value, finished.value, again.value.boardSequence);
    assert.equal(saved.status, "content_saved");
    assert.equal((await service.read()).records.length, 2);
    const final = await createBoardReader(boardRoot).load();
    assert.ok(final.ok);
    assert.equal(final.state.learningIssues?.[0]?.decision.kind, "focused_learning");
    // Model-only new material can be retained as a claim without granting it an independently grounded WS1 topic.
    const claimSeed = { records: [{ ref: "claim", runId: "model-run", sequence: 0, scope, origin: "model_proposal" as const,
      text: "An unverified model relationship." }], requirements: [], answers: [], materials: [] };
    const claimPacket = await service.prepare(claimSeed, new AbortController().signal);
    assert.ok(claimPacket.ok);
    const claimApplied = { schemaVersion: 1, knowledge: [], applications: [], preparations: [], relations: [{ id: "claim:r",
      question: "Is that relationship supported?", whenRelevant: "Only the stated claim", expectedChange: "Determine its support",
      citations: [{ evidenceRef: "claim", quote: "unverified model relationship" }] }] };
    const claimReview = { ...review, assessments: [{ relationId: "claim:r", disposition: "residual", applicationIds: [], reason: "No independent support." }], selectedRelationId: "claim:r" };
    const claimOutput = compileContentProcess(claimPacket.value, JSON.stringify(claimApplied), JSON.stringify(claimReview));
    assert.ok(claimOutput.ok);
    const pending = await service.publish(claimPacket.value, claimOutput.value, claimPacket.value.boardSequence);

    assert.equal(pending.status, "topic_pending");
    const retained = await service.read();
    assert.equal(retained.records.length, 3);
    assert.equal(retained.records[2]?.handoff.kind, "unavailable");
  } finally { await rm(boardRoot, { recursive: true, force: true }); }
});

test("collection disabled stops before filesystem access", async () => {
  const service = createLearningContentService({ boardRoot: "unused-content-disabled", scope: "repo:a", domain: "tool", enabled: () => false });
  assert.deepEqual(await service.prepare({ records: [], requirements: [], answers: [], materials: [] }, new AbortController().signal),
    { ok: false, reason: "collect_disabled" });
});
