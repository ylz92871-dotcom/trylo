import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { testScratchPath } from "../../testing/scratch.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { CentralLearningExecutionPort } from "./contracts.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import type { OrganizationDecision } from "../../learning/central/organization/contracts.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { centralOrganizationDeliberationRef } from "./organization-feedback-runtime.js";
import { CENTRAL_ADVISORY_TYPE, type CentralAdvisoryPublish } from "./central-advisory-contracts.js";
import { buildCentralAdvisoryRecord, centralAdvisoryId, centralAdvisoryKnowledgeHash } from "./central-advisory-records.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { methodResearchRecord } from "../../learning/agent/subsystems/method/adapters/central-research-records.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";

const scope = "workspace:runtime-source", signal = new AbortController().signal;
const at = "2026-11-05T00:00:00.000Z";

test("a selected native method return exposes its original body as a readable source", async () => {
  const intent: CentralLearningIntentDraft = { intentId: "intent:returned-method", subject: { plane: "central", questionRef: "intent:returned-method" },
    goal: "Read the original returned research.", rationale: "A reference alone is not its body.", conditions: [], knowledge: [], residual: [],
    commitment: { purpose: "Inspect the native return", assumptions: [], reconsiderWhen: [] }, revisionReason: "Original purpose",
    sourceRefs: ["source:method-input"], continuation: { kind: "open" } };
  const fact = methodResearchRecord(scope, { schemaVersion: 1, type: "method_research_request", requestRef: "request:returned-method",
    intentRef: intent.intentId, intent, materials: [{ ref: "source:method-input", kind: "source",
      text: "Original native request metadata for D:\\workspace\\receiver.", sourceRefs: [] }],
    sourceRefs: ["request:returned-method", intent.intentId, ...intent.sourceRefs] });
  const f = fixture([]);
  f.set({ ...f.state(), sequence: 1, rewardV2Facts: [{ ...fact, sequence: 1 }] });
  const snapshot = await f.source.snapshot(scope, signal, { subjects: [intent.subject], sourceRefs: [],
    purposes: [{ subject: intent.subject, purpose: intent.goal, sourceRefs: [fact.id] }] });
  const original = snapshot.materials.find(row => row.ref === fact.id);
  assert.ok(original);
  assert.ok(isCentralRuntimeMaterial(original));
  assert.ok(original.text.includes("method_research_request"));
  assert.ok(snapshot.sourceRefs.includes(fact.id));
  assert.ok(original.text.includes("redacted_public_view"));
  assert.ok(original.text.includes("[path]"));
  assert.deepEqual(await f.source.read(scope, [fact.id], 10000, signal), [original]);
});

function issue(id: string, decision: LearningIssue["decision"]["kind"] = "unreviewed"): LearningIssue {
  return { schemaVersion: 1, issueId: id, scope, problemKey: `problem:${id}`, revision: 1,
    createdAt: at, updatedAt: at,
    reports: [{ reportId: `report:${id}`, source: { subsystem: "tool", taskId: `task:${id}`, versionId: `version:${id}` },
      facts: [`Original source statement for ${id}`], hypotheses: ["Unverified explanation"], evidenceRefs: [`evidence:${id}`] }],
    decision: decision === "unreviewed" ? { kind: "unreviewed" }
      : { kind: decision, reason: `PA chose ${decision}`, sourceRefs: [`report:${id}`], decidedAt: at, revision: 1 } };
}

function fixture(initial: readonly LearningIssue[], overrides: Partial<Parameters<typeof createCentralRuntimeSource>[0]> = {}) {
  let state: BoardState = { ...emptyBoardState(), sequence: 4, learningIssues: initial }, reads = 0;
  const board = { async load() {
    reads += 1;
    return { ok: true as const, state, generation: 1 };
  } };
  const source = createCentralRuntimeSource({ boardRoot: mkdtempSync(testScratchPath("central-runtime-source-board-")), scope, ports: [], board,
    enabled: () => true, ...overrides });
  return { source, reads: () => reads, set: (value: BoardState) => { state = value; }, state: () => state };
}

