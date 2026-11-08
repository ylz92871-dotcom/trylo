import assert from "node:assert/strict";
import test from "node:test";
import { USER_POLICY_HEADER } from "../../learning/domains/user/prepare.js";
import {
  createCeilingBudgetPort,
  createFlagCollectionPort,
  createLocalWorkOrderPort,
  createMemoryLedgerPort,
  type StrongSignalKind,
  type UserLearningPorts,
  type UserLearningRecord,
} from "../../learning/domains/user/scheduler-ports.js";
import { createFakePermission, createFakeProvider, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import { userLearningObserver } from "./observer.js";
import { composeLearningPorts } from "./port.js";
import { createUserLearningRuntime, type UserLearningRuntime } from "./runtime.js";

/**
 * 深链通电之后的样子：一轮里政策真的进了请求，执行里的强信号真的成了证据（UE-2/UE-3）。
 *
 * 这份用例刻意分成两半，因为两半的**证据强度不一样**：
 *
 *  - 前半跑的是运行时本身（端口进、账本出），断言的落点是「哪条记录、带什么身份」。
 *  - 后半跑的是**真的 `runTurn`**，用假的 provider 与假的工具，断言的落点是
 *    「那一段文本真的在 `ProviderRequest.messages` 里」以及「它不在 journal 里」。
 *    两者都不是在测某个函数返回了什么，而是在测一整条链。
 *
 * 有一件事这一份**证明不了**，写在前面：注入是 shadow 的（D2）——它只让模型多读到
 * 一段话，没有任何一处因为它而改变权限、审批或工具表。这件事由 `port.ts` 的形状和
 * `surface/cli` 那一侧的门保证，不是这里几条断言能证明的。
 */

const PREF = "以后周报都先说结论，再展开依据";
const TASK = "帮我写这周的周报，先说结论";
/** 与上面那条偏好不同维度：命中判定要求维度相等，所以这条任务必须什么都不命中。 */
const OFF_TASK = "帮我看看这个 bug 出在哪";
const CEILING = 1200;

type Harness = {
  readonly runtime: UserLearningRuntime;
  readonly ledger: ReturnType<typeof createMemoryLedgerPort>;
  readonly warnings: string[];
};

function harness(overrides: Partial<UserLearningPorts> = {}): Harness {
  const ledger = createMemoryLedgerPort();
  const warnings: string[] = [];

  return {
    ledger,
    warnings,
    runtime: createUserLearningRuntime({
    policyMode: "legacy",
      ports: {
        collection: createFlagCollectionPort(true),
        budget: createCeilingBudgetPort(CEILING),
        workOrder: createLocalWorkOrderPort(true, CEILING),
        ledger,
        ...overrides,
      },
      userId: "local-user",
      workspaceId: "ws-1",
      now: () => 1_700_000_000_000,
      warn: (message) => warnings.push(message),
    }),
  };
}

function event(
  kind: string,
  payload: Readonly<Record<string, unknown>> = {},
  ids: { readonly turnId?: string; readonly sessionId?: string; readonly eventId?: string } = {},
): Parameters<UserLearningRuntime["capture"]>[0] {
  return {
    kind,
    eventId: ids.eventId ?? "evt-1",
    ...(ids.sessionId === undefined ? { sessionId: "s-1" } : { sessionId: ids.sessionId }),
    ...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
    payload,
  };
}

function records(ledger: ReturnType<typeof createMemoryLedgerPort>): ReadonlyArray<UserLearningRecord> {
  const read = ledger.read();
  assert.equal(read.ok, true);
  return read.ok ? read.records : [];
}

function kinds(ledger: ReturnType<typeof createMemoryLedgerPort>): ReadonlyArray<string> {
  return records(ledger).map((record) => record.record);
}

test("a strong signal lands as evidence carrying the run's own identity", () => {
  const { runtime, ledger } = harness();

  runtime.capture(event("turn_start", { turnId: "t-1", text: PREF }, { turnId: "t-1" }));

  const landed = records(ledger);
  const evidence = landed.find((record) => record.record === "evidence");

  assert.notEqual(evidence, undefined, "the user's own sentence must land as evidence");

  if (evidence?.record !== "evidence") {
    return;
  }

  assert.equal(evidence.evidence.rawText, PREF, "raw text is kept verbatim");
  assert.deepEqual(evidence.evidence.source, { sessionId: "s-1", turnId: "t-1", workspaceId: "ws-1" });
  assert.equal(evidence.evidence.eventKind, "explicit_statement");
  // The two fields that decide how long this preference may live. Without them a
  // "from now on" preference is graded as a one-off task requirement, and the
  // deep chain never grows a conclusion (this wiring's first draft did exactly
  // that; see the runtime's own note on `classifyUserSignal`).
  assert.equal(evidence.evidence.durability, "long_term_candidate");
  assert.equal(evidence.evidence.signalKind, "collaboration_preference");
  assert.equal(evidence.evidence.answers.contextInformedness, "pre_task");

  const signal = landed.find((record) => record.record === "signal");

  assert.notEqual(signal, undefined);

  if (signal?.record === "signal") {
    assert.equal(signal.signal, "steer");
    assert.equal(signal.eventId, "evt-1", "the coordinate is the journal's, not one we invented");
    assert.equal(signal.sessionId, "s-1");
    assert.equal(signal.turnId, "t-1");
  }
});

test("the mapping is over the protocol's own vocabulary, not over guesses", () => {
  const cases: ReadonlyArray<{
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly signal: StrongSignalKind;
  }> = [
    { kind: "turn_start", payload: { turnId: "t-1", text: PREF }, signal: "steer" },
    { kind: "user_correction", payload: { text: "不对，改成先说结论" }, signal: "correction" },
    { kind: "user_cancel", payload: { phase: "streaming" }, signal: "interrupt" },
    { kind: "permission_denied", payload: { toolCallId: "c-1", resolution: "denied" }, signal: "reject" },
    { kind: "user_reject", payload: { toolCallId: "c-1" }, signal: "reject" },
    { kind: "file_write", payload: { toolCallId: "c-1", path: "a.md", bytes: 3 }, signal: "artifact" },
  ];
  for (const item of cases) {
    const { runtime, ledger } = harness();

    runtime.capture(event("turn_start", { turnId: "t-1", text: TASK }, { turnId: "t-1" }));
    runtime.capture(event(item.kind, item.payload, { turnId: "t-1" }));
    const signals = records(ledger)
      .filter((record) => record.record === "signal")
      .map((record) => (record.record === "signal" ? record.signal : ""));

    assert.equal(signals.includes(item.signal), true, `${item.kind} must land as ${item.signal}`);
  }
});

test("events outside the strong-signal set land nothing at all", () => {
  const { runtime, ledger } = harness();

  runtime.capture(event("turn_start", { turnId: "t-1", text: TASK }, { turnId: "t-1" }));
  const before = records(ledger).length;

  for (const kind of ["text", "thinking", "tool_use", "tool_result", "usage", "observation", "check_result", "compact"]) {
    runtime.capture(event(kind, { text: "x" }, { turnId: "t-1" }));
  }

  assert.equal(records(ledger).length, before, "a full trace is exactly what D5 refuses to keep");
});

test("an event with no session cannot become evidence, and leaves no false coordinate", () => {
  const { runtime, ledger } = harness();

  runtime.capture(event("turn_start", { turnId: "t-1", text: PREF }, { turnId: "t-1", sessionId: "s-1" }));
  assert.equal(kinds(ledger).includes("evidence"), true);

  // A second turn whose envelope carries no session: the signal still lands (it is a
  // fact about what happened), but no evidence is fabricated with an empty coordinate.
  const { runtime: bare, ledger: bareLedger } = harness();

  bare.capture({
    kind: "turn_start",
    eventId: "evt-9",
    turnId: "t-9",
    payload: { text: PREF },
  });
  assert.deepEqual(kinds(bareLedger), ["signal"]);
  const signal = records(bareLedger)[0];
  if (signal?.record === "signal") {
    assert.equal(signal.sessionId, undefined, "no session must mean no session, not an empty string");
  }
});

test("the same task always compiles to the same segment, and an unmatching one to none", async () => {
  const first = await segmentFor(TASK);
  const second = await segmentFor(TASK);

  assert.notEqual(first, undefined);
  assert.equal(first, second, "deterministic: the same ledger and the same task, the same bytes");

  const elsewhere = await segmentFor(OFF_TASK);

  assert.equal(elsewhere, undefined, "a task in another dimension is not a hit, and a miss injects nothing");
});

test("the header says out loud that nothing here is enforced", async () => {
  const segment = await segmentFor(TASK);

  assert.equal(segment?.startsWith(USER_POLICY_HEADER), true);
  assert.equal(segment?.includes("尚未用于执行"), true);
  assert.equal(segment?.includes("不改变任何权限"), true);

  // Contract #8: the corpus is a sentence about collaboration, never a grant.
  for (const word of ["允许", "授权", "批准", "权限提升", "免审批"]) {
    assert.equal(segment?.includes(word), false, `the segment must not claim ${word}`);
  }
});

test("the policy record carries identity, never the sentence", () => {
  const { runtime, ledger } = harness();

  runtime.capture(event("turn_start", { turnId: "t-1", text: PREF }, { turnId: "t-1" }));
  const prepared = runtime.policyFor(0, { turnId: "t-1", beat: 1 });

  assert.notEqual(prepared?.receipt, undefined);
  assert.equal(records(ledger).some(record => record.record === "policy"), false, "preparation has not sent anything");

  if (prepared?.receipt === undefined) return;

  const notice = { turnId: "t-1", beat: 1, attemptId: "attempt-1", receipts: [prepared.receipt] };

  runtime.recordFielding?.(notice);

  const policy = records(ledger).find((record) => record.record === "policy");

  assert.notEqual(policy, undefined, "the decision must land, and land only once");

  if (policy?.record !== "policy") {
    return;
  }

  assert.equal(policy.adopted, true);
  assert.equal(policy.matched, 1);
  assert.equal(policy.chars > 0, true);
  assert.equal(policy.ruleIds.length, 1);
  assert.equal(policy.bundleChecksum.length > 0, true);
  // D7: what lands is the *identity* of the decision. The instruction text is
  // not in this record — a reader of the ledger cannot get the sentence from it.
  const serialized = JSON.stringify(policy);

  assert.equal(serialized.includes("先说结论"), false);
  assert.equal(serialized.includes(USER_POLICY_HEADER), false);

  // Repeated preparation and duplicate notifications do not manufacture sends.
  runtime.policyFor(0);
  runtime.policyFor(0);
  runtime.recordFielding?.(notice);
  assert.equal(records(ledger).filter((record) => record.record === "policy").length, 1);
});

test("quality-defect wording never becomes a preference, so it never reaches a segment", async () => {
  // The eligibility gate routes a "this answer is bad" complaint away from the
  // personalization chain entirely: no conclusion, no model, no commitment, no
  // rule. There is no filter here that *excludes* it — the chain simply never
  // produces it, which is the stronger guarantee (see `prepare.ts`).
  const complaint = "这个回答太啰嗦了，质量不行";
  const { runtime, ledger } = harness();

  runtime.capture(event("turn_start", { turnId: "t-1", text: complaint }, { turnId: "t-1" }));
  const injected = runtime.policyFor(0);

  assert.equal(injected, undefined, "a quality complaint is not a collaboration preference");
  assert.equal(
    records(ledger).some((record) => record.record === "receipt"),
    false,
    "nothing was adopted, so nothing was receipted",
  );
});

test("task completion alone produces no policy-effect observation even after actual fielding", () => {
  const { runtime, ledger } = harness();

  runtime.capture(event("turn_start", { turnId: "t-1", text: PREF }, { turnId: "t-1" }));
  const prepared = runtime.policyFor(0, { turnId: "t-1", beat: 1 });

  assert.notEqual(prepared?.receipt, undefined);
  if (prepared?.receipt === undefined) return;

  runtime.recordFielding?.({ turnId: "t-1", beat: 1, attemptId: "attempt-1", receipts: [prepared.receipt] });
  runtime.capture(event("terminal", { reason: "completed" }, { turnId: "t-1" }));
  runtime.finishTurn();

  assert.equal(records(ledger).some(record => record.record === "policy_fielding"), true);
  assert.equal(records(ledger).some(record => record.record === "observation" || record.record === "policy_feedback"), false);
});

/**
 * 一个有两轮的账本：上一轮用户说了那句偏好（它落成证据），这一轮才是要注入的任务。
 *
 * 两轮是刻意的——「账里有证据，这一轮的任务命中它」正是深链要做的判断。如果偏好和
 * 任务共用一段文本，那么「命中」这件事就没有被问过：`taskText` 与证据文本永远相同。
 */
function seeded(): Harness {
  const bag = harness();
  bag.runtime.capture(event("turn_start", { turnId: "t-0", text: PREF }, { turnId: "t-0" }));
  bag.runtime.capture(event("terminal", { reason: "completed" }, { turnId: "t-0" }));
  bag.runtime.finishTurn();
  return bag;
}

async function segmentFor(taskText: string): Promise<string | undefined> {
  const { runtime } = seeded();
  runtime.capture(event("turn_start", { turnId: "t-1", text: taskText }, { turnId: "t-1" }));
  const composed = composeLearningPorts({ method: undefined, user: runtime });
  const slot = await composed?.requestSlot({ turnId: "t-1", beat: 0, toolNames: [] });
  return slot?.message.content;
}

/** 一拍：一段文本、一次 usage、一个收尾。没有工具，所以这一轮一拍就结算。 */
function textBeat(text: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "stream_start", providerId: "fake", model: "fake-model", warnings: [] },
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text },
    { type: "text_end", blockId: "b1" },
    { type: "usage", usage: emptyUsage("snapshot") },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
}

