import assert from "node:assert/strict";
import test from "node:test";
import {
  createCeilingBudgetPort,
  createFlagCollectionPort,
  createLocalWorkOrderPort,
  createMemoryLedgerPort,
  type BudgetPort,
  type CollectionPort,
  type LedgerPort,
  type UserLearningPorts,
  type WorkOrderPort,
} from "../../learning/domains/user/scheduler-ports.js";
import { createUserLearningRuntime } from "./runtime.js";

/**
 * 总控制板的 seam 是一条真接口，不是一段将来要重写的占位（UE-1 / D1 / §7-#5）。
 *
 * 这一份用例问的不是「默认实现对不对」（那是 `scheduler-ports.ts` 自己的事），而是
 * **接口接得上接不上**：collection 拒绝时整轮不采集、不读账；预算或工单拒绝时
 * 政策不上场，但保留已授权的人类证据。它们是独立的否决边界。
 *
 * 判据是三条**可观察**的事实，不是函数返回值：
 *
 *  - `policyFor` 给出 `undefined`（没注入）；
 *  - 只有 collection 关时账本里一行都没有；预算拒绝仍留下 evidence/signal，没有上场收据；
 *  - collection 关时 `read()` 一次都没被调用。关掉采集时连一次读都不该发生，
 *    而这件事在返回值里看不出来，只能在一个会计数的 stub 上看出来。
 */

const CEILING = 1200;
const PREF = "以后周报都先说结论，再展开依据";
const TASK = "帮我写这周的周报，先说结论";

/** 默认四端口：全开、按硬顶、本地账。每个用例只顶掉它要顶的那一个。 */
function ports(overrides: Partial<UserLearningPorts> = {}): UserLearningPorts {
  return {
    collection: createFlagCollectionPort(true),
    budget: createCeilingBudgetPort(CEILING),
    workOrder: createLocalWorkOrderPort(true, CEILING),
    ledger: createMemoryLedgerPort(),
    ...overrides,
  };
}

/** 一个会计数的账本：`read` 被问过几次，是这一份用例里唯一能看出「没读」的地方。 */
function countingLedger(inner: LedgerPort): { readonly port: LedgerPort; readonly reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    port: {
      read: () => {
        reads += 1;
        return inner.read();
      },

      append: (records) => inner.append(records),
    },
  };
}

function turnStart(turnId = "t1", text = PREF) {
  return { kind: "turn_start", eventId: `${turnId}:start`, sessionId: "s-1", turnId, payload: { text } };
}

function recordsIn(ledger: LedgerPort): ReadonlyArray<string> {
  const read = ledger.read();
  return read.ok ? read.records.map((record) => record.record) : [];
}

test("a collection port that says no stops the whole turn before a single read", () => {
  const kept = createMemoryLedgerPort();
  const counted = countingLedger(kept);
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({ collection: createFlagCollectionPort(false), ledger: counted.port }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: () => undefined,
  });

  runtime.capture(turnStart());
  assert.equal(runtime.policyFor(0), undefined, "no injection when collection is off");
  runtime.finishTurn();

  assert.deepEqual(recordsIn(kept), [], "not one record may land while collection is off");
  assert.equal(counted.reads(), 0, "and the ledger must not be read even once");
});

test("a spent policy budget prevents injection and retains collection", () => {
  const kept = createMemoryLedgerPort();
  const counted = countingLedger(kept);
  const spent: BudgetPort = { allowance: () => ({ available: false, totalChars: 0 }) };
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({ budget: spent, ledger: counted.port }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: () => undefined,
  });

  runtime.capture(turnStart());
  assert.equal(runtime.policyFor(0), undefined);
  runtime.finishTurn();

  assert.deepEqual(recordsIn(kept), ["evidence", "signal"]);
  assert.equal(counted.reads(), 1, "the allowed source is frozen once independently of policy funding");
});

test("a missing policy work order prevents injection and retains collection", () => {
  const kept = createMemoryLedgerPort();
  const counted = countingLedger(kept);
  const silent: WorkOrderPort = { grant: () => undefined };
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({ workOrder: silent, ledger: counted.port }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: () => undefined,
  });

  runtime.capture(turnStart());
  assert.equal(runtime.policyFor(0), undefined);
  runtime.finishTurn();

  assert.deepEqual(recordsIn(kept), ["evidence", "signal"]);
  assert.equal(counted.reads(), 1);
});