test("the actual provider connection is one stable control fact and a changed connection becomes visible", async () => {
  const connection = { providerId: "fixture", model: "first", providerConnectionRef: "provider:first" };
  const baseline = await fixture([]).source.snapshot(scope, signal);
  const f = fixture([], { providerConnection: connection });
  const first = await f.source.snapshot(scope, signal);
  const refs = first.sourceRefs.filter(ref => !baseline.sourceRefs.includes(ref));

  assert.equal(refs.length, 1);
  const material = first.materials.find(row => row.ref === refs[0])!;

  assert.equal(JSON.parse(material.text).role, "actual_provider_connection_not_business_evidence");
  assert.deepEqual(material.sourceRefs, []);
  assert.deepEqual(await f.source.read(scope, refs, 10000, signal), [material]);
  const query = { subjects: [], sourceRefs: first.sourceRefs };
  const restarted = await fixture([], { providerConnection: connection }).source.snapshot(scope, signal, query);

  assert.deepEqual(restarted.sourceRefs, first.sourceRefs);
  const changed = await fixture([], { providerConnection: { ...connection, model: "second", providerConnectionRef: "provider:second" } }).source.snapshot(scope, signal, query);
  const newRefs = changed.sourceRefs.filter(ref => !first.sourceRefs.includes(ref));

  assert.equal(newRefs.length, 1);
  assert.ok(!changed.sourceRefs.includes(refs[0]!));
  const format = { ...connection, decisionFormat: "action_tool" as const };
  const reformatted = await fixture([], { providerConnection: format }).source.snapshot(scope, signal, query);
  const formatRefs = reformatted.sourceRefs.filter(ref => !first.sourceRefs.includes(ref));

  assert.equal(formatRefs.length, 1, "a real submission-format change is a new control condition");
  const restartedFormat = await fixture([], { providerConnection: format }).source.snapshot(scope, signal, query);

  assert.deepEqual(restartedFormat.sourceRefs, reformatted.sourceRefs, "restarting the same interface adds no fresh condition");
});

test("multi-source reads retain delivered material when the remaining budget cannot fit another page", async () => {
  const f = fixture([issue("issue:capacity-a"), issue("issue:capacity-b")]);
  const first = await f.source.read(scope, ["issue:capacity-a"], 100000, signal);
  const limit = first[0]!.text.length + 1;
  const partial = await f.source.read(scope, ["issue:capacity-a", "issue:capacity-b"], limit, signal);

  assert.deepEqual(partial, first);
  assert.ok(partial.reduce((sum, row) => sum + row.text.length, 0) <= limit);
  const later = await f.source.read(scope, ["issue:capacity-b"], 100000, signal);

  assert.equal(later.length, 1);
  assert.notEqual(later[0]!.ref, first[0]!.ref);
  await assert.rejects(f.source.read(scope, ["issue:capacity-b"], 1, signal), /central_runtime_source_capacity/);
});

