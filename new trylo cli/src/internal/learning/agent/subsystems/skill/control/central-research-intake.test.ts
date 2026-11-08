import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { acceptCentralSkillResearch } from "../../../../../integration/central-learning/research-intake-skill.js";
import type { GroundedCentralResearch } from "../../../../../integration/central-learning/research-intake-common.js";
import { centralSkillResearchFromBoard, readCentralSkillResearchOpportunity } from "./central-research-board.js";
import { CENTRAL_SKILL_RESEARCH_ALGORITHM, centralSkillResearchRecordId } from "./central-research-request.js";
import { canonicalJson } from "../../../../control/hash.js";
import { resolveManagedSkillSource } from "./managed.js";

const scope = "workspace:skill-native-research";
const workspaceRoot = "D:/fixture/skill-native-research";
const now = () => Date.parse("2026-11-05T03:00:00.000Z");
const signal = () => new AbortController().signal;

function research(): GroundedCentralResearch {
  const operation = { kind: "dispatch" as const, operationId: "operation:skill-research", purpose: "Compare the existing package procedures and their counterexample.",
    expectedChange: "Identify which prerequisites a reusable skill must retain.", sourceRefs: ["material:old-knowledge", "material:new-business"],
    allowance: { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 5000 },
    destination: { plane: "agent" as const, domain: "skill" as const } };
  return { requestRef: "central-research-request:skill-real-materials", domain: "skill", operation,
    intent: { intentId: "intent:skill-purpose", subject: { plane: "central", questionRef: "intent:skill-purpose" },
      goal: "Learn a packaging procedure that preserves observed prerequisites.", rationale: "Two completed business episodes exposed a shared transfer question.",
      conditions: ["Only the observed package manager is supported."], knowledge: [{ statement: "A lockfile is required before packaging.",
        conditions: "The existing npm recipe.", sourceRefs: ["material:old-knowledge"] }], residual: ["The other package manager remains untested."],
      commitment: { purpose: "Compare the prerequisites before authoring a skill.", assumptions: ["Both excerpts are public learning materials."],
        reconsiderWhen: ["A source is withdrawn or a counterexample contradicts the prerequisite."] }, revisionReason: "A new public episode is relevant to prior procedural knowledge.",
      sourceRefs: ["material:old-knowledge", "material:new-business"], derivation: { relation: "Compare a new episode with the prior rule.",
        whenRelevant: "Future packaging work.", parentRefs: ["material:new-business"], citations: [{ evidenceRef: "material:new-business", quote: "Packaging needed a regenerated lockfile." }] },
      continuation: { kind: "ready", operation } },
    materials: [{ ref: "material:old-knowledge", kind: "knowledge", text: "The existing procedure requires a lockfile.", sourceRefs: ["knowledge:recipe"] },
      { ref: "material:new-business", kind: "source", text: "Packaging needed a regenerated lockfile.", sourceRefs: ["business:completed-episode"] }],
    sourceRefs: ["intent:skill-purpose", "material:old-knowledge", "material:new-business", "business:completed-episode"] };
}

async function fixture(t: test.TestContext) {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "trylo-skill-research-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  return { boardRoot, scope, workspaceRoot, enabled: () => true, now };
}

test("grounded skill research becomes a native source and reaches the original managed worker without a task journal", async t => {
  const options = await fixture(t), request = research();
  const accepted = await acceptCentralSkillResearch(options, request, signal());

  assert.equal(accepted.status, "accepted");
  const board = createBoardReader(options.boardRoot), loaded = await board.load();

  assert.ok(loaded.ok);
  const issue = loaded.state.learningIssues?.find(item => item.issueId === accepted.issueId);

  assert.ok(issue);
  assert.deepEqual(issue.reports[0]?.source, { kind: "research_request", domain: "skill", requestRef: request.requestRef, intentRef: request.intent.intentId });
  assert.deepEqual(loaded.state.centralLearningGrants ?? [], []);
  assert.deepEqual(loaded.state.jobs, []);
  assert.deepEqual(loaded.state.proposals, []);
  assert.deepEqual(loaded.state.assets, []);
  assert.deepEqual(loaded.state.activations, []);
  let journalReads = 0;
  const resolved = await resolveManagedSkillSource({ issue, scope,
    read: async () => {
      journalReads += 1;
      throw new Error("research_must_not_invent_a_business_terminal");
    },
    readResearch: (ref, abort) => readCentralSkillResearchOpportunity({ board, scope, workspaceRoot }, ref, abort),
  }, signal());

  assert.equal(resolved.status, "ready");
  assert.equal(journalReads, 0);
  assert.equal(resolved.opportunity.trigger, "explicit");
  assert.equal(resolved.opportunity.sessionId, undefined);
  assert.equal(resolved.opportunity.turnId, undefined);
  const publicRequest: unknown = JSON.parse(String(resolved.opportunity.experience?.publicResearchRequest));

  assert.deepEqual(publicRequest, { schemaVersion: 1, type: "skill_research_request", scope, workspaceRoot,
    requestRef: request.requestRef, intentRef: request.intent.intentId, intent: request.intent,
    operation: request.operation, materials: request.materials, sourceRefs: request.sourceRefs });
  assert.ok(resolved.source.sourceRefs.includes(issue.reports[0]!.reportId));
  const readers = { read: async () => undefined,
    readResearch: (ref: string, abort: AbortSignal) => readCentralSkillResearchOpportunity({ board, scope, workspaceRoot }, ref, abort) };
  const borrowed = await resolveManagedSkillSource({ ...readers, issue: { ...issue, issueId: "issue:borrowed-research-source" }, scope }, signal());

  assert.equal(borrowed.status, "unavailable");
  const wrongPurpose = await resolveManagedSkillSource({ ...readers, issue, scope,
    readResearch: async () => ({ ...resolved.opportunity, experience: { ...resolved.opportunity.experience, intentRef: "intent:substituted" } }),
  }, signal());

  assert.equal(wrongPurpose.status, "unavailable");
  const oversizedContext = await resolveManagedSkillSource({ ...readers, issue, scope,
    context: { ref: "context:oversized-native-experience", text: "x".repeat(65_536) } }, signal());

  assert.equal(oversizedContext.status, "unavailable");
  assert.equal(oversizedContext.reason, "hermes_managed_context_capacity");
});

