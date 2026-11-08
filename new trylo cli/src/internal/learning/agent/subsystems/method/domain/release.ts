import { shortId } from "../../../../domains/shared/hash.js";
import {
  DEFAULT_METHOD_GRANT,
  sameArguments,
  tripleKey,
  type MethodGrant,
  type MethodRelease,
  type ObservedFact,
  type ReleaseReason,
  type SubsystemGrant,
} from "./contracts.js";

/**
 * 释放判定：一拍执行事实进，一个决策出。纯函数，花费 0。
 *
 * 这是 M1 `learning/scheduler/**` 的换代。**判定结构保留**（一拍事实 → 一个
 * 决策，纯函数，不碰 provider），**语义改写**：M1 的决策是「发不发一张 intra
 * 工单」，工单里带着相机映射出来的课题；M2 的决策是「这一拍允不允许带学习
 * 意图」，课题不在里面。
 *
 * 三个数仍然写在表里而不是 `if` 里，理由与 M1 相同：它们是可以被读、被争、
 * 被单独测试的**政策**，改政策应该是一处一行的编辑。
 *
 *  - `requiredOccurrences: 2` — 第一次失败只记账，从不学。一个数据点是噪声。
 *  - `beatsToWaitAfterFirstFailure: 1` — 中间要隔**一整拍**（一次请求加它结算
 *    的一切）。一拍内两次相同的调用是一拍的证据，不是两次。
 *  - `resetOnSuccess` / `resetScope: "same_tool"` — 同一个工具成功会清掉它的
 *    计数；别的工具成功不会。任何进展都清空，会让一次忙 turn 里的重复失败
 *    永远确认不了。
 *  - `maxReleasesPerTurn: 1` — 一个 turn 只放权一次，硬顶。
 *
 * 与 M1 的差别只有一处是结构性的：M1 的 `callsPerTicket` 没了。共枪之后没有
 * 第二枪可打，所以「一张工单几次调用」这个数不再存在。
 */

export type ReleasePolicy = {
  readonly requiredOccurrences: number;
  readonly beatsToWaitAfterFirstFailure: number;
  readonly resetOnSuccess: boolean;
  readonly resetScope: "same_tool";
  readonly maxReleasesPerTurn: number;
};

export const RELEASE_POLICY: ReleasePolicy = Object.freeze({
  requiredOccurrences: 2,
  beatsToWaitAfterFirstFailure: 1,
  resetOnSuccess: true,
  resetScope: "same_tool",
  maxReleasesPerTurn: 1,
});

/**
 * 遏制类失败码，**按值抄来**。
 *
 * 权威定义在 `src/internal/adapters/tools/shared/workspace.ts`（`PathDenyCode`）。
 * 学习层不得 import adapters（`io-boundary.test.ts`），所以这里是一份按值副本；
 * 副本与原件的相等性由 `release.test.ts` 直接读那个文件、要求集合相等来兜住。
 * 这正是 `constraints.test.ts` 对 M1 做过的事，M2 只是换了文件名。
 */
export const CONTAINMENT_FAILURE_CODES: ReadonlyArray<string> = [
  "invalid_path",
  "path_outside_workspace",
  "path_escapes_via_link",
  "path_unverifiable",
  "parent_missing",
];

const CONTAINMENT_CODE_SET: ReadonlySet<string> = new Set(CONTAINMENT_FAILURE_CODES);

/** 一条三元组的释放计数。 */
export type TripleRecord = {
  readonly fact: ObservedFact;
  readonly firstBeat: number;
  readonly lastBeat: number;
  /** 观察到它的**不同拍数**；一拍最多算一次。 */
  readonly occurrences: number;
  /** 截至 `lastBeat` 的释放理由；没有理由就是「撞了但不值得放权」。 */
  readonly reason: ReleaseReason | undefined;
  /** 这条三元组在本 turn 已经放过权了。 */
  readonly released: boolean;
};

/**
 * 一个 turn 的放权账。
 *
 * 只有两个东西：本 turn 已放权几次、各三元组的释放计数。M1 的「本 turn 一张
 * 卡」不在了——卡不再活在 turn 里，它过门即入档；这个账只回答「这一拍能不能
 * 带学习意图」，不回答「带哪张卡」。
 */
export type ReleaseLedger = {
  readonly turnId: string;
  /** 最近折进来的拍；第一次上报前为 0。 */
  readonly lastBeat: number;
  readonly records: Readonly<Record<string, TripleRecord>>;
  readonly releases: number;
};

