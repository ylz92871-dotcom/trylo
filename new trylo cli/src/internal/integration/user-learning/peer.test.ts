import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { createFileLedgerPort } from "./ledger-file.js";
import { createUserLearningPeer } from "./peer.js";
import { userOperationCallIdentity } from "./operation-budget.js";
import { createUserPeerRuntimeAdapter } from "./central-runtime-adapter.js";
import { extractEvidence } from "../../learning/domains/user/evidence.js";
import { classifyUserSignal } from "../../learning/domains/user/evidence-grounding.js";
import { readLearnedUserPolicy, selectLearnedUserPolicy, createUserFeedbackRecords, createUserFieldingRecords } from "./learned-policy.js";
import { buildSemanticUserVersion } from "../../learning/domains/user/semantic-version.js";
import type { UserSemanticDraft } from "../../learning/domains/user/semantic-draft.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { CentralRuntimeWork } from "../../learning/central/runtime/contracts.js";
import { readPendingUserClarification } from "./clarification.js";
import { createMemoryLedgerPort } from "../../learning/domains/user/scheduler-ports.js";
import { CentralRuntimeBlocked } from "../../learning/central/runtime/errors.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createCentralRuntimeStore } from "../central-learning/runtime-store.js";
import { archiveCentralRuntimeMaterials } from "../central-learning/runtime-archive.js";
import { createCentralRuntimeSource } from "../central-learning/runtime-source.js";

const issuedAt = "2026-11-05T01:00:00.000Z", workspaceId = "workspace-user", scope = "scope:user-peer";
const preference = "以后在项目架构讨论时先列可逆方案和代价，不要一开始替我定唯一架构";

function evidence(text = preference, turnId = "t1") {
  const grounding = classifyUserSignal(text, "explicit_statement");
  const result = extractEvidence({ text, source: { workspaceId, sessionId: "session", turnId }, ...grounding, now: 1 });
  assert.ok(result);
  return result;
}

function draft(evidenceId: string, state: UserSemanticDraft["progress"]["state"] = "completed"): UserSemanticDraft {
  return { schemaVersion: 1, eligibility: [{ evidenceId, classification: "personalization_candidate", rationale: "用户明确选择协作方式，有其他同样合格方案" }],
    conclusions: [{ key: "architecture-choice", statement: "架构未定时用户需要看可逆备选及代价", dimension: "architecture_refactor",
      evidenceIds: [evidenceId], counterEvidenceIds: [], conditions: "项目架构探索；已定实现不适用" }],
    models: [{ key: "architecture", conclusionKeys: ["architecture-choice"], statement: "在架构取舍尚未冻结时用可逆性解释不同选择有助于此用户作决定",
      distance: "D2", alternatives: ["也可能只适用于当前项目"] }],
    policies: [{ modelKey: "architecture", instruction: "先比较可逆的架构备选及其代价，再提出建议", applicability: "架构探索；不用于已定实现",
      includeTerms: ["架构", "方案"], excludeTerms: ["已定实现"], evidenceIds: [evidenceId] }],
    progress: { state, understanding: state === "continue" ? "已辨清偏好与通用质量，尚需比较适用反例" : "已比较边界，形成可撤销的架构协作建议",
      remaining: state === "continue" ? "与已定实现区分" : "实际后效未知，等待使用", nextAction: state === "continue" ? "比较同项目已定实现是否误用此偏好" : "", clarification: state === "clarification" ? "这个偏好是否仅限架构尚未定案时？" : null } };
}