test("a stopped durable budget change becomes one stable source on resume and restart, never spending-driven new evidence", async () => {
  let enabled = true;
  const f = fixture([], { enabled: () => enabled });
  const budget: NonNullable<BoardState["centralLearningBudgets"]>[number] = {
    schemaVersion: 1, budgetId: "budget:durable-source", scope, unit: "total_model_tokens", mode: "exclusive_new_funding",
    limits: { tokens: 1000, calls: 10, steps: 10 }, authorizationRef: "authorization:original", openedAt: at, openedSequence: 1,
    accounting: [], limitChanges: [],
  };

  f.set({ ...f.state(), centralLearningBudgets: [budget] });
  const baseline = await f.source.snapshot(scope, signal);

  assert.ok(!baseline.sourceRefs.some(ref => ref.startsWith("central-budget-change:")));
  const older = { changeId: "change:older", limits: { tokens: 2000, calls: 20, steps: 20 },
    authorizationRef: "authorization:older", changedAt: at, changedSequence: 5 };
  const latest = { changeId: "change:latest", limits: { tokens: 3000, calls: 30, steps: 30 },
    authorizationRef: "authorization:latest", changedAt: at, changedSequence: 6 };

  enabled = false;
  const changed = { ...budget, limits: latest.limits, limitChanges: [older, latest] };

  f.set({ ...f.state(), sequence: 6, centralLearningBudgets: [changed] });
  await assert.rejects(f.source.snapshot(scope, signal), /collect_disabled/);
  enabled = true; // Only the existing owner activation/resume decides this gate.
  const first = await f.source.snapshot(scope, signal, { subjects: [], sourceRefs: baseline.sourceRefs });
  const expected = `central-budget-change:${contentHashOf({ budgetId: budget.budgetId, changeId: latest.changeId })}`;

  assert.deepEqual(first.sourceRefs.filter(ref => ref.startsWith("central-budget-change:")), [expected]);
  assert.deepEqual(first.opportunities, [], "a budget fact does not create a learning goal");
  const material = first.materials.find(row => row.sourceRefs.includes(expected));
  assert.ok(material);
  assert.ok(material.ref.startsWith("central-runtime-constraint:"), "funding conditions cannot become business evidence");
  const body = JSON.parse(material.text);

  assert.deepEqual(body.rootRef, { budgetId: budget.budgetId, scope, openedSequence: 1, authorizationRef: budget.authorizationRef });
  assert.deepEqual(body.change, latest);
  assert.deepEqual(await f.source.read(scope, [expected], 10000, signal), [material], "read is backed by the same native Board fact");
  f.set({ ...f.state(), sequence: 7, centralLearningBudgets: [{ ...changed, accounting: [{
    reservationId: "reservation:spent", owner: { kind: "central_deliberation", ownerId: "owner:original" }, maxTokens: 10,
    reservedAt: at, reservedSequence: 7, state: "settled", usage: { kind: "reported", model: "local", totalTokens: 10 },
  }] }] });
  const restarted = createCentralRuntimeSource({ boardRoot: "unused", scope, ports: [], enabled: () => enabled,
    board: { async load() { return { ok: true, state: f.state(), generation: 1 }; } } });
  const after = await restarted.snapshot(scope, signal, { subjects: [], sourceRefs: first.sourceRefs });

  assert.deepEqual(after.materials.find(row => row.sourceRefs.includes(expected)), material,
    "current Board sequence and occupied/available changes must not change this immutable source");
  assert.deepEqual(after.sourceRefs.filter(ref => !first.sourceRefs.includes(ref)), [],
    "the original consumed-source cursor sees no new fact after restart or spending");
});

test("nominates actual owner sources before loading and preserves PA decisions without turning them into opportunities", async () => {
  const f = fixture([issue("ordinary", "ordinary_execution"), issue("resolved", "resolved"),
    issue("focused", "focused_learning"), { ...issue("foreign"), scope: "workspace:other" }]);
  const port: CentralLearningExecutionPort = { domain: "tool",

    async nominate() {
      f.set({ ...f.state(), learningIssues: [...(f.state().learningIssues ?? []), issue("fresh")] });
      return ["fresh"];
    },

    async prepare() { throw new Error("must not prepare"); }, async dispatch() { throw new Error("must not dispatch"); },
    async observe() { throw new Error("must not observe"); } };
  const source = createCentralRuntimeSource({ boardRoot: "unused", board: { async load() { return { ok: true, state: f.state(), generation: 1 }; } },
    scope, ports: [port], enabled: () => true });
  const snapshot = await source.snapshot(scope, signal);

  assert.deepEqual(snapshot.opportunities.map(item => item.subject.plane === "agent" && item.subject.issueId), ["focused", "fresh"]);
  assert.ok(snapshot.materials.some(item => item.text.includes("PA chose ordinary_execution")));
  assert.ok(snapshot.materials.some(item => item.text.includes("PA chose resolved")));
  assert.ok(!snapshot.materials.some(item => item.text.includes("foreign")));
  const opportunity = snapshot.opportunities.find(item => item.subject.plane === "agent" && item.subject.issueId === "fresh")!;
  const original = await source.read(scope, [opportunity.sourceRef], 12000, signal);

  assert.deepEqual(JSON.parse(original[0]!.text).reports, issue("fresh").reports);
  assert.ok(original[0]!.sourceRefs.includes("evidence:fresh"));
});