export type BeatFacts = {
  readonly turnId: string;
  /** 1-based 迭代序号：一次 provider 请求加它结算的一切。 */
  readonly beat: number;
  readonly failures: ReadonlyArray<ObservedFact>;
  readonly succeededTools: ReadonlyArray<string>;
};

export type ReleaseDecision =
  | {
      readonly kind: "idle";
      readonly reason: "collection_disabled" | "no_budget" | "no_failure" | "wrong_turn";
    }
  | { readonly kind: "release"; readonly release: MethodRelease }
  | { readonly kind: "hold"; readonly reason: "not_repeated"; readonly tool: string }
  | { readonly kind: "hold"; readonly reason: "need_another_attempt"; readonly tool: string };

export type ReleaseTick = {
  readonly ledger: ReleaseLedger;
  readonly decision: ReleaseDecision;
};

export function createReleaseLedger(turnId: string): ReleaseLedger {
  return { turnId, lastBeat: 0, records: {}, releases: 0 };
}

/**
 * 顶板给的是 `idle` 时，子系统的回答。
 *
 * `nothing_to_do` 被读成 `no_failure`：两者在外面的含义相同——这一拍没有值得
 * 学的东西。多留一个同义的理由码只会让日志里出现两种说法描述同一个事实。
 */
export function idleDecisionFor(grant: SubsystemGrant): ReleaseDecision {
  if (grant.kind !== "idle") {
    return { kind: "idle", reason: "no_failure" };
  }
  return {
    kind: "idle",
    reason: grant.reason === "nothing_to_do" ? "no_failure" : grant.reason,
  };
}

/**
 * 一拍事实 → 一个放权决策。
 *
 * 另一 turn 的上报不是这个账的事，也不会被折进来：那是卡跨 turn 泄漏的入口。
 */
export function releaseFor(
  ledger: ReleaseLedger,
  facts: BeatFacts,
  grant: MethodGrant = DEFAULT_METHOD_GRANT,
  policy: ReleasePolicy = RELEASE_POLICY,
): ReleaseTick {
  if (facts.turnId !== ledger.turnId) {
    return { ledger, decision: { kind: "idle", reason: "wrong_turn" } };
  }
  const recorded = recordFacts(ledger, facts, policy);
  return { ledger: recorded, decision: decide(recorded, facts, grant, policy) };
}

function decide(
  ledger: ReleaseLedger,
  facts: BeatFacts,
  grant: MethodGrant,
  policy: ReleasePolicy,
): ReleaseDecision {
  const head = facts.failures[0];
  if (head === undefined) {
    return { kind: "idle", reason: "no_failure" };
  }

  const candidates = candidatesFor(ledger, facts.failures);
  const first = candidates[0];
  if (first === undefined) {
    return { kind: "hold", reason: "not_repeated", tool: head.tool };
  }

  const ready = candidates.find((record) => isReady(record, policy));
  if (ready === undefined) {
    return { kind: "hold", reason: "need_another_attempt", tool: first.fact.tool };
  }

  const allowance = Math.min(grant.releases, policy.maxReleasesPerTurn);
  if (ledger.releases >= allowance) {
    // 额度用完不是「拒绝」而是「这一拍不带意图」：本 turn 已经放过一次权了。
    return { kind: "idle", reason: "no_budget" };
  }

  return { kind: "release", release: makeRelease(recorded(ledger, ready), facts, grant) };
}

/**
 * 这一拍**有理由**的失败，去重后按首次出现序。
 *
 * 候选 = 撞到释放理由的三元组。同拍内两次相同的调用是两个相同的三元组，去重
 * 后算一次，与账里的计数一致；已经放过权的三元组不再进候选，所以一个 turn
 * 里同一件事不可能被放两次权。
 */
function candidatesFor(
  ledger: ReleaseLedger,
  failures: ReadonlyArray<ObservedFact>,
): ReadonlyArray<TripleRecord> {
  const seen = new Set<string>();
  const candidates: TripleRecord[] = [];

  for (const fact of failures) {
    const key = tripleKey(fact);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const record = ledger.records[key];
    if (record !== undefined && record.reason !== undefined && !record.released) {
      candidates.push(record);
    }
  }

  return candidates;
}

function recorded(ledger: ReleaseLedger, record: TripleRecord): TripleRecord {
  return ledger.records[tripleKey(record.fact)] ?? record;
}

