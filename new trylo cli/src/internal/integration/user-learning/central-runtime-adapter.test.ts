import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createUserLearningPeer } from "./peer.js";
import { createUserPeerRuntimeAdapter } from "./central-runtime-adapter.js";
import { createCentralRuntimeSource } from "../central-learning/runtime-source.js";
import { createCentralLearningDriver } from "../central-learning/runtime-driver.js";
import type { CentralLearningConfiguration, CentralLearningIntentDraft, CentralLearningOperation, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { CentralRuntimeBlocked } from "../../learning/central/runtime/errors.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import type { LedgerPort, UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";
import { extractEvidence } from "../../learning/domains/user/evidence.js";
import { classifyUserSignal } from "../../learning/domains/user/evidence-grounding.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";

const scope = "scope:user-source-notice", workspaceId = "workspace:user-source-notice", userId = "local-user";
const signal = new AbortController().signal;

function fixture() {
  let records: UserLearningRecord[] = [];
  const ledger: LedgerPort = { read: () => ({ ok: true, records, unreadable: 0 }),

    append(incoming) {
      records = [...records, ...incoming];
      return { ok: true, appended: incoming.length };
    } };
  const forbidden = async (): Promise<never> => { throw new Error("source_probe_must_not_use_provider_or_funding"); };
  const peer = createUserLearningPeer({ ledger, userId, workspaceId, fundingOwnerId: scope, enabled: () => true, now: () => 1,
    model: "not-a-provider", provider: { async *stream() { await forbidden(); } },
    funding: { inspect: forbidden, reserve: forbidden, settle: forbidden } });

  return { peer, source: createUserPeerRuntimeAdapter(peer).source, replace(incoming: UserLearningRecord[]) { records = incoming; } };
}

function originalEvidence(turnId: string) {
  const text = "以后在项目架构讨论时先列可逆方案和代价，不要一开始替我定唯一架构";
  const evidence = extractEvidence({ text, source: { workspaceId, sessionId: "session", turnId },
    ...classifyUserSignal(text, "explicit_statement"), now: 1 });
  assert.ok(evidence);
  return evidence;
}

test("native User dispatch destination conflicts stop before funding while User preparation and central research remain available", async t => {
  const base = testScratchPath("user-destination-fixtures");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const issuedAt = "2026-11-05T01:00:00.000Z";
  const opened = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "open", issuedAt,
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope,
      unit: "total_model_tokens", limits: { tokens: 200000, calls: 8, steps: 8 }, authorizationRef: "explicit-host" } } }));

  assert.ok(opened.ok);
  const originalFunding = createCentralAccountingFundingAtRoot({ boardRoot, budgetId: "root", scope,
    owner: { kind: "user_learning", ownerId: scope }, now: () => issuedAt, enabled: () => true });
  let fundingInspections = 0, fundingWrites = 0, providerCalls = 0;
  const forbiddenFunding = async (): Promise<never> => {
    fundingWrites += 1;
    throw new Error("prepare_must_not_reserve_or_settle");
  };
  let records: UserLearningRecord[] = [{ record: "evidence", evidence: originalEvidence("destination-contract") }];
  const ledger: LedgerPort = { read: () => ({ ok: true, records, unreadable: 0 }),

    append(incoming) {
      records = [...records, ...incoming];
      return { ok: true, appended: incoming.length };
    } };
  const peer = createUserLearningPeer({ ledger, userId, workspaceId, fundingOwnerId: scope, enabled: () => true, now: () => 1,
    model: "not-a-provider", provider: { async *stream() {
      providerCalls += 1;
      throw new Error("prepare_must_not_call_provider");
    } },
    funding: { ...originalFunding, async inspect() {
      fundingInspections += 1;
      return originalFunding.inspect();
    },

      reserve: forbiddenFunding, settle: forbiddenFunding } });
  const research: Parameters<typeof peer.acceptResearch>[0][] = [];
  const adapter = createUserPeerRuntimeAdapter({ ...peer, acceptResearch(input) {
    research.push(input);
    return peer.acceptResearch(input);
  } });
  const state = peer.inspect();
  assert.ok(state.ok);
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 30000, maxCalls: 1, maxSteps: 1, maxPromptChars: 60000 };
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "config:user-destination",
    authorizationRef: "explicit-host", allowance };
  type Dispatch = Extract<CentralLearningOperation, { kind: "dispatch" }>;
  const operation: Dispatch = { kind: "dispatch", operationId: "operation:user-destination", allowance,
    purpose: "Compare the original User collaboration evidence", expectedChange: "Separate the stated preference from general quality",
    sourceRefs: [state.sourcePrefixRef] };
  const native: CentralLearningIntentDraft = { intentId: "intent:native-user", subject: { plane: "user", ledgerRef: state.ledgerRef, questionRef: state.questionRef },
    goal: "Understand the stated collaboration condition", rationale: "Original User evidence remains owned by its peer", conditions: [],
    knowledge: [{ statement: "The public comparison remains conditional", conditions: "Only the original collaboration context", sourceRefs: [state.sourcePrefixRef] }],
    residual: ["Whether a different collaboration condition changes the preference"],
    commitment: { purpose: "Compare authentic User evidence", assumptions: [], reconsiderWhen: ["New User evidence"] },
    revisionReason: "Preserve the original owner", sourceRefs: [state.sourcePrefixRef], continuation: { kind: "ready", operation } };
  const prepare = (selectedOperation: Dispatch, selected: CentralLearningIntentDraft = native) => adapter.execution.prepare({ scope, signal, configuration,
    intent: { ...selected, continuation: { kind: "ready", operation: selectedOperation } }, operation: selectedOperation });
  const before = await createBoardReader(boardRoot).load();
  assert.ok(before.ok);
  const originalRecords = [...records];

  await assert.rejects(prepare({ ...operation, destination: { plane: "agent", domain: "prompt" } }), error => {
    assert.ok(error instanceof CentralRuntimeBlocked);
    assert.equal(error.reason, "central_runtime_user_destination_mismatch");
    assert.equal(error.boundary, "preparation");
    assert.deepEqual(error.sourceRefs, [state.ledgerRef, state.questionRef]);
    return true;
  });
  assert.equal(fundingInspections, 0);
  assert.equal(fundingWrites, 0);
  assert.equal(providerCalls, 0);
  assert.equal(research.length, 0);
  assert.deepEqual(await createBoardReader(boardRoot).load(), before);
  assert.deepEqual(records, originalRecords);

  const omitted = await prepare(operation);

  assert.equal(omitted.frame.kind, "user_learning");
  assert.equal(omitted.frame.researchIntentRef, null);
  assert.equal(omitted.frame.purpose, operation.purpose);
  const explicitUser = await prepare({ ...operation, destination: { plane: "user" } });

  assert.equal(explicitUser.frame.kind, "user_learning");
  assert.equal(explicitUser.frame.researchIntentRef, null);
  assert.equal(explicitUser.frame.questionRef, state.questionRef);
  assert.equal(fundingInspections, 2);
  assert.equal(research.length, 0);
  const central: CentralLearningIntentDraft = { ...native, intentId: "intent:central-user-research",
    subject: { plane: "central", questionRef: "intent:central-user-research" } };
  const centralWork = await prepare({ ...operation, destination: { plane: "user" } }, central);

  assert.equal(research.length, 1);
  assert.equal(research[0]!.intentRef, central.intentId);
  assert.deepEqual(research[0]!.knowledge, central.knowledge.map(item => item.statement));
  assert.equal(centralWork.frame.researchIntentRef, central.intentId);
  assert.equal(centralWork.frame.ledgerRef, state.ledgerRef);
  assert.equal(centralWork.frame.questionRef, state.questionRef);
  const purpose = JSON.parse(String(centralWork.frame.purpose));

  assert.equal(purpose.goal, central.goal);
  assert.deepEqual(purpose.priorPublicKnowledge, research[0]!.knowledge);
  assert.equal(fundingInspections, 3);
  assert.equal(fundingWrites, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(records, originalRecords);
  assert.deepEqual(await createBoardReader(boardRoot).load(), before);
});