test("irrelevant Board sequence does not change source identity and fresh owner feedback does", async () => {
  let body = "original finding";
  const f = fixture([issue("one")], { domainFeedback: async () => ({ sourceRef: "feedback:one", sourceRefs: ["owner:observation"],
    records: [{ finding: body }] }) });
  const query = { subjects: [{ plane: "agent" as const, domain: "tool" as const, issueId: "one" }], sourceRefs: [] };
  const before = await f.source.snapshot(scope, signal, query);

  f.set({ ...f.state(), sequence: 99, learningIssues: (f.state().learningIssues ?? []).map(item => ({ ...item,
    revision: item.revision + 1, updatedAt: "2026-11-05T01:00:00.000Z", grantId: "grant:funding-only", jobId: "job:funding-only",
    decision: { kind: "focused_learning", reason: "focus", sourceRefs: ["report:one"], decidedAt: at, revision: 2 } })) });
  const funded = await f.source.snapshot(scope, signal, query);
  const focus = funded.materials.find(material => material.ref.startsWith("central-runtime-constraint:")
    && JSON.parse(material.text).decision?.kind === "focused_learning")!;

  assert.ok(focus);
  assert.equal(JSON.parse(focus.text).readRef, before.opportunities[0]!.sourceRef,
    "the current focus exposes the unchanged original report, not only an opaque problem id");
  const focusedOriginal = await f.source.read(scope, [JSON.parse(focus.text).readRef], 12000, signal);
  assert.deepEqual(JSON.parse(focusedOriginal[0]!.text).reports, f.state().learningIssues!.find(row => row.issueId === "one")!.reports);
  assert.ok(funded.sourceRefs.includes(focus.ref), "new PA focus is a governance signal, not new report evidence");
  assert.deepEqual(funded.sourceRefs.filter(ref => ref !== focus.ref), before.sourceRefs);
  assert.equal(funded.opportunities[0]!.sourceRef, before.opportunities[0]!.sourceRef);
  const reconsidered = await f.source.snapshot(scope, signal, { subjects: [], sourceRefs: before.sourceRefs,
    consideredSourceRefs: [before.opportunities[0]!.sourceRef] });

  assert.ok(reconsidered.sourceRefs.includes(focus.ref), "a previously considered report must not hide its later PA focus");
  assert.equal(reconsidered.opportunities[0]!.sourceRef, before.opportunities[0]!.sourceRef);
  body = "new original finding";
  const after = await f.source.snapshot(scope, signal, query);

  assert.notDeepEqual(after.sourceRefs, before.sourceRefs);
  const advertised = after.materials.find(item => item.kind === "feedback")!;

  assert.ok(!advertised.text.includes(body));
  assert.notEqual(advertised.ref, JSON.parse(advertised.text).readRef);
  assert.ok((await f.source.read(scope, [JSON.parse(advertised.text).readRef], 4000, signal))[0]!.text.includes(body));
  assert.ok(after.materials.every(item => { const previous = before.materials.find(row => row.ref === item.ref);
    return previous === undefined || previous.text === item.text; }));
});

test("large owner feedback remains advertised and readable without treating its catalog as its body", async () => {
  const original = { sourceRef: "feedback:large-original", sourceRefs: Array.from({ length: 98 }, (_, index) =>
    `original-receipt:${index}:${"a".repeat(128)}`), records: [{ finding: "kept original feedback ".repeat(10000) }] };
  const f = fixture([issue("large-original")], { domainFeedback: async () => original });
  const before = structuredClone(original);
  const snapshot = await f.source.snapshot(scope, signal, { subjects: [{ plane: "agent", domain: "tool", issueId: "large-original" }], sourceRefs: [] });
  const catalog = snapshot.materials.find(row => row.ref.startsWith("central-runtime-domain-catalog:"));
  assert.ok(catalog, "a provenance manifest larger than the old 12000-character default must not stop the central source collector");
  assert.ok(!catalog.text.includes("kept original feedback"), "a catalog is not the original body");
  const page = await f.source.read(scope, [JSON.parse(catalog.text).readRef], 2000, signal);
  assert.ok(page[0] && isCentralRuntimeMaterial(page[0]));
  assert.ok(page[0].text.includes("kept original feedback"), "the bounded read still resolves actual original text");
  assert.deepEqual(original, before, "neither collection nor a partial read changes the complete original lineage");
});

