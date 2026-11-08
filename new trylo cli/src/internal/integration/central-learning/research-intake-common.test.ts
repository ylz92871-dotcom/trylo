import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { isLearningIssueReport } from "../../learning/control/coordination-parse.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { groundCentralResearch } from "./research-intake-common.js";
import { acceptCentralWorkflowResearch } from "./research-intake-workflow.js";
import { createCentralWorkflowExecution } from "./workflow.js";
import { centralMaterialFromPage } from "./deliberation-material.js";

const scope = "D:\\research-intake", workspaceId = "workspace:research-intake", now = () => Date.parse("2026-11-05T00:00:00Z");
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 24000 };
const cancellation = () => new AbortController().signal;
const material: CentralRuntimeMaterial = { ref: "read:successful-business", kind: "source", sourceRefs: ["session:original"],
  text: "Both resolved tasks first read the declared schema before editing the payload." };

function intent(): CentralLearningIntentDraft {
  return { intentId: "intent:prospective", subject: { plane: "central", questionRef: "intent:prospective" },
    goal: "Determine when reading declared schema before payload edits avoids rework", rationale: "Resolved business tasks suggest a transferable process hypothesis",
    conditions: ["A declared schema exists"], knowledge: [{ statement: "Two resolved tasks read schema before editing", conditions: "Observed tasks only", sourceRefs: [material.ref] }],
    residual: ["Determine the failure case when schema and actual payload disagree"], commitment: { purpose: "Find a conditional procedure", assumptions: [], reconsiderWhen: ["A counterexample is found"] },
    revisionReason: "Grounded new purpose", sourceRefs: [material.ref],
    derivation: { relation: "Generalize a process without reopening resolved tasks", whenRelevant: "A future payload edit has declared schema", parentRefs: [material.ref],
      citations: [{ evidenceRef: material.ref, quote: "first read the declared schema" }] },
    continuation: { kind: "ready", operation: { kind: "dispatch", operationId: "dispatch:one", purpose: "Compare conditions and propose a process", expectedChange: "A falsifiable procedure",
      sourceRefs: [material.ref], allowance, destination: { plane: "agent", domain: "workflow" } } } };
}