async function fixture(t: { after(fn: () => Promise<void>): void }, responses: readonly (UserSemanticDraft | "disconnect" | "invalid" | "rate_limit")[], minimumOutputTokens = 0, initialEvidence = evidence()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-user-peer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board"), ledgerRoot = path.join(root, "user");
  const opened = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "open", issuedAt,
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope,
      unit: "total_model_tokens", limits: { tokens: 200000, calls: 8, steps: 8 }, authorizationRef: "explicit-host" } } }));
  assert.ok(opened.ok);
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, budgetId: "root", scope,
    owner: { kind: "user_learning", ownerId: scope }, now: () => issuedAt, enabled: () => true });
  const requests: ProviderRequest[] = [];
  let index = 0;
  const provider: ProviderPort = { fork: () => ({ async *stream(request) {
    requests.push(request);
    const response = responses[index++];

    if (minimumOutputTokens > (request.maxOutputTokens ?? 0)) {
      const output = request.maxOutputTokens ?? 0;
      yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false } satisfies ProviderEvent;
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: output, totalTokens: output + 100,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: output } } satisfies ProviderEvent;
      return;
    }

    if (response === "disconnect") throw new Error("injected_transport_loss");

    if (response === "rate_limit") {
      yield { type: "error", class: "rate_limit", retryable: false, phase: "before_headers", message: "controlled 429" } satisfies ProviderEvent;
      return;
    }

    yield { type: "stream_start", providerId: "controlled", model: "test", warnings: [] } satisfies ProviderEvent;
    yield { type: "text_delta", blockId: "b", text: response === "invalid" ? "{}" : JSON.stringify(response) } satisfies ProviderEvent;
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false } satisfies ProviderEvent;
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: Math.max(50, minimumOutputTokens), totalTokens: 100 + Math.max(50, minimumOutputTokens),
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: minimumOutputTokens } } satisfies ProviderEvent;
  } }), async *stream() { throw new Error("business_provider_must_not_run"); } };
  const ledger = createFileLedgerPort(ledgerRoot), source = initialEvidence;
  assert.ok(ledger.append([{ record: "evidence", evidence: source }]).ok);
  const deps = { ledger, userId: "local-user", workspaceId, fundingOwnerId: scope, provider, model: "controlled-model", funding, enabled: () => true, now: () => 10 };
  const peer = createUserLearningPeer(deps);
  const run = async (maxCalls = 2, operationRef = "work:1") => { const inspected = peer.inspect();
  assert.ok(inspected.ok);
    return peer.advance({ questionRef: inspected.questionRef, sourcePrefixRef: inspected.sourcePrefixRef,
      purpose: "理解架构协作的适用边界", maxTokensPerCall: 30000, maxTotalTokens: 60000, maxCalls, operationRef }, new AbortController().signal); };
  const records = () => {
    const loaded = ledger.read();
    assert.ok(loaded.ok);
    assert.equal(loaded.unreadable, 0);
    return loaded.records;
  };
  const board = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  return { root, ledgerRoot, boardRoot, ledger, source, deps, peer, run, requests, records, board };
}

test("User can finish reasoning beyond the former 8192 output ceiling within its authorized allowance", async t => {
  const source = evidence(), f = await fixture(t, [draft(source.id)], 9000);
  const result = await f.run(1);
  assert.equal(result.state, "result");
  assert.equal(f.requests.length, 1);
  assert.ok((f.requests[0]!.maxOutputTokens ?? 0) > 8192);
  const projection = centralBudgetProjection(await f.board(), "root")!;
  assert.equal(projection.occupied.tokens, 9100);
});

test("User independently compares old evidence across calls, preserves layers and delivers beyond two fixed decision points", async t => {
  const source = evidence(), f = await fixture(t, [draft(source.id, "continue"), draft(source.id)]);
  const result = await f.run();
  assert.equal(result.state, "result");
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.tools.length === 0 && request.continuationScope === undefined));
  assert.match(f.requests[1]!.messages.at(-1)!.content, /比较同项目已定实现/);
  const learned = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 20 });
  assert.equal(learned.status, "ready");

  if (learned.status !== "ready") return;

  assert.equal(learned.policy.models[0]?.confirmation, "unconfirmed");
  assert.equal(learned.policy.models[0]?.effectiveness, "unknown");
  assert.equal(learned.policy.policies[0]?.rule.domain, "architecture_refactor");
  assert.equal(learned.policy.policies[0]?.rule.originMark, "inferred");
  assert.match(selectLearnedUserPolicy(learned.policy, "讨论数据库架构", 2000).segment ?? "", /先比较可逆/);
  assert.equal(selectLearnedUserPolicy(learned.policy, "架构已定实现", 2000).segment, undefined);
  const projection = centralBudgetProjection(await f.board(), "root")!;
  assert.equal(projection.occupied.tokens, 300);
  assert.equal(projection.budget.accounting?.every(item => item.owner.kind === "user_learning"), true);
  assert.equal((await f.board()).centralLearningGrants?.length ?? 0, 0);
  const rerun = await f.run();
  assert.equal(rerun.state, "result");
  assert.equal(f.requests.length, 2);
  assert.equal(f.peer.recover("work:1")?.state, "result");
});