test("snapshot reads no unrelated feedback or opaque content body, and catalogs remain bounded", async () => {
  const calls: string[] = [];
  const f = fixture(Array.from({ length: 100 }, (_, index) => issue(`issue:${index}`)),
    { domainFeedback: async (_board, issueId) => {
      calls.push(issueId);
      return undefined;
    } });

  f.set({ ...f.state(), rewardV2Facts: [{ id: "content:unrelated-corrupt", scope, kind: "projection", sequence: 1,
    algorithmVersion: "central-learning-content-v1", payloadJson: '{"type":"wrong_content_schema_must_not_decode_during_catalog"}' }] });
  const initial = await f.source.snapshot(scope, signal);

  assert.equal(calls.length, 0);
  assert.ok(initial.opportunities.length <= 32);
  const next = await f.source.snapshot(scope, signal, { subjects: [], sourceRefs: initial.sourceRefs });

  assert.ok(next.opportunities.every(item => {
    const id = item.subject.plane === "agent" ? item.subject.issueId : undefined;
    return id !== undefined && !initial.opportunities.some(previous => previous.subject.plane === "agent" && previous.subject.issueId === id);
  }));
  await f.source.snapshot(scope, signal, { subjects: [{ plane: "agent", domain: "tool", issueId: "issue:50" }], sourceRefs: [] });
  assert.deepEqual(calls, ["issue:50"]);
  await assert.rejects(f.source.read(scope, ["content:unrelated-corrupt"], 4000, signal));
});

test("oversized original reports are addressed and paginated verbatim within both capacities", async () => {
  const original = issue("large"), large = { ...original, reports: [{ ...original.reports[0]!, facts: ["quoted original ".repeat(5000)] }] };
  const f = fixture([large], { maximumSnapshotChars: 2048 });
  const snapshot = await f.source.snapshot(scope, signal);

  assert.ok(snapshot.materials.reduce((sum, item) => sum + item.text.length, 0) <= 2048);
  assert.ok(snapshot.materials.every(item => item.text.length <= 32768));
  let ref: string | null = snapshot.opportunities[0]!.sourceRef, complete = "", pages = 0;

  while (ref !== null) {
    const rows = await f.source.read(scope, [ref], 2000, signal);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.text.length <= 2000);
    const page = JSON.parse(rows[0]!.text) as { text: string; nextRef: string | null; start: number };
    assert.equal(page.start, complete.length);
    complete += page.text;
    ref = page.nextRef;
    pages += 1;
    assert.ok(pages < 100);
  }

  assert.ok(pages > 1);
  assert.deepEqual(JSON.parse(complete).reports, large.reports);
});

test("User sources keep peer identities and exact missing material is routed through the injected reader", async () => {
  const peer: CentralRuntimeSourcePort = {
    async snapshot() { return { boardSequence: 2, opportunities: [{ subject: { plane: "user", ledgerRef: "user:ledger", questionRef: "user:question" },
      sourceRef: "user:source", description: "A user learning question", constraints: [] }], materials: [], sourceRefs: ["user:source"] }; },
    async read(_scope, refs) { return refs.includes("user:source") ? [{ ref: "user:source", kind: "source", text: "Public user question", sourceRefs: ["user:question"] }] : []; },
  };
  const f = fixture([], { peerSources: [peer] });

  assert.deepEqual((await f.source.snapshot(scope, signal)).opportunities[0]!.subject,
    { plane: "user", ledgerRef: "user:ledger", questionRef: "user:question" });
  assert.equal((await f.source.read(scope, ["user:source"], 1024, signal))[0]!.text, "Public user question");
});

test("explicit User ownership follows the original scope archive lookup without decoding Agent material", async () => {
  const peer = { owns: (_scope: string, ref: string) => ref === "opaque-original-ledger-identity",
    async snapshot() { return { boardSequence: 0, opportunities: [], materials: [], sourceRefs: [] }; },
    async read() { return [{ ref: "opaque-original-ledger-identity", kind: "source" as const,
      text: "Source-owned public user material", sourceRefs: ["question:original"] }]; } };
  const f = fixture([], { peerSources: [peer] });

  assert.equal((await f.source.read(scope, ["opaque-original-ledger-identity"], 1024, signal))[0]!.text, "Source-owned public user material");
  assert.equal(f.reads(), 1);
});