test("duplicate delivery and a new operation retain one source, issue and original expenditure owner", async t => {
  const options = await fixture(t), request = research();
  const first = await acceptCentralSkillResearch(options, request, signal());

  assert.equal(first.status, "accepted");
  const board = createBoardReader(options.boardRoot), before = await board.load();
  assert.ok(before.ok);
  const again = await acceptCentralSkillResearch(options, request, signal());
  const nextOperation = { ...request.operation, operationId: "operation:later-computation" };
  const revised = { ...request, operation: nextOperation, intent: { ...request.intent,
    continuation: { kind: "ready" as const, operation: nextOperation } } };
  const later = await acceptCentralSkillResearch(options, revised, signal());

  assert.deepEqual(again, first);
  assert.deepEqual(later, first);
  const after = await board.load();
  assert.ok(after.ok);
  assert.equal(after.state.sequence, before.state.sequence);
  assert.equal(after.state.learningIssues?.length, 1);
  assert.equal(after.state.rewardV2Facts?.filter(item => item.algorithmVersion === CENTRAL_SKILL_RESEARCH_ALGORITHM).length, 1);
  assert.deepEqual(after.state.centralLearningGrants ?? [], []);
  const issue = after.state.learningIssues![0]!;
  const closed = await withBoardWriter(options.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "test-only:ordinary-source",
    issuedAt: new Date(now()).toISOString(), action: { kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision,
      decision: "ordinary_execution", reason: "The original owner returned this purpose to ordinary execution.", sourceRefs: [request.requestRef] } }));

  assert.ok(closed.ok);
  const preserved = await acceptCentralSkillResearch(options, revised, signal());

  assert.equal(preserved.status, "waiting");
  assert.equal(preserved.reason, "hermes_research_native_purpose_closed");
  const final = await board.load();
  assert.ok(final.ok);
  assert.equal(final.state.sequence, closed.state.sequence);
});

test("disabled, cancelled, oversized and cross-workspace research cannot become executable native work", async t => {
  const options = await fixture(t), request = research(), aborted = new AbortController();
  aborted.abort();
  assert.equal((await acceptCentralSkillResearch({ ...options, enabled: () => false }, request, signal())).status, "waiting");
  assert.equal((await acceptCentralSkillResearch(options, request, aborted.signal)).status, "waiting");
  const large = { ...request, materials: [{ ...request.materials[0]!, text: "x".repeat(32_000) },
    { ...request.materials[1]!, text: "y".repeat(32_000) }] };
  const oversized = await acceptCentralSkillResearch(options, large, signal());

  assert.equal(oversized.status, "waiting");

  if (oversized.status === "waiting") assert.equal(oversized.reason, "hermes_research_material_capacity");

  const board = createBoardReader(options.boardRoot), before = await board.load();
  assert.ok(before.ok);
  assert.equal(before.state.sequence, 0);
  const accepted = await acceptCentralSkillResearch(options, request, signal());
  assert.equal(accepted.status, "accepted");
  await assert.rejects(readCentralSkillResearchOpportunity({ board, scope, workspaceRoot: "D:/another-workspace" }, request.requestRef, signal()),
    /hermes_research_source_conflict/);
  assert.equal(await readCentralSkillResearchOpportunity({ board, scope, workspaceRoot }, "request:missing", signal()), undefined);
});

test("a malformed native record or two bodies under one request fail closed", async t => {
  const options = await fixture(t), request = research();

  await acceptCentralSkillResearch(options, request, signal());
  const loaded = await createBoardReader(options.boardRoot).load();
  assert.ok(loaded.ok);
  const record = loaded.state.rewardV2Facts!.find(item => item.algorithmVersion === CENTRAL_SKILL_RESEARCH_ALGORITHM)!;
  const corrupt = centralSkillResearchFromBoard({ ...loaded.state, rewardV2Facts: [{ ...record, payloadJson: "{malformed" }] }, scope, request.requestRef);

  assert.deepEqual(corrupt, { status: "invalid", reason: "hermes_research_source_corrupt" });
  const original = centralSkillResearchFromBoard(loaded.state, scope, request.requestRef);
  assert.equal(original.status, "found");
  const changed = { ...original.request, intent: { ...original.request.intent, goal: "Another purpose cannot replace this native request." } };
  const conflicting = { ...record, id: centralSkillResearchRecordId(changed), payloadJson: canonicalJson(changed), sequence: record.sequence + 1 };
  const duplicate = centralSkillResearchFromBoard({ ...loaded.state, rewardV2Facts: [record, conflicting] }, scope, request.requestRef);

  assert.deepEqual(duplicate, { status: "invalid", reason: "hermes_research_source_conflict" });
});