test("User reports survive real advance at the same source prefix without changing archived bodies or creating notices", async t => {
  const f = await fixture(t, [draft(evidence().id)]), adapter = createUserPeerRuntimeAdapter(f.peer), signal = new AbortController().signal;
  const beforeState = f.peer.inspect();
  assert.ok(beforeState.ok);
  const before = await adapter.source.snapshot(scope, signal), original = before.materials[0]!;
  const subject = { plane: "user" as const, ledgerRef: beforeState.ledgerRef, questionRef: beforeState.questionRef };
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 30000, maxCalls: 1, maxSteps: 1, maxPromptChars: 60000 };
  const adviceBefore = await adapter.execution.consult({ scope, subject, allowance, signal });
  const legacy = { ref: beforeState.sourcePrefixRef, kind: "source" as const, sourceRefs: [beforeState.sourcePrefixRef],
    text: JSON.stringify({ owner: "user_learning", questionRef: beforeState.questionRef, hasEvidence: beforeState.hasEvidence,
      policyRefs: beforeState.policyRefs, progress: beforeState.progress }) };
  const store = createCentralRuntimeStore({ boardRoot: f.boardRoot, enabled: () => true });
  const archivedBefore = await archiveCentralRuntimeMaterials(store, await store.read(scope), [legacy, ...before.materials, adviceBefore]);

  assert.equal(archivedBefore.status, "archived");
  const learned = await f.run(1);
  assert.equal(learned.state, "result");
  assert.equal(f.requests.length, 1);
  const afterState = f.peer.inspect();
  assert.ok(afterState.ok);
  assert.equal(afterState.sourcePrefixRef, beforeState.sourcePrefixRef);
  const after = await adapter.source.snapshot(scope, signal), current = after.materials[0]!;
  const adviceAfter = await adapter.execution.consult({ scope, subject, allowance, signal });
  const archivedAfter = await archiveCentralRuntimeMaterials(store, await store.read(scope), [...after.materials, adviceAfter]);

  assert.equal(archivedAfter.status, "archived");
  assert.notEqual(current.text, original.text);
  assert.notEqual(current.ref, original.ref);
  assert.notEqual(adviceAfter.ref, adviceBefore.ref);

  for (const material of [original, current, adviceBefore, adviceAfter])
    assert.equal(material.ref, `user-report:${contentHashOf({ kind: material.kind, text: material.text, sourceRefs: material.sourceRefs })}`);

  assert.deepEqual(after.sourceRefs, before.sourceRefs);
  assert.deepEqual(after.sourceRefs, [beforeState.sourcePrefixRef]);
  assert.deepEqual(await adapter.source.snapshot(scope, signal), after);
  assert.deepEqual(await adapter.source.read(scope, [current.ref], 10000, signal), [current]);
  assert.deepEqual(await adapter.source.read(scope, [original.ref], 10000, signal), []);
  assert.deepEqual(await adapter.source.read(scope, [beforeState.sourcePrefixRef], 10000, signal), [current]);
  await assert.rejects(adapter.source.read(scope, [current.ref], 1, signal), /user_learning_source_capacity/);
  const source = createCentralRuntimeSource({ boardRoot: f.boardRoot, scope, enabled: () => true, ports: [], peerSources: [adapter.source] });

  assert.deepEqual(await source.read(scope, [original.ref], 10000, signal), [original]);
  assert.deepEqual(await source.read(scope, [current.ref], 10000, signal), [current]);
  assert.deepEqual(await source.read(scope, [beforeState.sourcePrefixRef], 10000, signal), [legacy]);
});

test("unfinished knowledge is private candidate, clarification waits without paid spinning", async t => {
  const source = evidence(), f = await fixture(t, [draft(source.id, "continue"), draft(source.id, "clarification")]);
  const result = await f.run();
  assert.equal(result.waitFor, "user_clarification");
  assert.ok(result.clarificationRef);
  assert.match(f.peer.readClarification(result.clarificationRef!) ?? "", /是否仅限/);
  const pending = readPendingUserClarification({ ledger: f.ledger, userId: "local-user", workspaceId });

  assert.equal(pending.status, "pending");
  if (pending.status === "pending") assert.match(pending.question, /是否仅限/);

  assert.equal(readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 20 }).status, "unavailable");
  await f.run();
  assert.equal(f.requests.length, 2);
});

test("a settled local timeout gains a durable unknown checkpoint before the same User operation continues", async t => {
  const f = await fixture(t, [draft(evidence().id)]), state = f.peer.inspect();
  assert.ok(state.ok);
  const input = { operationRef: "work:1", questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef,
    purpose: "理解架构协作的适用边界", maxTokensPerCall: 30000, maxTotalTokens: 60000, maxCalls: 2, maxPromptChars: 60000 };
  const identity = userOperationCallIdentity({ ...input, step: 1, nextAction: input.purpose });
  const funded = await f.deps.funding.inspect();
  assert.ok(funded.ok);
  assert.ok((await f.deps.funding.reserve({ reservationId: identity.reservationId, maxTokens: 30000,
    expectedSequence: funded.boardSequence })).ok);
  assert.ok((await f.deps.funding.settle({ reservationId: identity.reservationId,
    usage: { kind: "unknown", reason: "content_model_timeout" } })).ok);
  const work: CentralRuntimeWork = { intentId: "intent:local-timeout", workRef: input.operationRef,
    operation: { kind: "dispatch", operationId: "local-timeout", purpose: input.purpose, expectedChange: "compare original evidence",
      sourceRefs: [state.sourcePrefixRef], allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 60000,
        maxCalls: 2, maxSteps: 2, maxPromptChars: 60000 } }, frame: { kind: "user_learning", ledgerRef: state.ledgerRef, ...input } };
  const adapter = createUserPeerRuntimeAdapter(f.peer), signal = new AbortController().signal;
  const recovered = await adapter.execution.recover(work, signal);

  assert.ok(recovered !== null && !("kind" in recovered));
  assert.equal(recovered.outcome, "unknown");
  const checkpoints = f.records().filter(row => row.record === "learning_progress");

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.progress.state, "unknown");
  assert.deepEqual(checkpoints[0]?.progress.consumedEvidenceIds, []);
  assert.deepEqual(checkpoints[0]?.progress.committedReservationIds, [identity.reservationId]);
  assert.equal(f.records().filter(row => row.record === "learning_version").length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.peer.recover(input.operationRef)?.outcome, "unknown");
  await adapter.execution.recover(work, signal);
  assert.equal(f.records().filter(row => row.record === "learning_progress").length, 1);
  const continued = await f.peer.advance(input, signal);
  assert.equal(continued.state, "result");
  assert.equal(f.requests.length, 1);
  const projection = centralBudgetProjection(await f.board(), "root")!;

  assert.equal(projection.occupied.tokens, 30150);
  assert.equal(projection.budget.accounting?.[0]?.usage?.kind, "unknown");
});