test("exact archive reads survive compaction while snapshot does not load archive bodies", async () => {
  const state = emptyCentralRuntimeState(scope);
  const material = { ref: "original-material:archived", kind: "source" as const, text: "Archived record body", sourceRefs: ["original:source"] };
  const completed = { intentId: "intent:archived", operation: { kind: "think" as const, operationId: "operation:archived", purpose: "Compare the original sources",
    expectedChange: "Find the unresolved premise", sourceRefs: ["original:source"] }, outcome: "returned" as const,
    resultRefs: [material.ref], publicResult: "An original public result" };
  const ended: CentralLearningIntentDraft = { intentId: "intent:archived", subject: { plane: "agent", domain: "tool", issueId: "issue:history" },
    goal: "Private-to-archive unfinished purpose body", rationale: "The original sources require a later premise", conditions: [], knowledge: [],
    residual: ["An unresolved prerequisite"], commitment: { purpose: "Retain the original purpose", assumptions: [], reconsiderWhen: [] },
    revisionReason: "End this expenditure, keep goal open", sourceRefs: ["original:source"],
    continuation: { kind: "ended", goalState: "open", reason: "Original required source unavailable" } };
  const first = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...state, materials: [material], completed: [completed], intents: [ended] },
    reason: "Original completed operation", sourceRefs: [material.ref] });
  const second = buildCentralRuntimeRecord({ previousRef: first.id, state,
    reason: "Compact terminal history while retaining original facts", sourceRefs: [first.id] });
  const f = fixture([]);
  f.set({ ...f.state(), sequence: 2, rewardV2Facts: [{ ...first, sequence: 1 }, { ...second, sequence: 2 }] });
  assert.ok(!(await f.source.snapshot(scope, signal)).materials.some(item => item.text.includes(material.text)));
  assert.equal((await f.source.read(scope, [material.ref], 4096, signal))[0]!.text, material.text);
  const operation = await f.source.read(scope, ["operation:archived"], 4096, signal);

  assert.equal(JSON.parse(operation[0]!.text).value.operation.operationId, "operation:archived");
  const exact = `central-runtime-archive:${encodeURIComponent(JSON.stringify({ kind: "completed", operationId: "operation:archived", factRef: first.id }))}`;

  assert.equal(JSON.parse((await f.source.read(scope, [exact], 4096, signal))[0]!.text).factRef, first.id);
  const related = await f.source.snapshot(scope, signal, { subjects: [ended.subject], sourceRefs: [] });
  const catalog = related.materials.find(item => item.ref.startsWith("central-runtime-purpose-navigation:"));
  assert.ok(catalog);
  assert.equal(JSON.parse(catalog.text).entries[0].intentId, ended.intentId);
  assert.ok(!catalog.text.includes('"rationale"'));
  assert.equal(JSON.parse((await f.source.read(scope, [ended.intentId], 4096, signal))[0]!.text).value.goal, ended.goal);
});

test("disabled, cancelled and foreign scope reads have no nomination or Board access", async () => {
  const disabled = fixture([], { enabled: () => false });
  await assert.rejects(disabled.source.snapshot(scope, signal), /collect_disabled/);
  assert.equal(disabled.reads(), 0);
  const f = fixture([]), cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.source.snapshot(scope, cancelled.signal), /cancelled/);
  await assert.rejects(f.source.read("workspace:other", ["a"], 1024, signal), /scope/);
  assert.equal(f.reads(), 0);
});