type Recording = { readonly port: ProviderPort; readonly requests: ProviderRequest[] };

function recordingProvider(): Recording {
  const inner = createFakeProvider([textBeat("done")]);
  const requests: ProviderRequest[] = [];

  return {
    requests,
    port: {
      stream(request, signal) {
        requests.push(request);
        return inner.stream(request, signal);
      },
    },
  };
}

test("through a real turn the segment is in the request and nowhere in the journal", async () => {
  const { runtime, ledger } = harness();
  const method = composeLearningPorts({ method: undefined, user: runtime });

  assert.notEqual(method, undefined);
  const provider = recordingProvider();

  const result = await runTurn(
    {
      provider: provider.port,
      tools: createFakeTools([]),
      permission: createFakePermission("approved"),
      profile: emptyProfileLoader(),
      ...(method === undefined ? {} : { method }),
    },
    {
      sessionId: "s-1",
      turnId: "t-1",
      correlationId: "c-1",
      text: PREF,
      onEnvelope: userLearningObserver(runtime),
    },
  );

  const first = provider.requests[0];

  assert.notEqual(first, undefined, "the turn must have sent a request");
  const injected = (first?.messages ?? []).filter((message) => message.content.includes(USER_POLICY_HEADER));

  assert.equal(injected.length, 1, "exactly one system segment, once per request");
  assert.equal(injected[0]?.role, "system");
  const segment = injected[0]?.content ?? "";

  // "先给结论" is the chain's compiled instruction — deliberately *not* the user's
  // own words ("先说结论"), which is exactly the point: what goes in is what the
  // deep chain wrote, not an echo of the input.
  assert.equal(segment.includes("先给结论"), true);

  // D7: the journal is the opposite direction, and it must carry no policy text.
  //
  // The user's own sentence *is* in the journal, and must be — that is the turn's
  // input, not the policy. What must never appear is the compiled segment: the
  // header, and the instruction the deep chain wrote out of that sentence. So the
  // assertion is against the segment's own bytes, not against the words the user
  // happened to say.
  const journal = JSON.stringify(result.envelopes);

  assert.equal(journal.includes(USER_POLICY_HEADER), false);
  assert.equal(journal.includes(segment), false, "the journal must not learn the policy segment");
  assert.equal(journal.includes("尚未用于执行"), false);
  assert.equal(journal.includes("先给结论"), false, "the compiled instruction is not a journal fact");

  // The provider accepted this request. Lifecycle completion supplies no human
  // opinion, so only the actual exposure and its selected commitment are receipted.
  assert.equal(kinds(ledger).includes("receipt"), true);
  assert.equal(kinds(ledger).includes("policy_fielding"), true);
  assert.equal(kinds(ledger).includes("observation"), false);
});