test("User can reassess its own inference on the same source without inventing a user withdrawal", async t => {
  const source = evidence("以后包装器应在访问属性前识别 null，而不能把调用错误写成接收方拒绝。", "quality-source");
  const proposed = draft(source.id), corrected: UserSemanticDraft = { ...proposed,
    eligibility: [{ evidenceId: source.id, classification: "general_quality_defect", rationale: "Both proposed alternatives are not equally correct: null access and false rejection are defects." }],
    conclusions: [], models: [], policies: [], progress: { ...proposed.progress, state: "no_result",
      understanding: "The supplied support concerns correctness, no personal preference is established.", remaining: "", nextAction: "" } };
  const f = await fixture(t, [proposed, corrected], 0, source);

  assert.equal((await f.run(1)).state, "result");
  const first = f.records().find(row => row.record === "learning_version");
  assert.ok(first?.record === "learning_version");
  assert.equal(first.version.policies.length, 1);
  const state = f.peer.inspect();
  assert.ok(state.ok);
  const result = await f.peer.advance({ operationRef: "work:1", questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef,
    purpose: "Reassess whether the previous inference is a preference or ordinary correctness", reconsiderVersionRef: first.version.versionId,
    maxTokensPerCall: 30000, maxTotalTokens: 60000, maxCalls: 2 }, new AbortController().signal);

  assert.equal(result.state, "waiting");
  assert.equal(result.reason, "no_result");
  assert.equal(f.requests.length, 2);
  const learned = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 20 });
  assert.equal(learned.status, "ready");

  if (learned.status !== "ready") return;

  assert.equal(learned.policy.policies.length, 0);
  assert.equal(learned.policy.models.length, 0);
  assert.equal(learned.policy.conclusions.length, 0);
  assert.deepEqual(learned.policy.eligibility.map(row => row.classification), ["general_quality_defect"]);
  assert.deepEqual(f.records().find(row => row.record === "learning_version"), first);
  assert.equal(f.records().filter(row => row.record === "policy_feedback").length, 0);
  assert.equal(centralBudgetProjection(await f.board(), "root")?.occupied.tokens, 300);
});

test("lost model result keeps its original reservation and cannot charge a second request after reopening", async t => {
  const f = await fixture(t, ["disconnect"]);
  const first = await f.run(1);
  assert.equal(first.state, "waiting");
  const reopened = createUserLearningPeer({ ...f.deps, ledger: createFileLedgerPort(f.ledgerRoot) });
  const state = reopened.inspect();
  assert.ok(state.ok);
  const retry = await reopened.advance({ questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef, purpose: "理解架构协作的适用边界",
    maxTokensPerCall: 30000, maxCalls: 1, operationRef: "work:1" }, new AbortController().signal);
  assert.equal(retry.reason, "user_learning_request_already_reserved");
  assert.equal(f.requests.length, 1);
  assert.equal(centralBudgetProjection(await f.board(), "root")?.occupied.tokens, 30000);
});

test("generic dissatisfaction is an observation, never attribution to every exposed policy", async t => {
  const source = evidence(), f = await fixture(t, [draft(source.id)]);
  await f.run();
  const learned = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 20 });
  assert.equal(learned.status, "ready");
  if (learned.status !== "ready") return;

  const policy = learned.policy, fielding = createUserFieldingRecords({ policy, selectedRuleIds: [policy.policies[0]!.rule.id],
    turnId: "actual", attemptId: "actual", beat: 1, at: 21 })[0];
  assert.equal(fielding?.record, "policy_fielding");
  if (fielding?.record !== "policy_fielding") return;

  f.ledger.append([fielding]);

  for (const [eventId, text] of [["steer", "顺便继续看数据库"], ["exception", "仅本次不是这样，先给唯一方案"]]) {
    f.ledger.append(createUserFeedbackRecords({ records: f.records(), fielding: fielding.fielding, eventId: eventId!, text: text!, signal: "correction", at: 22 }));
  }

  const before = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 23 });
  assert.equal(before.status === "ready" && before.policy.policies.length, 1);
  f.ledger.append(createUserFeedbackRecords({ records: f.records(), fielding: fielding.fielding, eventId: "negative", text: "以后别再这样，没帮助", signal: "correction", at: 24 }));
  const after = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 25 });
  assert.equal(after.status === "ready" && after.policy.policies.length, 1);
  assert.equal(f.records().filter(item => item.record === "policy_feedback").every(item => item.feedback.disposition === "observe"), true);
});