test("actual advisory feedback recalls a compacted purpose through its authenticated original subject before snapshot projection", async t => {
  const root = await mkdtemp(join(tmpdir(), "trylo-advisory-source-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const board = createRewardV2BoardPort(root, () => true), state = emptyCentralRuntimeState(scope), budgetId = "budget:advisory-source";
  const append = async (draft: RewardV2Draft) => {
    const prefix = await board.read();
    assert.equal((await board.append(prefix.revision, draft)).status, "written");
    const fact = (await board.read()).facts.find(row => row.id === draft.id);
    assert.ok(fact);
    return fact;
  };
  const knowledge = { statement: "Zyzzyva condition.", conditions: "Quokka setting.", sourceRefs: ["evidence:zyzzyva"] };
  const ended: CentralLearningIntentDraft = { intentId: "intent:zyzzyva", subject: { plane: "user", ledgerRef: "ledger:zyzzyva", questionRef: "question:zyzzyva" },
    goal: "Zyzzyva premise", rationale: "Quokka uncertainty", conditions: ["Quokka setting."], knowledge: [knowledge], residual: ["Zyzzyva residual"],
    commitment: { purpose: "Zyzzyva comparison", assumptions: [], reconsiderWhen: ["Quokka counterexample"] },
    revisionReason: "Zyzzyva investment ended", sourceRefs: knowledge.sourceRefs,
    continuation: { kind: "ended", goalState: "open", reason: "Quokka observations unavailable" } };
  const head = await append(buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...state, intents: [ended] },
    reason: "Retain a conditional purpose", sourceRefs: knowledge.sourceRefs }));
  const operationId = "operation:advisory-computation", decisionRef = centralOrganizationDeliberationRef(scope, operationId);
  const decision: OrganizationDecision = { kind: "decision", decisionRef, purposeRef: operationId,
    context: { purpose: "Consider public retrieval", conditionKeys: [], known: [], residual: [] },
    program: { programRef: "program:public-retrieval", depth: "One bounded decision", timing: "now" },
    expectation: { change: "Select a conditional advisory", uncertainties: ["Later effects unknown"] },
    alternatives: [], issueRefs: [], stageRefs: [], sourceRefs: [operationId], experienceUse: null };

  await append(buildOrganizationRecord(scope, decision));
  const prefix = await board.read(), receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: root, scope, budgetId, enabled: () => true });
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId, boardSequence: prefix.revision,
    configuration: { schemaVersion: 1, configurationRef: "configuration:advisory-source", authorizationRef: "authorization:advisory-source",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: prefix.revision, budgetId, limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: head.id, state: { ...state, intents: [ended] }, opportunities: [], organization: [],
    materials: [{ ref: knowledge.sourceRefs[0]!, kind: "source", text: "A public conditional observation.", sourceRefs: knowledge.sourceRefs }],
    operation: { kind: "think", operationId, purpose: "Select conditional public knowledge", expectedChange: "Retain explicit uncertainty", sourceRefs: knowledge.sourceRefs } };
  const selected = { kind: "publish" as const, intentId: ended.intentId, knowledgeHash: centralAdvisoryKnowledgeHash(knowledge),
    whenRelevant: "The original setting recurs", uncertainty: "Later effectiveness is unknown" };
  const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [ended], publicExplanation: "Share conditional knowledge as advisory data.",
    sourceRefs: knowledge.sourceRefs, knowledgeHandoffs: [selected] };
  const delivery = await receipts.save({ request, output });
  const resultRef = `central-deliberation-result:${contentHashOf(output)}`;
  const applied = await append(buildCentralRuntimeRecord({ previousRef: head.id,
    state: { ...state, intents: [ended], completed: [{ intentId: "central:agenda", operation: request.operation,
      outcome: "returned", resultRefs: [resultRef], publicResult: output.publicExplanation }] },
    reason: "central_deliberation_returned", sourceRefs: output.sourceRefs,
    opportunityConsideration: { operationId, deliveryRef: delivery.deliveryRef, resultRef, sourceRefs: [] } }));
  const value: CentralAdvisoryPublish = { schemaVersion: 1, type: CENTRAL_ADVISORY_TYPE, kind: "publish", scope,
    budgetId, advisoryId: centralAdvisoryId(scope, ended.intentId, centralAdvisoryKnowledgeHash(knowledge)),
    intentId: ended.intentId, purposeHeadRef: head.id, purposeConditions: ended.conditions, knowledgeHash: centralAdvisoryKnowledgeHash(knowledge),
    ...knowledge, whenRelevant: selected.whenRelevant, uncertainty: selected.uncertainty, accessSourceRefs: knowledge.sourceRefs,
    decisionRef: operationId, deliveryRef: delivery.deliveryRef,
    appliedStateRef: applied.id, appliedSequence: applied.sequence, previousPublicationRef: null };
  const unprovedPublication = await append(buildCentralAdvisoryRecord({ ...value, appliedStateRef: head.id, appliedSequence: head.sequence }));
  const unprovedFeedback = await append(buildOrganizationRecord(scope, { kind: "feedback", decisionRef, unitRef: "advisory-session-use:unproved", supersedes: null,
    sourceRefs: [unprovedPublication.id, ended.intentId, "delivery:unproved-pa-task"],
    result: { kind: "adoption", state: "used", artifactRefs: [unprovedPublication.id], exposureRef: "delivery:unproved-pa-task" } }));
  const publication = await append(buildCentralAdvisoryRecord(value));
  const compacted = await append(buildCentralRuntimeRecord({ previousRef: applied.id, state, reason: "Compact terminal purpose from working agenda", sourceRefs: [applied.id] }));
  const source = createCentralRuntimeSource({ boardRoot: root, scope, ports: [], enabled: () => true });
  const unauthenticated = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [], wakeSourceRefs: [unprovedFeedback.id, ended.intentId] });

  assert.ok(!unauthenticated.materials.some(row => row.ref.startsWith("central-runtime-purpose-navigation:")),
    "a shape/hash-valid publication without its exact applied handoff cannot turn feedback into purpose authority");
  const before = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [], wakeSourceRefs: [publication.id, ended.intentId] });

  assert.ok(!before.materials.some(row => row.ref.startsWith("central-runtime-purpose-navigation:")), "bare intent and publication addresses are not feedback");
  const feedback = await append(buildOrganizationRecord(scope, { kind: "feedback", decisionRef, unitRef: "advisory-session-use:actual", supersedes: null,
    sourceRefs: [publication.id, ended.intentId, "delivery:actual-pa-task"],
    result: { kind: "adoption", state: "used", artifactRefs: [publication.id], exposureRef: "delivery:actual-pa-task" } }));

  assert.notEqual(decisionRef, operationId, "the actual organization computation uses its native derived ref");
  const unbound = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [], wakeSourceRefs: [ended.intentId] });

  assert.ok(!unbound.materials.some(row => row.ref.startsWith("central-runtime-purpose-navigation:")),
    "a claimed intent alone cannot select existing advisory feedback");
  const after = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [], wakeSourceRefs: [feedback.id, ended.intentId] });

  assert.ok(after.materials.some(material => readOrganizationFeedbackMaterial(material, scope)?.factId === feedback.id),
    "the actual wake delivers the original canonical organization feedback body");
  assert.ok(after.sourceRefs.includes(feedback.id), "the exact feedback source becomes visible and consumed in this same snapshot");
  const recalled = after.materials.find(row => row.ref.startsWith("central-runtime-purpose-navigation:"));
  assert.ok(recalled);
  const row = JSON.parse(recalled.text).entries.find((entry: { intentId: string }) => entry.intentId === ended.intentId);

  assert.deepEqual(row.subject, ended.subject);
  assert.equal(row.factRef, head.id);
  assert.equal(row.goalState, "open");
  const body = after.materials.find(material => material.ref === row.readRef);
  assert.ok(body);
  assert.deepEqual(JSON.parse(body.text).value, ended);
  assert.ok(after.reconsider?.some(change => change.reason === "original_central_advisory_feedback_changed"
    && change.subject.plane === "user" && change.subject.questionRef === "question:zyzzyva" && change.sourceRefs.includes(feedback.id)));
  const final = await board.read();
  assert.equal(final.revision, feedback.sequence);
  assert.deepEqual(readCentralRuntimeRecords(final.facts, scope, final.revision).state.intents, [],
    "recall does not resume or rewrite the persisted working agenda");
  const active: CentralLearningIntentDraft = { ...ended, continuation: { kind: "waiting", wait: { kind: "use_feedback",
    reason: "Await original advisory feedback", sourceRefs: [publication.id] } } };
  const query = { subjects: [active.subject], sourceRefs: [], wakeSourceRefs: [],
    purposes: [{ subject: active.subject, purpose: active.goal, sourceRefs: [active.intentId] }] };
  const stillEnded = await source.snapshot(scope, signal, query);

  assert.ok(!stillEnded.sourceRefs.includes(feedback.id), "a query cannot reactivate an ended native purpose");
  await append(buildCentralRuntimeRecord({ previousRef: compacted.id, state: { ...state, intents: [active] },
    reason: "Original central decision resumes its purpose", sourceRefs: [head.id] }));
  const cold = createCentralRuntimeSource({ boardRoot: root, scope, ports: [], enabled: () => true });
  const recovered = await cold.snapshot(scope, signal, query);

  assert.ok(recovered.materials.some(material => readOrganizationFeedbackMaterial(material, scope)?.factId === feedback.id),
    "a cold active purpose discovers original unconsumed feedback even when its transient wake hint is gone");
  const consumed = await cold.snapshot(scope, signal, { ...query, sourceRefs: [feedback.id] });

  assert.ok(!consumed.sourceRefs.includes(feedback.id), "a consumed original cannot create another feedback sample or paid wake");
});
