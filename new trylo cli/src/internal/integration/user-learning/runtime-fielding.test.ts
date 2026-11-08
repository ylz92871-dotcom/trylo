import assert from "node:assert/strict";
import test from "node:test";
import { createCeilingBudgetPort, createFlagCollectionPort, createLocalWorkOrderPort,
  createMemoryLedgerPort, type LedgerPort, type UserLearningPorts } from "../../learning/domains/user/scheduler-ports.js";
import { composeLearningPorts } from "./port.js";
import { createUserLearningRuntime, type UserLearningRuntimeDeps } from "./runtime.js";
import type { UserLearningVersion } from "../../learning/domains/user/learning-cycle-contract.js";
import type { UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";
import { deriveUserPolicy } from "./chain.js";
import { createFakePermission, createFakeProvider, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import type { ProviderEvent } from "../../ports/provider.js";
import { userLearningObserver } from "./observer.js";

const PREF = "以后周报都先说结论，再展开依据";
const TASK = "帮我写这周的周报，先说结论";

function harness(overrides: Partial<UserLearningPorts> = {}, options: { readonly mode?: UserLearningRuntimeDeps["policyMode"];
  readonly seed?: readonly UserLearningRecord[] } = {}) {
  const ledger = createMemoryLedgerPort({ ...(options.seed === undefined ? {} : { seed: options.seed }) });
  const runtime = createUserLearningRuntime({ ports: { collection: createFlagCollectionPort(true),
    budget: createCeilingBudgetPort(1200), workOrder: createLocalWorkOrderPort(true, 1200), ledger, ...overrides },
    userId: "local-user", workspaceId: "ws-1", now: () => 100, warn: () => undefined, policyMode: options.mode ?? "legacy" });
  const records = () => {
    const read = ledger.read();
    assert.equal(read.ok, true);
    return read.ok ? read.records : [];
  };
  const start = (turnId: string, text = PREF) => runtime.capture({ kind: "turn_start", eventId: `${turnId}:start`,
    sessionId: "s-1", turnId, payload: { text } });

  return { runtime, ledger, records, start };
}

function version(versionId = "user-version:1"): UserLearningVersion {
  const source = harness();
  source.start("evidence");
  const policy = deriveUserPolicy({ records: source.records(), userId: "local-user", workspaceId: "ws-1", now: 100 });

  assert.notEqual(policy.rules[0], undefined);

  return { schemaVersion: 1, versionId, questionRef: "user-question:reporting", sourcePrefixRef: "source:reporting",
    scopeFingerprint: policy.scopeFingerprint, evidenceIds: policy.evidence.map(item => item.id), eligibility: [], conclusions: [],
    models: policy.models, policies: policy.rules.map(rule => ({ rule, includeTerms: ["周报"], excludeTerms: [], applicability: "周报汇报" })),
    bundleChecksum: policy.bundleChecksum, at: 100 };
}

test("exhausted learning money preserves collected human corrections", () => {
  const bag = harness({ budget: { allowance: () => ({ available: false, totalChars: 0 }) } });
  bag.start("t1");
  bag.runtime.capture({ kind: "user_correction", eventId: "correction", sessionId: "s-1", turnId: "t1",
    payload: { text: "不对，以后先说结论" } });
  assert.equal(bag.runtime.policyFor(0), undefined);
  assert.equal(bag.records().filter(row => row.record === "evidence").length, 2);
});

test("a missing policy work order cannot veto collection", () => {
  const bag = harness({ workOrder: { grant: () => undefined } });
  bag.start("t1");
  assert.equal(bag.runtime.policyFor(0), undefined);
  assert.equal(bag.records().some(row => row.record === "evidence"), true);
});

test("request preparation does not manufacture actual adoption or outcome", () => {
  const bag = harness();

  bag.start("prior");
  bag.runtime.finishTurn();
  bag.start("current", TASK);
  assert.notEqual(bag.runtime.policyFor(0), undefined);
  bag.runtime.capture({ kind: "terminal", eventId: "done", sessionId: "s-1", turnId: "current", payload: { reason: "completed" } });
  bag.runtime.finishTurn();
  assert.equal(bag.records().some(row => row.record === "policy" && row.adopted), false);
  assert.equal(bag.records().some(row => row.record === "observation"), false);
});

test("the real send callback reaches the User owner and method keeps its own receipt set", async () => {
  const notices: unknown[] = [];
  const user = { capture: () => undefined, policyFor: () => undefined, finishTurn: () => undefined,
    recordFielding: (notice: unknown) => { notices.push(notice); } };
  const composed = composeLearningPorts({ method: undefined, user });
  await composed?.recordFielding({ turnId: "t1", beat: 1, attemptId: "a1", receipts: [] });
  assert.equal(notices.length, 1);
});

test("formal policy stays on the completed version frozen at turn_start", () => {
  const initial = version();
  const bag = harness({}, { mode: "learned", seed: [{ record: "learning_version", version: initial }] });

  bag.start("current", TASK);
  const first = bag.runtime.policyFor(0, { turnId: "current", beat: 1 });

  assert.equal(first?.receipt?.versionId, initial.versionId);
  const replacement = version("user-version:2");

  bag.ledger.append([{ record: "learning_version", version: replacement }]);
  assert.equal(bag.runtime.policyFor(0, { turnId: "current", beat: 2 })?.receipt?.versionId, initial.versionId);
  bag.runtime.finishTurn();
  bag.start("next", TASK);
  assert.equal(bag.runtime.policyFor(0, { turnId: "next", beat: 1 })?.receipt?.versionId, replacement.versionId);
});

test("formal policy cannot silently fall back to a same-turn legacy derivation", () => {
  const bag = harness({}, { mode: "learned" });
  bag.start("current", PREF);
  assert.equal(bag.runtime.policyFor(0), undefined);
  assert.equal(bag.records().some(item => item.record === "evidence"), true);
});

test("an emptied source is read by the next turn while the active turn keeps its original frozen policy", () => {
  const initial = version();
  let records: readonly UserLearningRecord[] = [{ record: "learning_version", version: initial }];
  const ledger: LedgerPort = { read: () => ({ ok: true, records, unreadable: 0 }),

    append: added => {
      records = [...records, ...added];
      return { ok: true, appended: added.length };
    } };
  const bag = harness({ ledger }, { mode: "learned" });
  bag.start("active", TASK);
  assert.equal(bag.runtime.policyFor(0)?.receipt?.versionId, initial.versionId);
  records = []; // An isolated in-memory source reset; no real profile is deleted.
  assert.equal(bag.runtime.policyFor(0)?.receipt?.versionId, initial.versionId);
  bag.runtime.finishTurn();
  bag.start("next", TASK);
  assert.equal(bag.runtime.policyFor(0), undefined);
});

test("actual fielding binds only prepared rules and the precise turn and beat", () => {
  const policy = version();
  const bag = harness({}, { mode: "learned", seed: [{ record: "learning_version", version: policy }] });

  bag.start("current", TASK);
  const selected = bag.runtime.policyFor(0, { turnId: "current", beat: 1 });

  assert.notEqual(selected?.receipt, undefined);

  if (selected?.receipt === undefined) return;

  const notice = { turnId: "current", attemptId: "attempt:1", beat: 1, receipts: [selected.receipt] };

  bag.runtime.recordFielding?.({ ...notice, beat: 2 });
  bag.runtime.recordFielding?.({ ...notice, turnId: "other" });
  assert.equal(bag.records().some(item => item.record === "policy_fielding"), false);
  bag.runtime.recordFielding?.(notice);
  bag.runtime.recordFielding?.(notice);
  const fieldings = bag.records().filter(item => item.record === "policy_fielding");

  assert.equal(fieldings.length, 1);
  assert.deepEqual(fieldings[0]?.fielding.ruleIds, policy.policies.map(item => item.rule.id));
  bag.runtime.capture({ kind: "terminal", eventId: "done", sessionId: "s-1", turnId: "current", payload: { reason: "completed" } });
  bag.runtime.finishTurn();
  assert.equal(bag.records().some(item => item.record === "policy_feedback" || item.record === "observation"), false);
});

test("late human feedback binds the previous actual exposure even without policy money", () => {
  const policy = version();
  const bag = harness({}, { mode: "learned", seed: [{ record: "learning_version", version: policy }] });

  bag.start("previous", TASK);
  const prepared = bag.runtime.policyFor(0, { turnId: "previous", beat: 1 });

  assert.notEqual(prepared?.receipt, undefined);

  if (prepared?.receipt === undefined) return;

  bag.runtime.recordFielding?.({ turnId: "previous", attemptId: "attempt:old", beat: 1, receipts: [prepared.receipt] });
  bag.runtime.finishTurn();
  const next = harness({ budget: { allowance: () => ({ available: false, totalChars: 0 }) } }, { mode: "learned", seed: bag.records() });

  next.start("follow-up", "这样更好，保持这样");
  assert.equal(next.runtime.policyFor(0), undefined);
  next.runtime.finishTurn();
  const feedback = next.records().find(item => item.record === "policy_feedback");

  assert.notEqual(feedback, undefined);

  if (feedback?.record !== "policy_feedback") return;

  assert.equal(feedback.feedback.versionId, policy.versionId);
  assert.equal(feedback.feedback.signal, "explicit_helpful");
  assert.deepEqual(feedback.feedback.ruleIds, policy.policies.map(item => item.rule.id));
});

test("composition isolates User receipts and ignores model self-report for User", async () => {
  const policy = version();
  const bag = harness({}, { mode: "learned", seed: [{ record: "learning_version", version: policy }] });
  const methodReceipt = { ref: "method:1", versionId: "method-version:1", proposalId: "method-proposal:1", nicheId: "method-niche:1" };
  const methodFielding: unknown[] = [], methodFeedback: unknown[] = [];
  const composed = composeLearningPorts({ user: bag.runtime, method: { observe: async () => undefined, intentOn: () => false,
    requestSlot: async () => ({ message: { role: "system", content: "method" }, receipts: [methodReceipt] }),
    recordFielding: async notice => { methodFielding.push(notice.receipts); },
    recordFeedback: async notice => { methodFeedback.push(notice.items); }, endTurn: async () => undefined } });

  bag.start("current", TASK);
  const slot = await composed?.requestSlot({ turnId: "current", beat: 1, toolNames: [] });

  assert.equal(slot?.receipts.length, 2);
  await composed?.recordFielding({ turnId: "current", attemptId: "attempt:1", beat: 1, receipts: slot?.receipts ?? [] });
  await composed?.recordFeedback({ turnId: "current", attemptId: "attempt:1", beat: 1,
    items: [{ versionId: policy.versionId, helped: true }, { versionId: methodReceipt.versionId, helped: true }] });
  assert.deepEqual(methodFielding, [[methodReceipt]]);
  assert.deepEqual(methodFeedback, [[{ versionId: methodReceipt.versionId, helped: true }]]);
  assert.equal(bag.records().filter(item => item.record === "policy_fielding").length, 1);
  assert.equal(bag.records().some(item => item.record === "policy_feedback"), false);
});

test("the real loop fields User-only policy only after stream_start", async () => {
  for (const started of [false, true]) {
    const policy = version();
    const bag = harness({}, { mode: "learned", seed: [{ record: "learning_version", version: policy }] });
    const method = composeLearningPorts({ method: undefined, user: bag.runtime });

    assert.notEqual(method, undefined);
    const events: ProviderEvent[] = [
      ...started ? [{ type: "stream_start" as const, providerId: "fake", model: "fake", warnings: [] }] : [],
      { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
    ];
    const result = await runTurn({ provider: createFakeProvider([events]), tools: createFakeTools([]),
      permission: createFakePermission("approved"), profile: emptyProfileLoader(), ...(method === undefined ? {} : { method }) },
    { sessionId: "s-1", turnId: "current", correlationId: "c-1", text: TASK, onEnvelope: userLearningObserver(bag.runtime) });

    assert.equal(bag.records().filter(item => item.record === "policy_fielding").length, started ? 1 : 0);
    assert.equal(bag.records().some(item => item.record === "policy_feedback" || item.record === "observation"), false);
    assert.equal(JSON.stringify(result.envelopes).includes(policy.versionId), false, "private policy identities stay out of the public journal");
  }
});

test("feedback covers the fielded subset instead of every policy rule", () => {
  const initial = version(), first = initial.policies[0];

  assert.notEqual(first, undefined);
  if (first === undefined) return;

  const policy: UserLearningVersion = { ...initial, policies: [first,
    { ...first, rule: { ...first.rule, id: "rule:unselected", sourceCommitmentIds: ["commitment:unselected"] }, includeTerms: ["源代码"] }] };
  const bag = harness({}, { mode: "learned", seed: [{ record: "learning_version", version: policy }] });

  bag.start("current", TASK);
  const prepared = bag.runtime.policyFor(0, { turnId: "current", beat: 1 });

  assert.notEqual(prepared?.receipt, undefined);
  if (prepared?.receipt === undefined) return;

  bag.runtime.recordFielding?.({ turnId: "current", attemptId: "attempt:1", beat: 1, receipts: [prepared.receipt] });
  bag.runtime.capture({ kind: "user_correction", eventId: "human:correction", sessionId: "s-1", turnId: "current", payload: { text: "不对，别再这样" } });
  bag.runtime.finishTurn();
  const feedback = bag.records().find(item => item.record === "policy_feedback");

  assert.notEqual(feedback, undefined);
  if (feedback?.record !== "policy_feedback") return;

  assert.deepEqual(feedback.feedback.ruleIds, [first.rule.id]);
});