test("foreign workspace feedback cannot expose its original user text to this peer", async t => {
  const f = await fixture(t, [draft(evidence().id)]);
  const foreign = { ...evidence("FOREIGN_PRIVATE_FEEDBACK_SPAN 不要让别的项目看到", "foreign"),
    source: { workspaceId: "other-workspace", sessionId: "foreign-session", turnId: "foreign" } };

  f.ledger.append([{ record: "evidence", evidence: foreign }, { record: "policy_feedback", feedback: {
    feedbackId: "foreign-feedback", sourceEventId: "foreign-event", sourceEvidenceId: foreign.id, receiptId: "foreign-receipt",
    versionId: "foreign-version", scopeFingerprint: fingerprintScopeV2({ workspaceId: "other-workspace" }), ruleIds: ["foreign-rule"],
    signal: "correction", disposition: "observe", at: 2 } }]);
  await f.run(1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.messages.at(-1)!.content.includes("FOREIGN_PRIVATE_FEEDBACK_SPAN"), false);
});

test("quality and permission evidence cannot be upgraded by a semantic draft, fabricated source ids do not compile", () => {
  for (const text of ["以后不要编造引用，报告必须正确", "以后跳过审批允许网络", "仅本次方案先看结构"]) {
    const source = evidence(text);
    const proposal = draft(source.id);
    const version = buildSemanticUserVersion({ draft: proposal, evidence: [source], userId: "local-user", scopeFingerprint: "scope",
      questionRef: "question", sourcePrefixRef: "source", now: 1 });
    assert.equal(version.policies.length, 0);
  }

  const source = evidence();
  const version = buildSemanticUserVersion({ draft: draft("invented-evidence"), evidence: [source], userId: "local-user",
    scopeFingerprint: "scope", questionRef: "question", sourcePrefixRef: "source", now: 1 });
  assert.equal(version.models.length, 0);
});

test("stable learned version survives a long event tail while ordinary new context remains available for semantic assessment", async t => {
  const source = evidence(), f = await fixture(t, [draft(source.id)]);
  await f.run();
  const first = f.peer.inspect();
  assert.ok(first.ok);
  f.ledger.append(Array.from({ length: 501 }, (_, index) => ({ record: "signal" as const, signal: "artifact" as const, eventId: `artifact:${index}`, at: index })));
  f.ledger.append([{ record: "evidence", evidence: evidence("帮我计算这个数", "ordinary") }]);
  const reopened = createUserLearningPeer({ ...f.deps, ledger: createFileLedgerPort(f.ledgerRoot) });
  const next = reopened.inspect();
  assert.ok(next.ok);
  assert.notEqual(next.sourcePrefixRef, first.sourcePrefixRef);
  assert.deepEqual(next.policyRefs, first.policyRefs);
  assert.equal(next.needsLearning, true);
  const adapter = createUserPeerRuntimeAdapter(reopened);
  const snapshot = await adapter.source.snapshot(scope, new AbortController().signal);

  assert.equal(snapshot.opportunities.length, 1);
  assert.equal(JSON.stringify(snapshot).includes(preference), false);
  assert.equal(f.requests.length, 1);
});

test("indirect non-Chinese source and quality contrast reach the semantic model instead of a keyword eligibility prefilter", async t => {
  const f = await fixture(t, [draft(evidence().id)]);
  const contrast = evidence("For design tradeoffs, show alternatives before choosing; a wrong calculation is just a defect, not my preference.", "english");
  f.ledger.append([{ record: "evidence", evidence: contrast }]);
  await f.run(1);
  assert.match(f.requests[0]!.messages.at(-1)!.content, /show alternatives before choosing/);
  assert.match(f.requests[0]!.messages.at(-1)!.content, /wrong calculation is just a defect/);
});