test("a work order with no allowance left is a zero-char grant, and zero is not an error", () => {
  const kept = createMemoryLedgerPort();
  const counted = countingLedger(kept);
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({
      workOrder: createLocalWorkOrderPort(true, 0),
      ledger: counted.port,
    }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: () => undefined,
  });

  runtime.capture(turnStart("t1", TASK));
  assert.equal(runtime.policyFor(0), undefined, "a zero grant is an empty slot, not a failure");
  assert.equal(counted.reads(), 1, "zero injection allowance does not erase allowed source collection");
  assert.deepEqual(recordsIn(kept), ["evidence", "signal"]);
});

test("the ceiling is the hard top, and the method slot's spend is subtracted from it", () => {
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports(),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: () => undefined,
  });

  runtime.capture(turnStart("t1", PREF));

  // The policy is compiled only once per turn; asking with the whole ceiling spent
  // must therefore answer `undefined` *before* anything is compiled — a cache that
  // remembered an earlier, larger answer is exactly how the shared top gets blown.
  const spent = runtime.policyFor(CEILING);

  assert.equal(spent, undefined, "a fully spent ceiling leaves no room for the user segment");

  const room = runtime.policyFor(CEILING - 200);

  assert.notEqual(room, undefined);
  assert.equal((room?.chars ?? 0) <= 200, true, "the segment must fit the room that was left");
});

test("a ledger that cannot be read fails closed and says so exactly once", () => {
  const warnings: string[] = [];
  const broken: LedgerPort = {
    read: () => ({ ok: false, reason: "ledger_read_failed" }),
    append: () => ({ ok: true, appended: 0 }),
  };
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({ ledger: broken }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: (message) => warnings.push(message),
  });

  runtime.capture(turnStart("t1", PREF));

  assert.equal(runtime.policyFor(0), undefined, "an unreadable ledger is not an empty ledger");
  assert.equal(runtime.policyFor(0), undefined);
  assert.deepEqual(warnings, ["user_learning_degraded:ledger_read_failed"], "one line, one time");
});

test("a ledger that cannot be written never fails the turn, and says so exactly once", () => {
  const warnings: string[] = [];
  const broken: LedgerPort = {
    read: () => ({ ok: true, records: [], unreadable: 0 }),
    append: () => ({ ok: false, reason: "ledger_write_failed" }),
  };
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({ ledger: broken }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: (message) => warnings.push(message),
  });

  // `capture` returns void and never throws: a ledger that cannot be written is a
  // degraded subsystem, not a failed user task.
  runtime.capture(turnStart("t1", PREF));
  runtime.capture({ kind: "terminal", eventId: "e2", sessionId: "s-1", turnId: "t1", payload: { reason: "completed" } });
  runtime.finishTurn();

  assert.deepEqual(warnings, ["user_learning_degraded:ledger_write_failed"]);
});

test("each default implementation answers its own one question, and nothing else", () => {
  const collection: CollectionPort = createFlagCollectionPort(true);

  assert.equal(collection.capture({ turnId: "t1" }), true);
  assert.equal(createFlagCollectionPort(false).capture({ turnId: "t1" }), false);

  const fresh = createCeilingBudgetPort(CEILING);

  assert.deepEqual(fresh.allowance(), { available: true, totalChars: CEILING });
  // "Spent" is a fact of the request, not of the port: the port only reports what is left.
  const drained = createCeilingBudgetPort(CEILING, () => CEILING + 5);

  assert.deepEqual(drained.allowance(), { available: false, totalChars: 0 }, "never negative");

  const order = createLocalWorkOrderPort(true, CEILING).grant({
    turnId: "t1",
    taskText: TASK,
    scopeFingerprint: "v2:x",
  });

  assert.deepEqual(order, { subsystem: "user", chars: CEILING });
  assert.equal(
    createLocalWorkOrderPort(false, CEILING).grant({ turnId: "t1", taskText: TASK, scopeFingerprint: "v2:x" }),
    undefined,
  );
});

test("an unreadable line in the ledger is a degradation, not a silent zero", () => {
  const warnings: string[] = [];
  // `read.unreadable` is the counter a file-backed ledger reports; the in-memory
  // default never produces one, so this case is driven through a stub on purpose.
  const runtime = createUserLearningRuntime({
    policyMode: "legacy",
    ports: ports({
      ledger: {
        read: () => ({ ok: true, records: [], unreadable: 3 }),
        append: () => ({ ok: true, appended: 0 }),
      },
    }),
    userId: "local-user",
    workspaceId: "ws-1",
    now: () => 0,
    warn: (message) => warnings.push(message),
  });

  runtime.capture(turnStart());
  assert.equal(runtime.policyFor(0), undefined);
  assert.deepEqual(warnings, ["user_learning_degraded:ledger_unreadable:3"]);
});