test("normal-entry source composition does not deliberate for empty User metadata but permits a real source", async t => {
  const base = testScratchPath("user-empty-notice-fixtures");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const f = fixture();
  const original = createCentralRuntimeSource({ boardRoot, scope, ports: [], enabled: () => true, peerSources: [f.source] });
  let taskSource = false, deliberations = 0;
  const source: CentralRuntimeSourcePort = { ...original, async snapshot(...args) {
    const snapshot = await original.snapshot(...args);
    return !taskSource ? snapshot : { ...snapshot, sourceRefs: [...snapshot.sourceRefs, "task:original"],
      materials: [...snapshot.materials, { ref: "task:original", kind: "source", text: "An authentic task asks for a useful comparison.", sourceRefs: [] }] };
  } };
  const driver = createCentralLearningDriver({ boardRoot, scope, enabled: () => true, now: () => "2026-11-05T00:00:00.000Z", source,
    deliberation: { async deliberate(request) { deliberations++;
      return { schemaVersion: 1, intents: [], publicExplanation: "No supported unfinished commitment remains.", sourceRefs: request.operation.sourceRefs }; } },
    execution: createUserPeerRuntimeAdapter(f.peer).execution });

  t.after(() => driver.close?.());
  const input = { scope, signal, publish() {}, wake: { reason: "normal_entry", sourceRefs: [] }, configuration: {
    schemaVersion: 1 as const, configurationRef: "explicit:all", authorizationRef: "explicit:all", allowance: {
      schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 10000, maxCalls: 4, maxSteps: 4, maxPromptChars: 10000 } } };

  await driver.drive(input);
  assert.equal(deliberations, 0);
  taskSource = true;
  await driver.drive(input);
  assert.equal(deliberations, 1);
  await driver.drive(input);
  assert.equal(deliberations, 1);
});