test("a bounded local update after 33 new evidence items retains old supported policy and only an explicit targeted revision retires it", async t => {
  const source = evidence(), newest = evidence("今后方案取舍先讲适用前提再列备选", "new:32");
  const update = draft(newest.id);
  const empty = { ...draft(source.id), eligibility: [], conclusions: [], models: [], policies: [] };
  const f = await fixture(t, [draft(source.id), empty, update]);
  await f.run(1);
  const prior = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 11 });
  assert.equal(prior.status, "ready");
  if (prior.status !== "ready") return;

  for (let index = 0; index < 33; index += 1) f.ledger.append([{ record: "evidence", evidence: index === 32 ? newest
    : evidence(`此轮对照材料${index}：任务表面变化不代表协作偏好变化`, `new:${index}`) }]);

  await f.run(2, "work:2");
  const next = readLearnedUserPolicy({ records: f.records(), userId: "local-user", workspaceId, now: 12 });
  assert.equal(next.status, "ready");
  if (next.status !== "ready") return;

  assert.equal(next.policy.policies.length, 2);
  assert.ok(next.policy.policies.some(item => item.rule.id === prior.policy.policies[0]!.rule.id));
  const bad = evidence("不对，计算结果错了，没帮助", "math-error");
  const keep = buildSemanticUserVersion({ draft: { ...draft(bad.id), policies: [], conclusions: [], models: [],
    policyRevisions: [{ ruleId: prior.policy.policies[0]!.rule.id, action: "pause", evidenceId: bad.id, quote: bad.rawText, reason: "generic negative" }] },
    evidence: [bad], userId: "local-user", scopeFingerprint: next.policy.scopeFingerprint, questionRef: next.policy.questionRef,
    sourcePrefixRef: "new:bad", previous: next.policy, now: 13 });
  assert.equal(keep.policies.length, 2);
  const quality = evidence("以后不要编造检查结果，结果必须正确", "quality-repair");
  const qualityAttempt = buildSemanticUserVersion({ draft: { ...draft(quality.id), policies: [], conclusions: [], models: [],
    policyRevisions: [{ ruleId: prior.policy.policies[0]!.rule.id, action: "pause", evidenceId: quality.id, quote: quality.rawText, reason: "incorrect attribution" }] },
    evidence: [quality], userId: "local-user", scopeFingerprint: next.policy.scopeFingerprint, questionRef: next.policy.questionRef,
    sourcePrefixRef: "new:quality", previous: next.policy, now: 13 });
  assert.equal(qualityAttempt.policies.length, 2);
  const revoke = evidence("以后架构讨论不要先列可逆方案了，改为先确认我的目标", "specific-change");
  const changed = buildSemanticUserVersion({ draft: { ...draft(revoke.id), policies: [], conclusions: [], models: [],
    policyRevisions: [{ ruleId: prior.policy.policies[0]!.rule.id, action: "pause", evidenceId: revoke.id, quote: revoke.rawText, reason: "specifically changes the old architecture order" }] },
    evidence: [revoke], userId: "local-user", scopeFingerprint: next.policy.scopeFingerprint, questionRef: next.policy.questionRef,
    sourcePrefixRef: "new:revoke", previous: next.policy, now: 14 });
  assert.equal(changed.policies.length, 1);
  assert.equal(changed.policies.some(item => item.rule.id === prior.policy.policies[0]!.rule.id), false);
  assert.equal(changed.policies[0]!.rule.id, next.policy.policies[1]!.rule.id);
});

test("same operation cannot regain its original call allowance by advancing or reopening the peer", async t => {
  const source = evidence();
  const first = draft(source.id, "continue");
  const second = { ...first, progress: { ...first.progress, understanding: "another comparison", nextAction: "different next comparison" } };
  const f = await fixture(t, [first, second]);
  await f.run(1);
  assert.equal(f.requests.length, 1);
  await f.run(1);
  assert.equal(f.requests.length, 1);
  const reopened = createUserLearningPeer({ ...f.deps, ledger: createFileLedgerPort(f.ledgerRoot) });
  const current = reopened.inspect();
  assert.ok(current.ok);
  await reopened.advance({ questionRef: current.questionRef, sourcePrefixRef: current.sourcePrefixRef, purpose: "理解架构协作的适用边界",
    maxTokensPerCall: 30000, maxTotalTokens: 60000, maxCalls: 1, operationRef: "work:1" }, new AbortController().signal);
  assert.equal(f.requests.length, 1);
});

test("central recovery distinguishes an unsent frame from paid work with a lost private result", async t => {
  const f = await fixture(t, ["invalid"]), state = f.peer.inspect();
  assert.ok(state.ok);
  const operation = { kind: "dispatch" as const, operationId: "operation:recover", purpose: "理解架构协作的适用边界",
    expectedChange: "a source-bound user judgment", sourceRefs: [state.sourcePrefixRef], allowance: { schemaVersion: 2 as const,
      unit: "total_model_tokens" as const, maxTokens: 30000, maxCalls: 1, maxSteps: 1, maxPromptChars: 60000 } };
  const work: CentralRuntimeWork = { intentId: "intent:user", operation, workRef: "work:recover", frame: { kind: "user_learning",
    ledgerRef: state.ledgerRef, questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef, purpose: operation.purpose,
    maxTokensPerCall: 30000, maxTotalTokens: 30000, maxCalls: 1, maxPromptChars: 60000, operationRef: "work:recover" } };
  const adapter = createUserPeerRuntimeAdapter(f.peer);

  assert.deepEqual(await adapter.execution.recover(work, new AbortController().signal), { kind: "ready_to_execute" });
  await adapter.execution.execute(work, new AbortController().signal);
  assert.equal(f.requests.length, 1);
  const recovered = await adapter.execution.recover(work, new AbortController().signal);

  assert.ok(recovered !== null && !("kind" in recovered));
  assert.equal(recovered.outcome, "unknown");
  await adapter.execution.execute(work, new AbortController().signal);
  assert.equal(f.requests.length, 1);
});