test("with the user half absent the composed port is the method half itself, or nothing", async () => {
  const methodOnly = {
    observe: async () => undefined,
    intentOn: () => false,
    requestSlot: async () => ({
      message: { role: "system" as const, content: "learned card" },
      receipts: [],
    }),
    recordFielding: async () => undefined,
    recordFeedback: async () => undefined,
    endTurn: async () => undefined,
  };

  // Identity, not equality: with no user half the very same object comes back, so
  // `--learning=method` cannot differ from the method subsystem running alone.
  assert.equal(composeLearningPorts({ method: methodOnly, user: undefined }), methodOnly);
  assert.equal(composeLearningPorts({ method: undefined, user: undefined }), undefined);
});

test("the shared ceiling is respected against a method slot that grows between beats", async () => {
  const { runtime } = harness();
  const learned = (beat: number): string => "x".repeat(beat * 700);
  const composed = composeLearningPorts({
    method: {
      observe: async () => undefined,
      intentOn: () => false,
      requestSlot: async (request) => ({
        message: { role: "system", content: learned(request.beat) },
        receipts: [],
      }),
      recordFielding: async () => undefined,
      recordFeedback: async () => undefined,
      endTurn: async () => undefined,
    },
    user: runtime,
  });

  assert.notEqual(composed, undefined);

  if (composed === undefined) {
    return;
  }

  runtime.capture(event("turn_start", { turnId: "t-1", text: PREF }, { turnId: "t-1" }));

  // The method slot grows 0 -> 700 -> 1400 against a 1200-char ceiling. What is
  // being asserted is that the *user's* addition always fits in what is left at
  // that beat — a segment computed once on beat 0 (when 1200 chars were free)
  // would be 1200 chars long and blow the top on beat 2.
  for (const beat of [0, 1, 2]) {
    const base = learned(beat);
    // Annotated: the composed port's own shape is what answers here, and spelling
    // the slot type out keeps the annotation from being re-derived per beat.
    const slot = await composed.requestSlot({ turnId: "t-1", beat, toolNames: [] });
    const content: string = slot?.message.content ?? "";

    assert.equal(content.startsWith(base), true, `beat ${beat}: the method's own text is untouched`);
    const added = content.length - base.length;

    if (base.length >= CEILING) {
      assert.equal(added, 0, `beat ${beat}: a method slot already filling the ceiling leaves no room`);
    } else {
      assert.equal(
        added <= CEILING - base.length,
        true,
        `beat ${beat} added ${added} chars with only ${CEILING - base.length} left`,
      );
    }
  }
});