test("empty User availability corrects only identity-bound open purposes and does not manufacture repeated notices", async () => {
  const f = fixture(), initial = f.peer.inspect();
  assert.ok(initial.ok);
  assert.deepEqual((await f.source.snapshot(scope, signal)).sourceRefs, []);
  f.replace([{ record: "evidence", evidence: originalEvidence("first") }]);
  const supported = await f.source.snapshot(scope, signal), previous = f.peer.inspect();
  assert.ok(previous.ok);
  assert.equal(supported.opportunities.length, 1);
  const subject = { plane: "user" as const, ledgerRef: previous.ledgerRef, questionRef: previous.questionRef };

  f.replace([]);
  const query = { subjects: [subject], sourceRefs: [initial.sourcePrefixRef, ...supported.sourceRefs],
    purposes: [{ subject, sourceRefs: [...supported.sourceRefs] }] };
  const absent = await f.source.snapshot(scope, signal, query), condition = absent.reconsider?.[0]?.sourceRefs[0];

  assert.ok(condition);
  assert.notEqual(condition, initial.sourcePrefixRef);
  assert.equal(query.sourceRefs.includes(condition), false);
  assert.equal(absent.opportunities.length, 0);
  assert.equal(absent.reconsider?.[0]?.subject, subject);
  assert.ok(absent.materials.some(item => item.ref === condition));
  const consumed = { ...query, sourceRefs: [...query.sourceRefs, ...absent.sourceRefs], purposes: [{ subject,
    sourceRefs: [...supported.sourceRefs, ...absent.sourceRefs, "central-result:derived"] }] };

  assert.deepEqual((await f.source.snapshot(scope, signal, consumed)).sourceRefs, absent.sourceRefs);
  assert.deepEqual((await f.source.snapshot(scope, signal, { ...consumed, purposes: [{ subject,
    sourceRefs: [condition, "central-result:derived"] }] })).sourceRefs, absent.sourceRefs);
  f.replace([{ record: "evidence", evidence: originalEvidence("second") }]);
  const later = await f.source.snapshot(scope, signal);
  f.replace([]);
  const laterAbsence = await f.source.snapshot(scope, signal, { ...consumed, purposes: [{ subject,
    sourceRefs: [...consumed.purposes[0]!.sourceRefs, ...later.sourceRefs] }] });

  assert.notEqual(laterAbsence.reconsider?.[0]?.sourceRefs[0], condition);
  const foreign = { ...subject, ledgerRef: "foreign:ledger" };

  assert.deepEqual((await f.source.snapshot(scope, signal, { subjects: [foreign], sourceRefs: query.sourceRefs,
    purposes: [{ subject: foreign, sourceRefs: supported.sourceRefs }] })).sourceRefs, []);
  const central = { plane: "central" as const, questionRef: "central:derived" };

  assert.deepEqual((await f.source.snapshot(scope, signal, { subjects: [central], sourceRefs: query.sourceRefs,
    purposes: [{ subject: central, sourceRefs: supported.sourceRefs }] })).sourceRefs, []);
  assert.ok((await f.source.snapshot(scope, signal, { subjects: [central], sourceRefs: [], purposes: [{ subject: central,
    sourceRefs: [previous.ledgerRef, previous.questionRef, ...supported.sourceRefs] }] })).reconsider?.length);
  const scopeFingerprint = fingerprintScopeV2({ userId, workspaceId });

  f.replace([{ record: "policy_feedback", feedback: { feedbackId: "negative:original", sourceEventId: "event:negative",
    receiptId: "receipt:actual", versionId: "version:actual", scopeFingerprint, ruleIds: [], signal: "correction", disposition: "observe", at: 1 } }]);
  const negative = await f.source.snapshot(scope, signal);

  assert.ok(negative.materials.length);
  assert.ok(negative.sourceRefs.length);
});