test("actual provider capacity failure and operation allowance boundary hand back a typed resource wait", async t => {
  for (const response of ["rate_limit", draft(evidence().id, "continue")] as const) {
    const f = await fixture(t, [response]), state = f.peer.inspect();
    assert.ok(state.ok);
    const work: CentralRuntimeWork = { intentId: "intent:wait", workRef: "work:typed-wait", operation: { kind: "dispatch", operationId: "typed-wait",
      purpose: "compare actual evidence", expectedChange: "understanding", sourceRefs: [state.sourcePrefixRef],
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 30000, maxCalls: 1, maxSteps: 1, maxPromptChars: 60000 } },
      frame: { kind: "user_learning", ledgerRef: state.ledgerRef, questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef,
        purpose: "compare actual evidence", maxTokensPerCall: 30000, maxTotalTokens: 30000, maxCalls: 1, maxPromptChars: 60000, operationRef: "work:typed-wait" } };
    const adapter = createUserPeerRuntimeAdapter(f.peer), returned = await adapter.execution.execute(work, new AbortController().signal);

    assert.equal(returned.wait?.kind, "resources");
    assert.equal(f.requests.length, 1);

    if (response !== "rate_limit") {
      const recovered = await adapter.execution.recover(work, new AbortController().signal);
      assert.ok(recovered !== null && !("kind" in recovered));
      assert.equal(recovered.wait?.kind, "resources");
    }
  }
});

test("concurrent operations cannot pay twice for the same logical User computation", async t => {
  const f = await fixture(t, [draft(evidence().id)]);
  let arrivals = 0, release: (() => void) | undefined;
  const bothInspected = new Promise<void>(resolve => { release = resolve; });
  let reservationCount = 0, firstSettled: (() => void) | undefined;
  const settlementCommitted = new Promise<void>(resolve => { firstSettled = resolve; });
  const original = f.deps.funding;
  const funding = { ...original, async inspect() {
    const snapshot = await original.inspect();
    arrivals += 1;
    if (arrivals === 2) release?.();
    if (arrivals <= 2) await bothInspected;
    return snapshot;
  }, async reserve(input: Parameters<typeof original.reserve>[0]) {
    reservationCount += 1;
    if (reservationCount === 1) return original.reserve(input);
    // Both logical checks saw the old prefix, but this second internal read
    // deliberately happens after the first reservation reached the real Board.
    await settlementCommitted;
    return original.reserve(input);
  }, async settle(input: Parameters<typeof original.settle>[0]) {
    const result = await original.settle(input);
    firstSettled?.();
    return result;
  } };
  const a = createUserLearningPeer({ ...f.deps, funding }), b = createUserLearningPeer({ ...f.deps, funding });
  const state = a.inspect();
  assert.ok(state.ok);
  const input = { questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef, purpose: "same computation",
    maxTokensPerCall: 30000, maxTotalTokens: 30000, maxCalls: 1 };

  await Promise.all([a.advance({ ...input, operationRef: "race:a" }, new AbortController().signal),
    b.advance({ ...input, operationRef: "race:b" }, new AbortController().signal)]);
  assert.equal(f.requests.length, 1);
  assert.equal(centralBudgetProjection(await f.board(), "root")?.budget.accounting?.length, 1);
});

test("a later paid call without a private commit takes precedence over an earlier progress receipt", async t => {
  const f = await fixture(t, [draft(evidence().id, "continue"), "invalid"]);
  await f.run(2);
  assert.equal(f.requests.length, 2);
  const state = f.peer.inspect();
  assert.ok(state.ok);
  assert.ok(f.peer.recover("work:1"));
  const work: CentralRuntimeWork = { intentId: "intent:user", workRef: "work:1", operation: { kind: "dispatch", operationId: "work:1",
    purpose: "理解架构协作的适用边界", expectedChange: "understanding", sourceRefs: [state.sourcePrefixRef],
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 60000, maxCalls: 2, maxSteps: 2, maxPromptChars: 60000 } },
    frame: { kind: "user_learning", ledgerRef: state.ledgerRef, questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef,
      purpose: "理解架构协作的适用边界", maxTokensPerCall: 30000, maxTotalTokens: 60000, maxCalls: 2, maxPromptChars: 60000, operationRef: "work:1" } };
  const recovered = await createUserPeerRuntimeAdapter(f.peer).execution.recover(work, new AbortController().signal);

  assert.ok(recovered !== null && !("kind" in recovered));
  assert.equal(recovered.outcome, "unknown");
});