function isReady(record: TripleRecord, policy: ReleasePolicy): boolean {
  return (
    record.occurrences >= policy.requiredOccurrences &&
    record.lastBeat - record.firstBeat >= policy.beatsToWaitAfterFirstFailure
  );
}

function makeRelease(record: TripleRecord, facts: BeatFacts, grant: MethodGrant): MethodRelease {
  return {
    releaseId: shortId("release", [facts.turnId, String(facts.beat), tripleKey(record.fact)]),
    turnId: facts.turnId,
    beat: facts.beat,
    // 候选的定义里已经有理由，这里只是把它取出来，不再兜一次默认值。
    reason: record.reason ?? "repeat_call",
    tool: record.fact.tool,
    code: record.fact.code,
    fingerprint: record.fact.fingerprint,
    repeats: record.occurrences,
    model: grant.model,
    slotChars: grant.slotChars,
    slotCards: grant.slotCards,
  };
}

function recordFacts(
  ledger: ReleaseLedger,
  facts: BeatFacts,
  policy: ReleasePolicy,
): ReleaseLedger {
  const cleared = policy.resetOnSuccess
    ? clearForSuccesses(ledger.records, facts.succeededTools)
    : ledger.records;
  return { ...ledger, lastBeat: facts.beat, records: countFailures(cleared, facts) };
}

function clearForSuccesses(
  records: Readonly<Record<string, TripleRecord>>,
  succeededTools: ReadonlyArray<string>,
): Readonly<Record<string, TripleRecord>> {
  if (succeededTools.length === 0) {
    return records;
  }

  const succeeded = new Set(succeededTools);
  const kept: Record<string, TripleRecord> = {};

  for (const [key, record] of Object.entries(records)) {
    if (!succeeded.has(record.fact.tool)) {
      kept[key] = record;
    }
  }

  return kept;
}

/**
 * 计数是「每拍每三元组一次」。
 *
 * 理由读的是**这一拍之前**的历史，不含正在折的这一拍：一拍内的两次相同调用
 * 是一拍的证据，而 `repeat_call` 要回答的正是「执行又完整试了一次之后，还是
 * 老样子吗」。
 */
function countFailures(
  records: Readonly<Record<string, TripleRecord>>,
  facts: BeatFacts,
): Readonly<Record<string, TripleRecord>> {
  const next: Record<string, TripleRecord> = { ...records };
  const handled = new Set<string>();
  const prior = Object.values(records).map((record) => record.fact);

  for (const fact of facts.failures) {
    const key = tripleKey(fact);
    if (handled.has(key)) {
      continue;
    }

    handled.add(key);
    const existing = records[key];

    next[key] =
      existing === undefined
        ? {
            fact,
            firstBeat: facts.beat,
            lastBeat: facts.beat,
            occurrences: 1,
            reason: reasonFor(fact, prior),
            released: false,
          }
        : {
            ...existing,
            lastBeat: facts.beat,
            occurrences: existing.occurrences + 1,
            reason: existing.reason ?? reasonFor(fact, prior),
          };
  }

  return next;
}

/**
 * 一次失败撞到的释放理由。
 *
 * 先看遏制：遏制失败是更具体的诊断，它回答「越界了」；`repeat_call` 回答的是
 * 「同样的调用又试了一次」，两者都成立时前者更值得放权。
 *
 * `prior` 是**更早的拍**已经记下的事实，绝不包含正在折的这一拍。
 */
export function reasonFor(
  fact: ObservedFact,
  prior: ReadonlyArray<ObservedFact>,
): ReleaseReason | undefined {
  if (CONTAINMENT_CODE_SET.has(fact.code)) {
    return "containment";
  }
  return prior.some((seen) => sameArguments(seen, fact)) ? "repeat_call" : undefined;
}

/**
 * 把一次放权记进账。
 *
 * `releases` 加一，被放权的三元组标 `released`。账里不存卡、不存课题、不存
 * 张数：这三样都不是这个账的事。
 */
export function withRelease(ledger: ReleaseLedger, release: MethodRelease): ReleaseLedger {
  const key = tripleKey(release);
  const record = ledger.records[key];

  return {
    ...ledger,
    releases: ledger.releases + 1,
    records:
      record === undefined
        ? ledger.records
        : { ...ledger.records, [key]: { ...record, released: true } },
  };
}