async function fixture(t: TestContext, selected = intent(), original = material) {
  const boardRoot = await mkdtemp(join(tmpdir(), "trylo-native-research-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const state = { ...emptyCentralRuntimeState(scope), intents: [selected], materials: [original], consumedSourceRefs: [original.ref] };

  assert.equal((await store.append({ expectedRevision: 0, previousRef: initialCentralRuntimeRef(scope), state,
    reason: "Public source read and derived purpose", sourceRefs: [material.ref] })).status, "written");

  if (selected.continuation.kind !== "ready" || selected.continuation.operation.kind !== "dispatch") throw new Error("dispatch_required");

  return { boardRoot, store, state, signal: { intentRef: selected.intentId, intent: selected, operation: selected.continuation.operation } };
}

test("research source is distinct from a Team or completed task and keeps legacy mixed-source ownership", () => {
  const research = { reportId: "report:research", source: { kind: "research_request", domain: "prompt", requestRef: "request:one", intentRef: "intent:one" }, facts: ["A derived request, not an observation"], evidenceRefs: ["read:one"] };

  assert.equal(isLearningIssueReport(research), true);
  assert.equal(isLearningIssueReport({ ...research, source: { ...research.source, taskId: "fake-task" } }), false);

  if (!isLearningIssueReport(research)) throw new Error("canonical_report_required");

  assert.equal(learningIssueOwner({ reports: [research] }), "method");
  assert.equal(learningIssueOwner({ reports: [{ reportId: "team", source: { teamRunId: "team", memberId: "member", taskId: "task" }, facts: ["Actual source"], evidenceRefs: [] },
    { reportId: "method", source: { subsystem: "method", taskId: "turn", versionId: "version" }, facts: ["Actual method source"], evidenceRefs: [] }] }), "method");
});

test("grounding re-reads original history, checks current intent and rejects changed source or unsupported citation", async t => {
  const h = await fixture(t), options = { boardRoot: h.boardRoot, scope, enabled: () => true };
  let reads = 0;
  const grounded = await groundCentralResearch({ ...options, readMaterials: async refs => {
    reads += 1;
    assert.deepEqual(refs, [material.ref]);
    return [material];
  } }, "workflow", h.signal, cancellation());

  assert.equal(reads, 1);
  assert.deepEqual(grounded.materials, [material]);
  await assert.rejects(groundCentralResearch({ ...options, readMaterials: async () => [{ ...material, text: "changed" }] }, "workflow", h.signal, cancellation()), /material_unavailable_or_changed/);
  await assert.rejects(groundCentralResearch(options, "tool", h.signal, cancellation()), /signal_invalid/);
  await assert.rejects(groundCentralResearch(options, "workflow", { ...h.signal, intent: { ...h.signal.intent, goal: "uncommitted replacement" } }, cancellation()), /original_intent_changed/);
  const read = await h.store.read(scope);

  await h.store.append({ expectedRevision: read.revision, previousRef: read.stateRef, state: { ...read.state, materials: [] }, reason: "Compact old public material", sourceRefs: [material.ref] });
  assert.deepEqual((await groundCentralResearch(options, "workflow", h.signal, cancellation())).materials, [material]);
  const unsupported = intent();
  const forged = { ...unsupported, derivation: { ...unsupported.derivation!, citations: [{ evidenceRef: material.ref, quote: "never read this claim" }] } };
  const bad = await fixture(t, forged);

  await assert.rejects(groundCentralResearch({ ...options, boardRoot: bad.boardRoot }, "workflow", bad.signal, cancellation()), /citation_not_original_read_material/);
});

test("native intake rejects archived unread catalog quotes and preserves actual source bodies", async t => {
  const originalRef = "central-runtime-catalog:legacy", start = 0, text = material.text;

  for (const original of [
    { ...material, text: JSON.stringify({ role: "original_domain_feedback_catalog_not_read_body", summary: material.text }) },
    { ...material, ref: "central-runtime-catalog:legacy", text: material.text },
    { ...material, ref: `central-runtime-fragment:${contentHashOf([originalRef, start, text])}`, sourceRefs: [originalRef],
      text: canonicalJson({ originalRef, start, end: text.length, totalChars: text.length, text, nextRef: null }) },
    centralMaterialFromPage({ ref: originalRef, originalRef, originalScope: scope, owner: "board", origin: "model_proposal",
      coordinate: { runId: originalRef, sequence: 1 }, sourceHash: contentHashOf(text), start, end: text.length, totalChars: text.length, text }),
  ]) {
    const selected = intent(), ref = original.ref;
    const derived = { ...selected, sourceRefs: [ref], knowledge: selected.knowledge.map(row => ({ ...row, sourceRefs: [ref] })),
      derivation: { ...selected.derivation!, parentRefs: [ref],
      citations: [{ evidenceRef: ref, quote: "first read the declared schema" }] },
      continuation: selected.continuation.kind === "ready" ? { ...selected.continuation,
        operation: { ...selected.continuation.operation, sourceRefs: [ref] } } : selected.continuation };
    const h = await fixture(t, derived, original);

    await assert.rejects(groundCentralResearch({ boardRoot: h.boardRoot, scope, enabled: () => true }, "workflow", h.signal, cancellation()),
      /citation_not_original_read_material/);
  }

  const original = { ...material, text: JSON.stringify({ role: "actual_source_fragment_not_full_source", text: material.text,
    nested: { role: "original_domain_feedback_catalog_not_read_body" } }) };
  const h = await fixture(t, intent(), original);

  assert.deepEqual((await groundCentralResearch({ boardRoot: h.boardRoot, scope, enabled: () => true }, "workflow", h.signal, cancellation())).materials, [original]);
});

test("a derived purpose creates a real native workflow source and issue without reopening ordinary business or allocating money", async t => {
  const h = await fixture(t), options = { boardRoot: h.boardRoot, scope, workspaceId, enabled: () => true };
  const report = await withBoardWriter(h.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "ordinary:report", issuedAt: new Date(now()).toISOString(),
    action: { kind: "report", scope, issueId: "ordinary:done", problemKey: "business-resolved", report: { reportId: "ordinary:report",
      source: { teamRunId: "actual-team", taskId: "actual-task", memberId: "actual-member" }, facts: ["Original task is resolved"], evidenceRefs: [material.ref] } } }));

  assert.ok(report.ok);
  assert.ok((await withBoardWriter(h.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "ordinary:decide", issuedAt: new Date(now()).toISOString(),
    action: { kind: "decide", issueId: "ordinary:done", expectedRevision: 1, decision: "resolved", reason: "Original task completed", sourceRefs: [material.ref] } }))).ok);
  const workflow = createCentralWorkflowExecution({ boardRoot: h.boardRoot, scope: workspaceId, centralScope: scope,
    budgetId: "actual-workflow-owner", sessionId: "research-owner-not-business-session", allowance: allowance.maxTokens, now,
    enabled: () => true, research: true, publicData: () => true, warn: () => {},
    readEvidence: async () => { throw new Error("must_not_read_fake_business_session"); },
    newModel: () => { throw new Error("nomination_cannot_call_provider"); } });
  const grounded = await groundCentralResearch(options, "workflow", h.signal, cancellation());
  const received = await acceptCentralWorkflowResearch({ ...options, workflow }, grounded, cancellation());

  assert.ok(received.status === "accepted", JSON.stringify(received));
  const loaded = await createBoardReader(h.boardRoot).load();
  assert.ok(loaded.ok);
  const native = loaded.state.learningIssues?.find(row => row.issueId === received.issueId);

  assert.equal(learningIssueOwner(native!), "workflow");
  assert.ok(native!.reports.some(row => row.evidenceRefs.includes(h.signal.intentRef)));
  assert.equal(loaded.state.learningIssues?.find(row => row.issueId === "ordinary:done")?.decision.kind, "resolved");
  assert.equal(loaded.state.centralLearningGrants?.length ?? 0, 0);
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(loaded.state.activations.length, 0);
  const repeat = await acceptCentralWorkflowResearch({ ...options, workflow }, { ...grounded, operation: { ...grounded.operation, operationId: "dispatch:two" } }, cancellation());

  assert.deepEqual(repeat, received);
  const after = await createBoardReader(h.boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.sequence, loaded.state.sequence);
});