test("a grounded central purpose maps to the original User peer without becoming user evidence", async t => {
  const f = await fixture(t, [draft(evidence().id)]), state = f.peer.inspect();
  assert.ok(state.ok);
  const operation = { kind: "dispatch" as const, destination: { plane: "user" as const }, operationId: "derived-user-purpose",
    purpose: "compare collaboration boundaries", expectedChange: "understanding a useful relation", sourceRefs: ["actual-central-source"],
    allowance: { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 30000, maxCalls: 1, maxSteps: 1, maxPromptChars: 60000 } };
  const adapter = createUserPeerRuntimeAdapter(f.peer);
  const work = await adapter.execution.prepare({ scope, signal: new AbortController().signal,
    configuration: { schemaVersion: 1, configurationRef: "config", authorizationRef: "host", allowance: operation.allowance },
    intent: { intentId: "central:new-purpose", subject: { plane: "central", questionRef: "central:new-purpose" },
      goal: "learn when alternative-first collaboration helps", rationale: "a grounded relation needs comparison", conditions: [],
      knowledge: [{ statement: "public relation", conditions: "specified context", sourceRefs: ["actual-central-source"] }], residual: ["does it apply to this user"],
      commitment: { purpose: "assess original User evidence", assumptions: [], reconsiderWhen: ["missing evidence"] }, revisionReason: "new relation", sourceRefs: ["actual-central-source"],
      derivation: { relation: "compare known conditions", whenRelevant: "architecture discussion", parentRefs: ["actual-central-source"], citations: [] },
      continuation: { kind: "ready", operation } }, operation });

  assert.equal(work.intentId, "central:new-purpose");
  assert.equal(work.frame.questionRef, state.questionRef);
  assert.equal(work.frame.ledgerRef, state.ledgerRef);
  await adapter.execution.execute(work, new AbortController().signal);
  assert.match(f.requests[0]!.messages.at(-1)!.content, /learn when alternative-first collaboration helps/);
  assert.equal(f.records().filter(item => item.record === "evidence").length, 1);
  const empty = createUserLearningPeer({ ...f.deps, ledger: createMemoryLedgerPort() });

  assert.equal(empty.acceptResearch({ intentRef: "central:needs-evidence", goal: "a question", knowledge: [], residual: ["missing user evidence"],
    operationRef: "empty", purpose: "assess evidence", sourceRefs: ["actual-central-source"] }).status, "waiting");
  await assert.rejects(createUserPeerRuntimeAdapter(empty).execution.prepare({ scope, signal: new AbortController().signal,
    configuration: { schemaVersion: 1, configurationRef: "config", authorizationRef: "host", allowance: operation.allowance }, operation,
    intent: { intentId: "central:needs-evidence", subject: { plane: "central", questionRef: "central:needs-evidence" }, goal: "assess original user evidence",
      rationale: "a grounded question", conditions: [], knowledge: [], residual: ["missing user evidence"],
      commitment: { purpose: "assess", assumptions: [], reconsiderWhen: ["new user evidence"] }, revisionReason: "new question",
      sourceRefs: ["actual-central-source"], continuation: { kind: "ready", operation } } }),
  error => error instanceof CentralRuntimeBlocked && error.reason === "user_evidence_missing" && error.boundary === "preparation");
});

test("communication about permission can be learned while permission expansion stays excluded", () => {
  const source = evidence("我喜欢权限请求时先解释原因并给备选，仍由我批准", "permission-communication");
  const proposed = draft(source.id);
  const instruction = "权限请求时先解释原因并给备选，仍由用户批准";
  const version = buildSemanticUserVersion({ draft: { ...proposed, policies: [{ ...proposed.policies[0]!, instruction }] },
    evidence: [source], userId: "local-user", scopeFingerprint: "scope", questionRef: "question", sourcePrefixRef: "source", now: 1 });
  assert.equal(version.policies.length, 1);
  assert.equal(version.policies[0]?.rule.instruction, instruction);
  assert.equal(Object.hasOwn(version.policies[0]!.rule, "permission"), false);
});

test("malformed model output still settles actual usage and never delivers a policy", async t => {
  const f = await fixture(t, ["invalid"]);
  const result = await f.run(1);
  assert.equal(result.reason, "user_learning_response_invalid");
  assert.equal(f.records().some(item => item.record === "learning_version"), false);
  assert.equal(centralBudgetProjection(await f.board(), "root")?.occupied.tokens, 150);
});
