import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { variantOf, withAccount, withVariant } from "../assets/archive.js";
import { createMethodBoard, type MethodBoard } from "./board.js";
import { isMethodPointer, type VariantRecord } from "../domain/contracts.js";
import type {
  AccountInput,
  ArchiveLoadResult,
  CommitCardInput,
  FeedbackInput,
  MethodArchivePort,
  MethodBeatReport,
  MethodEventPayload,
  MethodFeedbackNotice,
  MethodFieldingNotice,
  UseInput,
} from "../port.js";

/**
 * 板（合同 T6 / T8 / T14，以及「机会 ≠ 课题」的次序）。
 *
 * 板是四件事唯一相遇的地方，所以这里是**集成**用例：拍事实进去，出来的是「这
 * 一拍允不允许带学习意图」「档里多了什么」「下一拍的槽里有什么」。档用一个内存
 * 实现，因为它要回答的问题是「板命令了它做什么」，而不是「控制板怎么落盘」
 * ——后者是 `integration/method/board-writer.test.ts` 的事。
 *
 * 一个 turn 的完整学习循环是四拍，用例里反复出现，所以抽成 `learnCard`：
 *
 *   拍 1  第一次撞上遏制失败      → 只记账，不放权
 *   拍 2  同一三元组复现          → 放权（意图落在拍 3）
 *   拍 3  模型交出合规卡          → 过门即入档（不需要验收拍）
 *   拍 4  下一拍的事实            → 记账（支持 / 反例，或什么都不记）
 */

const FAILURE = { tool: "echo", code: "path_outside_workspace", fingerprint: "fp-1" };
const TOOLS: ReadonlyArray<string> = ["echo"];
const HINT = "keep the write inside the workspace root";

type Observed = { readonly kind: string; readonly payload: MethodEventPayload };

function proposalJson(hint: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hint,
    labels: ["containment"],
    appliesWhen: { tools: ["echo"] },
    ...extra,
  });
}

type MemoryArchive = {
  readonly port: MethodArchivePort;
  readonly commits: CommitCardInput[];
  readonly accounts: AccountInput[];
  readonly uses: UseInput[];
  readonly feedbacks: FeedbackInput[];
  readonly variants: () => ReadonlyArray<VariantRecord>;
};

/**
 * 内存档。
 *
 * 它刻意**不**重放控制板的规则（不查守卫、不上帽）：那些规则有它们自己的用例
 * （`control/**`、`board-writer.test.ts`），而板这一层的职责是「按什么次序、带
 * 什么身份去调用写口」。混在一起会让一条红说不清是谁坏了。
 */
function memoryArchive(): MemoryArchive {
  let variants: ReadonlyArray<VariantRecord> = [];
  const commits: CommitCardInput[] = [];
  const accounts: AccountInput[] = [];
  const uses: UseInput[] = [];
  const feedbacks: FeedbackInput[] = [];
  const byProposal = new Map<string, string>();

  return {
    commits,
    accounts,
    uses,
    feedbacks,
    variants: () => variants,
    port: {
      async load() {
        return { ok: true, variants: [...variants], shadowActivations: {} };
      },
      async commitCard(input) {
        commits.push(input);
        const duplicate = variants.some((item) => item.versionId === input.versionId);
        if (!duplicate) {
          variants = withVariant(
            variants,
            variantOf({
              versionId: input.versionId,
              proposalId: input.proposalId,
              card: input.card,
              accounting: [],
            }),
          );
        }

        byProposal.set(input.proposalId, input.versionId);

        return { ok: true, events: 5, duplicate };
      },
      async recordAccount(input) {
        accounts.push(input);
        const versionId = byProposal.get(input.proposalId);
        if (versionId !== undefined) {
          variants = withAccount(variants, versionId, input.outcome);
        }
        return { ok: true, events: 1, duplicate: false };
      },
      async recordUse(input) {
        uses.push(input);
        return { ok: true, events: 1, duplicate: false };
      },
      async recordFeedback(input) {
        feedbacks.push(input);
        return { ok: true, events: 1, duplicate: false };
      },
    },
  };
}

function boardOn(archive: MethodArchivePort): { readonly board: MethodBoard; readonly observed: Observed[] } {
  const observed: Observed[] = [];
  const board = createMethodBoard({
    archive,
    emit: (kind, payload) => observed.push({ kind, payload }),
    // 时钟由组合根注入，所以用例里它是一个常量——不是读墙钟。
    now: () => "2026-09-16T00:00:00.000Z",
  });

  return { board, observed };
}

async function beatWith(board: MethodBoard, report: MethodBeatReport): Promise<void> {
  await board.observe(report);
}

/** 拍 1 到拍 3：一个完整的「放权 → 出卡 → 入档」。 */
async function learnCard(board: MethodBoard, turnId: string, hint = HINT): Promise<void> {
  await beatWith(board, { turnId, beat: 1, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  await beatWith(board, { turnId, beat: 2, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  await beatWith(board, {
    turnId,
    beat: 3,
    failures: [],
    succeededTools: [],
    toolNames: TOOLS,
    proposal: proposalJson(hint),
  });
}

/** 一拍干净地结算了某个工具。 */
async function cleanBeat(board: MethodBoard, turnId: string, beat: number): Promise<void> {
  await beatWith(board, { turnId, beat, failures: [], succeededTools: ["echo"], toolNames: TOOLS });
}

/** 同一族又来了。 */
async function sameFailureBeat(board: MethodBoard, turnId: string, beat: number): Promise<void> {
  await beatWith(board, { turnId, beat, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
}

function withComponent(observed: ReadonlyArray<Observed>, component: string): ReadonlyArray<Observed> {
  return observed.filter((one) => one.payload.component === component);
}

test("T6: a card that passes the gate is archived on that beat, with no acceptance beat", async () => {
  const archive = memoryArchive();
  const { board, observed } = boardOn(archive.port);

  await learnCard(board, "trn-a");

  assert.equal(archive.commits.length, 1);
  const commit = archive.commits[0];

  assert.equal(commit?.card.hint, HINT);
  assert.equal(commit?.sample, "echo:path_outside_workspace");
  assert.equal(commit?.parentVersionId, undefined);
  assert.equal(commit?.observedAt, "2026-09-16T00:00:00.000Z");
  // 同 niche 的第二张会带上一版的身份——这里只入了一张，所以血缘是空的。
  assert.equal(archive.variants().length, 1);

  // 入档即入 shadow 区：指针是派生的，档里没有第二条可写状态。
  const shadow = board.shadowVariants();

  assert.equal(shadow.length, 1);
  assert.equal(shadow[0]?.pointer, "shadow");
  assert.equal(shadow[0]?.ledger.supports, 0);
  assert.equal(shadow[0]?.ledger.counterexamples, 0);

  const cards = withComponent(observed, "method_card");

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.kind, "observation");
  assert.equal(cards[0]?.payload.duplicate, false);
});

test("the intent lands on the beat after the release, never on the beat itself", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await beatWith(board, { turnId: "trn-a", beat: 1, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  assert.equal(board.intentOn("trn-a", 1), false);
  assert.equal(board.intentOn("trn-a", 2), false);

  await beatWith(board, { turnId: "trn-a", beat: 2, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  // 放权发生在拍 2，而意图是**下一拍**的事：同一拍里模型已经写完了。
  assert.equal(board.intentOn("trn-a", 2), false);
  assert.equal(board.intentOn("trn-a", 3), true);
  // 别的 turn 不带。
  assert.equal(board.intentOn("trn-b", 3), false);
});

test("T14: the card archived in turn A is in the slot in turn B", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  await board.endTurn("trn-a");
  // turn A 收尾之后不留痕迹：它的意图不会飘到后面的拍上。
  assert.equal(board.intentOn("trn-a", 4), false);

  const slot = await board.requestSlot({ turnId: "trn-b", beat: 1, toolNames: TOOLS });

  assert.notEqual(slot, undefined);
  assert.equal(slot?.message.role, "system");
  assert.equal(slot?.message.content.includes("[method slot]"), true);
  // ME0：槽行自带这一版在**本请求**里的短引用，引用与 receipt 同源同序。
  assert.equal(slot?.message.content.includes(`- [m1] ${HINT}`), true);
  assert.deepEqual(slot?.receipts.map((receipt) => receipt.ref), ["m1"]);
  // 还没放权，所以没有意图那一段。
  assert.equal(slot?.message.content.includes("[learning intent]"), false);

  // ME0-2：编译一个槽**不**记上场。`uses` 的真相在 Board 的上场日志上，只有真实
  // 发送（`recordFielding`）才落一条；从前的「按拍假增内存 uses」已删，所以 merely
  // 请求一次槽之后 uses 仍是 0，写口也没被叫过。
  assert.equal(board.shadowVariants()[0]?.ledger.uses, 0);
  assert.equal(archive.uses.length, 0);

  // 不相关的工具目录：候选的免费求值把它挡在槽外，而不是让它上场。
  assert.equal(await board.requestSlot({ turnId: "trn-b", beat: 2, toolNames: ["other"] }), undefined);
});

/**
 * ME0-2：一次真实发送落一条持久上场。
 *
 * 板这一层只问「带什么身份、按什么次序叫写口」，所以这里断言的是 `recordUse`
 * 收到的那条 `UseInput`——`exposureId` 由 `(attemptId, versionId)` 确定性派生，
 * `requestId` 就是 `attemptId`，`scope` 是 niche，`observedAt` 由板注入的 `now()`
 * 盖章（执行环不读时钟）。落盘与幂等是写口那一侧的事（`board-writer.test.ts`）。
 */
test("ME0-2: a real send records one fielding per receipt, with a derived exposure id", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  const slot = await board.requestSlot({ turnId: "trn-b", beat: 1, toolNames: TOOLS });

  assert.notEqual(slot, undefined);
  const receipts = slot?.receipts ?? [];

  assert.equal(receipts.length, 1);

  const notice: MethodFieldingNotice = {
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    receipts,
  };

  await board.recordFielding(notice);

  assert.equal(archive.uses.length, 1);
  const use = archive.uses[0];

  assert.equal(use?.turnId, "trn-b");
  assert.equal(use?.beat, 1);
  assert.equal(use?.requestId, "att-1");
  assert.equal(use?.versionId, receipts[0]?.versionId);
  assert.equal(use?.proposalId, receipts[0]?.proposalId);
  assert.equal(use?.scope, receipts[0]?.nicheId);
  assert.equal(use?.observedAt, "2026-09-16T00:00:00.000Z");
  // exposureId 与 writeId 同源：同一 (attemptId, versionId) 重放得同一个键，于是
  // 写口那侧的 commandId 也幂等（F07）。这里只验「派生自这两项、且两处一致」。
  assert.equal(use?.exposureId, use?.writeId);
  assert.notEqual(use?.exposureId, undefined);
});

test("ME0-2: the same send replayed derives the same exposure id (idempotent root)", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  const slot = await board.requestSlot({ turnId: "trn-b", beat: 1, toolNames: TOOLS });
  const receipts = slot?.receipts ?? [];
  const notice: MethodFieldingNotice = { attemptId: "att-1", turnId: "trn-b", beat: 1, receipts };

  await board.recordFielding(notice);
  await board.recordFielding(notice);

  // 板这一层不去重（去重是写口的 commandId 幂等）：它如实转发两次，两次的
  // exposureId 逐字相同，于是写口把第二次读成重放。断言的是「派生确定」这件事。
  assert.equal(archive.uses.length, 2);
  assert.equal(archive.uses[0]?.exposureId, archive.uses[1]?.exposureId);
});

test("ME0-2/F10: a fielding write failure degrades visibly and does not throw", async () => {
  const failing: MethodArchivePort = {
    async load() {
      return { ok: true, variants: [], shadowActivations: {} };
    },
    async commitCard() {
      return { ok: true, events: 5, duplicate: false };
    },
    async recordAccount() {
      return { ok: true, events: 1, duplicate: false };
    },
    async recordUse() {
      return { ok: false, reason: "board_unavailable", detail: "disk gone" };
    },
    async recordFeedback() {
      return { ok: true, events: 1, duplicate: false };
    },
  };
  const { board, observed } = boardOn(failing);
  // 一张已入档的卡的 receipt：直接构造，避免依赖 failing 档去 learnCard。
  const notice: MethodFieldingNotice = {
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    receipts: [{ ref: "m1", versionId: "ver:1", proposalId: "prop:1", nicheId: "niche:1" }],
  };

  // 不抛出去：用户任务照做。
  await board.recordFielding(notice);

  const degraded = withComponent(observed, "method_fielding");

  assert.equal(degraded.length, 1);
  assert.equal(degraded[0]?.payload.degraded, true);
  assert.equal(degraded[0]?.payload.reason, "board_unavailable");
  assert.equal(degraded[0]?.payload.versionId, "ver:1");
});

test("ME0-2: an unreadable archive records no fielding (fail closed, no write)", async () => {
  let writes = 0;
  const port: MethodArchivePort = {
    async load() {
      return { ok: false, reason: "board_file_corrupt" };
    },
    async commitCard() {
      writes += 1;
      return { ok: true, events: 5, duplicate: false };
    },
    async recordAccount() {
      writes += 1;
      return { ok: true, events: 1, duplicate: false };
    },
    async recordUse() {
      writes += 1;
      return { ok: true, events: 1, duplicate: false };
    },
    async recordFeedback() {
      writes += 1;
      return { ok: true, events: 1, duplicate: false };
    },
  };
  const { board } = boardOn(port);

  await board.recordFielding({
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    receipts: [{ ref: "m1", versionId: "ver:1", proposalId: "prop:1", nicheId: "niche:1" }],
  });
  // 读不出来的档上不写：一条 recordUse 都不发。
  assert.equal(writes, 0);
});

/**
 * ME0-3：一次已完成回答里的帮助自报落账。
 *
 * 板这一层只问「带什么身份、按什么次序叫写口」，所以这里断言的是 `recordFeedback`
 * 收到的那条 `FeedbackInput`——`exposureId` 由**与上场完全相同**的公式
 * `(attemptId, versionId)` 派生（于是 canonical reducer 的归因能命中那一次真实
 * 展示），`providerAttemptId` 就是 `attemptId`，`observedAt` 由板注入的 `now()` 盖章。
 * 归因本身（命中 / `feedback_unattributable`）是 reducer 那一侧的事
 * （`apply-method-ledger.test.ts` / `board-writer.test.ts`）。
 */
test("ME0-3: a completed answer records one feedback per item, with the fielding's exposure id", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  const slot = await board.requestSlot({ turnId: "trn-b", beat: 1, toolNames: TOOLS });
  const receipts = slot?.receipts ?? [];

  assert.equal(receipts.length, 1);
  const versionId = receipts[0]?.versionId;

  assert.notEqual(versionId, undefined);

  // 先上场，再反馈：与 runner 里的次序一致，于是反馈要归因的那条上场已经在板上。
  await board.recordFielding({ attemptId: "att-1", turnId: "trn-b", beat: 1, receipts });
  await board.recordFeedback({
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    items: [{ versionId: versionId ?? "", helped: true }],
  });

  assert.equal(archive.feedbacks.length, 1);
  const feedback = archive.feedbacks[0];

  assert.equal(feedback?.versionId, versionId);
  assert.equal(feedback?.turnId, "trn-b");
  assert.equal(feedback?.helped, true);
  assert.equal(feedback?.providerAttemptId, "att-1");
  assert.equal(feedback?.observedAt, "2026-09-16T00:00:00.000Z");
  // exposureId 与上场那条逐字相同：归因就是按这个键把反馈对回那一次真实展示。
  assert.equal(feedback?.exposureId, archive.uses[0]?.exposureId);
  // writeId 用 exposureId，于是 commandId 由 (attemptId, versionId, turnId, helped)
  // 确定性派生：同一条反馈重放得同一个键（F07）。
  assert.equal(feedback?.writeId, feedback?.exposureId);
});

test("ME0-3: helped false is recorded as false, not dropped and not turned into unknown", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  const receipts = (await board.requestSlot({ turnId: "trn-b", beat: 1, toolNames: TOOLS }))?.receipts ?? [];
  const versionId = receipts[0]?.versionId ?? "";

  await board.recordFielding({ attemptId: "att-1", turnId: "trn-b", beat: 1, receipts });
  await board.recordFeedback({
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    items: [{ versionId, helped: false }],
  });

  // false 是一条**反馈事实**，不是一条反例：它不进 recordAccount，不触发休眠/删除。
  assert.equal(archive.feedbacks.length, 1);
  assert.equal(archive.feedbacks[0]?.helped, false);
  assert.equal(archive.accounts.length, 0);
});

test("ME0-3: the same feedback replayed derives the same exposure id (idempotent root)", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  const receipts = (await board.requestSlot({ turnId: "trn-b", beat: 1, toolNames: TOOLS }))?.receipts ?? [];
  const notice: MethodFeedbackNotice = {
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    items: [{ versionId: receipts[0]?.versionId ?? "", helped: true }],
  };

  await board.recordFeedback(notice);
  await board.recordFeedback(notice);

  // 板这一层不去重（去重是写口的 commandId 幂等）：两次转发，exposureId 逐字相同。
  assert.equal(archive.feedbacks.length, 2);
  assert.equal(archive.feedbacks[0]?.exposureId, archive.feedbacks[1]?.exposureId);
});

test("ME0-3/F10: a feedback write failure degrades visibly and does not throw", async () => {
  const failing: MethodArchivePort = {
    async load() {
      return { ok: true, variants: [], shadowActivations: {} };
    },
    async commitCard() {
      return { ok: true, events: 5, duplicate: false };
    },
    async recordAccount() {
      return { ok: true, events: 1, duplicate: false };
    },
    async recordUse() {
      return { ok: true, events: 1, duplicate: false };
    },
    async recordFeedback() {
      return { ok: false, reason: "feedback_unattributable", detail: "ver:1@trn-b" };
    },
  };
  const { board, observed } = boardOn(failing);

  // 不抛出去：用户任务照做。归因不上是写口的判决，板只把它收成一条结构化降级。
  await board.recordFeedback({
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    items: [{ versionId: "ver:1", helped: true }],
  });

  const degraded = withComponent(observed, "method_feedback");

  assert.equal(degraded.length, 1);
  assert.equal(degraded[0]?.payload.degraded, true);
  assert.equal(degraded[0]?.payload.reason, "feedback_unattributable");
  assert.equal(degraded[0]?.payload.versionId, "ver:1");
});

test("ME0-3: an unreadable archive records no feedback (fail closed, no write)", async () => {
  let writes = 0;
  const port: MethodArchivePort = {
    async load() {
      return { ok: false, reason: "board_file_corrupt" };
    },
    async commitCard() {
      writes += 1;
      return { ok: true, events: 5, duplicate: false };
    },
    async recordAccount() {
      writes += 1;
      return { ok: true, events: 1, duplicate: false };
    },
    async recordUse() {
      writes += 1;
      return { ok: true, events: 1, duplicate: false };
    },
    async recordFeedback() {
      writes += 1;
      return { ok: true, events: 1, duplicate: false };
    },
  };
  const { board } = boardOn(port);

  await board.recordFeedback({
    attemptId: "att-1",
    turnId: "trn-b",
    beat: 1,
    items: [{ versionId: "ver:1", helped: true }],
  });
  // 读不出来的档上不写：一条 recordFeedback 都不发。
  assert.equal(writes, 0);
});

test("T8: a clean next beat supports the card", async () => {
  const archive = memoryArchive();
  const { board, observed } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  await cleanBeat(board, "trn-a", 4);

  assert.equal(archive.accounts.length, 1);
  assert.equal(archive.accounts[0]?.outcome, "supports");
  assert.equal(board.shadowVariants()[0]?.ledger.supports, 1);
  assert.equal(board.shadowVariants()[0]?.ledger.counterexamples, 0);
  assert.equal(
    withComponent(observed, "method_account")[0]?.payload.outcome,
    "supports",
  );
});

test("T8: the same family again is a counterexample, and a counterexample is not a deletion", async () => {
  const archive = memoryArchive();
  const { board, observed } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  await sameFailureBeat(board, "trn-a", 4);

  assert.equal(archive.accounts[0]?.outcome, "counterexamples");
  assert.equal(archive.accounts[0]?.samples[0], "echo:path_outside_workspace");
  assert.equal(board.shadowVariants().length, 1);
  assert.equal(board.shadowVariants()[0]?.ledger.counterexamples, 1);
  assert.equal(withComponent(observed, "method_account")[0]?.payload.outcome, "counterexamples");
});

test("T8: a beat that settled nothing is not a verdict, and the pending survives it", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  // 沉默既不是支持也不是反驳：这一拍没有结算任何工具，所以判决留到下一拍。
  await beatWith(board, { turnId: "trn-a", beat: 4, failures: [], succeededTools: [], toolNames: TOOLS });
  assert.equal(archive.accounts.length, 0);

  await cleanBeat(board, "trn-a", 5);
  assert.equal(archive.accounts.length, 1);
  assert.equal(archive.accounts[0]?.outcome, "supports");
});

test("a card admitted outside the release beat is not admitted at all", async () => {
  const archive = memoryArchive();
  const { board, observed } = boardOn(archive.port);

  await beatWith(board, { turnId: "trn-a", beat: 1, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  await beatWith(board, { turnId: "trn-a", beat: 2, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  // 围栏出现在拍 4，而放权的是拍 2（意图在拍 3）：只看我们请它写的那一拍。
  await beatWith(board, {
    turnId: "trn-a",
    beat: 4,
    failures: [],
    succeededTools: [],
    toolNames: TOOLS,
    proposal: proposalJson(HINT),
  });

  assert.equal(archive.commits.length, 0);
  assert.deepEqual(withComponent(observed, "method_gate"), []);
});

test("a refused card is reported and nothing is archived", async () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly proposal: string; readonly code: string }> = [
    {
      name: "unknown label",
      proposal: proposalJson(HINT, { labels: ["not_a_seeded_label"] }),
      code: "card_label_not_in_vocabulary",
    },
    {
      name: "hallucinated tool",
      proposal: proposalJson(HINT, { appliesWhen: { tools: ["ghost"] } }),
      code: "card_unknown_tool",
    },
    {
      name: "not a card",
      proposal: "the model wrote prose instead of a card",
      code: "card_not_json",
    },
  ];

  for (const one of cases) {
    const archive = memoryArchive();
    const { board, observed } = boardOn(archive.port);

    await beatWith(board, { turnId: "trn-a", beat: 1, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
    await beatWith(board, { turnId: "trn-a", beat: 2, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
    await beatWith(board, {
      turnId: "trn-a",
      beat: 3,
      failures: [],
      succeededTools: [],
      toolNames: TOOLS,
      proposal: one.proposal,
    });

    assert.equal(archive.commits.length, 0, one.name);
    const refused = withComponent(observed, "method_gate");

    assert.equal(refused.length, 1, one.name);
    assert.equal(refused[0]?.payload.reason, one.code, one.name);
    assert.equal(refused[0]?.payload.degraded, true, one.name);
    assert.equal(board.shadowVariants().length, 0, one.name);
  }
});

test("T8: two counterexamples with no support make the variant dormant, not gone", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  await sameFailureBeat(board, "trn-a", 4);
  // 第二个 turn 学的是同一句话：写口回答 duplicate，档里仍然只有一张。
  await learnCard(board, "trn-b");
  await sameFailureBeat(board, "trn-b", 4);

  assert.equal(archive.commits.length, 2);
  assert.equal(archive.commits[0]?.writeId, archive.commits[1]?.writeId);
  assert.equal(archive.variants().length, 1);

  const dormant = board.shadowVariants()[0];

  assert.equal(dormant?.ledger.counterexamples, 2);
  assert.equal(dormant?.ledger.supports, 0);
  assert.equal(dormant?.ledger.state, "dormant");
  // 还在档里，只是不上场。
  assert.equal(await board.requestSlot({ turnId: "trn-c", beat: 1, toolNames: TOOLS }), undefined);
});

test("a dormant variant comes back on its own once it earns a support", async () => {
  const archive = memoryArchive();
  const { board } = boardOn(archive.port);

  await learnCard(board, "trn-a");
  await sameFailureBeat(board, "trn-a", 4);
  await learnCard(board, "trn-b");
  await sameFailureBeat(board, "trn-b", 4);
  assert.equal(board.shadowVariants()[0]?.ledger.state, "dormant");

  // dormant 是可逆的：没有人「唤醒」它，一次干净的支持就够。
  await learnCard(board, "trn-c");
  await cleanBeat(board, "trn-c", 4);
  assert.equal(board.shadowVariants()[0]?.ledger.state, "active_pool");

  const slot = await board.requestSlot({ turnId: "trn-d", beat: 1, toolNames: TOOLS });

  assert.equal(slot?.message.content.includes(`- [m1] ${HINT}`), true);
});

test("an unreadable archive fails closed: no slot, no intent, no write", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
    readonly load: () => Promise<ArchiveLoadResult>;
  }> = [
    {
      name: "the port throws",
      reason: "archive_unreadable",
      load: async () => {
        throw new Error("board is gone");
      },
    },
    {
      name: "the port answers not-ok",
      reason: "board_file_corrupt",
      load: async () => ({ ok: false, reason: "board_file_corrupt" }),
    },
  ];

  for (const one of cases) {
    let writes = 0;
    const port: MethodArchivePort = {
      load: one.load,
      async commitCard() {
        writes += 1;
        // 读不出来的档上写东西，正是 fail closed 要防的那件事。
        throw new Error("a write after a failed read");
      },
      async recordAccount() {
        writes += 1;
        throw new Error("a write after a failed read");
      },
      async recordUse() {
        writes += 1;
        throw new Error("a write after a failed read");
      },
      async recordFeedback() {
        writes += 1;
        throw new Error("a write after a failed read");
      },
    };
    const { board, observed } = boardOn(port);

    // 空档：不上场。
    assert.equal(
      await board.requestSlot({ turnId: "trn-a", beat: 1, toolNames: TOOLS }),
      undefined,
      one.name,
    );
    await learnCard(board, "trn-a");
    // 也不问模型要产出：连放权都不发生，所以剥离器不会装、卡不会被悄悄扣掉。
    assert.equal(board.intentOn("trn-a", 3), false, one.name);
    assert.equal(writes, 0, one.name);
    assert.equal(board.shadowVariants().length, 0, one.name);
    // 降级只说一遍。
    const degraded = withComponent(observed, "method_archive");

    assert.equal(degraded.length, 1, one.name);
    assert.equal(degraded[0]?.payload.reason, one.reason, one.name);
    assert.equal(degraded[0]?.payload.degraded, true, one.name);
  }
});

/**
 * 合同 T16 / T17 与反方 #21 / #22（`§10`、`§11`）。
 *
 * 这四条问的都是**位置**，不是某一拍的行为：闸挂在哪一刻、账放在哪一层、那一句
 * 总结能走到哪一步。位置问题在板这一层是可测的，因为「命令了谁做什么」只在这里
 * 被记下来（`archive.commits` / `archive.accounts`），而生产代码里那几件**不该
 * 发生的事**可以静态扫。
 */

/** 本包的两个独占目录前缀（与 `method-adversary.test.ts` 同口径）。 */
const PACKAGE_DIRS: ReadonlyArray<string> = [
  "src/internal/learning/agent/subsystems/method",
];

/** Old-path bridges stay in scope until their protected consumers migrate. */
const COMPATIBILITY_DIRS = ["src/internal/learning/method", "src/internal/integration/method"];

/**
 * 自己落盘的原语，一个都不该出现。
 *
 * 方法子系统只经**控制板的账本端口**存取（`§7.1`）：文件落在磁盘上是适配器那一
 * 边的知识，不是学习层的。扫的是**去过注释的代码**——`integration/method/wiring.ts`
 * 有一段注释正好在解释它为什么不自己 `mkdirSync`。
 */
const RAW_WRITE_MARKERS: ReadonlyArray<string> = [
  "node:fs",
  "writeFile",
  "createWriteStream",
  "appendFile",
  "rmSync",
  "mkdirSync",
  "FileBoardStore",
];

/** 唯一一本账的唯一入口：把方法卡翻成 Board 命令的那一个文件。 */
const STORE_IMPORT = "adapters/learning-store";

/** 反方 #22 用的那一句总结。 */
const SUMMARY_LINE = "这一轮我先把根目录确认了一遍，再把文件写进去。";

async function packageSources(): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  const directories = [...PACKAGE_DIRS, ...COMPATIBILITY_DIRS.filter((dir) => existsSync(path.join(process.cwd(), dir)))];

  for (const dir of directories) {
    found.push(...await sourcesIn(dir));
  }

  const loop = "src/internal/loop";

  for (const entry of await readdir(path.join(process.cwd(), loop))) {
    if (entry.startsWith("method-") && entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(`${loop}/${entry}`);
    }
  }

  return found;
}

/** Recursion keeps every responsibility module under the original package rules. */
async function sourcesIn(dir: string): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readdir(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...await sourcesIn(file));
    } else if (entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("/testing/")) {
      found.push(file);
    }
  }

  return found;
}

/**
 * 剥掉注释，只留代码。
 *
 * 顺序不能反：先剥块注释再剥行注释。反过来的话，一个块注释里带 `//` 的句子会把
 * 注释的收尾一起吃进「行注释」里，于是块注释后半段被当成代码留下。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function codeOf(file: string): Promise<string> {
  return stripComments(await readFile(path.join(process.cwd(), file), "utf8"));
}

/** 一次完整的「放权 → 出卡」：拍 1 / 2 撞同一个三元组，拍 3 交上指定的围栏体。 */
async function learnWith(proposal: string): Promise<{
  readonly archive: MemoryArchive;
  readonly board: MethodBoard;
  readonly observed: Observed[];
}> {
  const archive = memoryArchive();
  const { board, observed } = boardOn(archive.port);

  await beatWith(board, { turnId: "trn-a", beat: 1, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  await beatWith(board, { turnId: "trn-a", beat: 2, failures: [FAILURE], succeededTools: [], toolNames: TOOLS });
  await beatWith(board, {
    turnId: "trn-a",
    beat: 3,
    failures: [],
    succeededTools: [],
    toolNames: TOOLS,
    proposal,
  });

  return { archive, board, observed };
}

test("T16: generating a card asks nobody, and silence is still not consent", async () => {
  const archive = memoryArchive();
  const { board, observed } = boardOn(archive.port);

  // 一次完整的「放权 → 出卡 → 入档」。它不等待任何人的点头：`observe` 正常返回，
  // 卡当拍就在档里（对照 T6）。
  await learnCard(board, "trn-a");
  assert.equal(archive.commits.length, 1);
  assert.equal(board.shadowVariants().length, 1);

  // #21：整条生成路径上没有一条「请求许可 / 等人工 / 已中断」的上报。板能说的话
  // 只有 `observation` 一种，载体只有那几件机器的事。
  assert.equal(observed.length > 0, true, "the board must be observable at all");

  for (const one of observed) {
    assert.equal(one.kind, "observation", JSON.stringify(one.payload));
    const flat = JSON.stringify(one.payload).toLowerCase();
    for (const word of ["approval", "permission", "interrupt", "awaiting"]) {
      assert.equal(flat.includes(word), false, `${one.kind}: ${flat}`);
    }
  }

  assert.deepEqual(
    [...new Set(observed.map((one) => one.payload.component))].sort(),
    ["method_card", "method_scheduler"],
  );

  // 而这不是「系统里没有问人这件事」的空话：控制板的命令表里**有**
  // `request_approval` 这个动词，它正是「问人」在系统里的样子。本包的生产代码里
  // 那个词零命中，所以生成路径上没有任何一处会去问人——查的是**代码**，不是意图。
  const asked: string[] = [];

  for (const file of await packageSources()) {
    if ((await codeOf(file)).includes("request_approval")) {
      asked.push(file);
    }
  }

  assert.deepEqual(asked, []);

  // 而「没人点头就常驻」也不成立：生成只到 shadow。跨任务常驻那一处**没有**闸，
  // 是登记在案的空缺（`OPEN-M2-12`），不是被静默放行——两者必须分开说。
  assert.equal(board.shadowVariants()[0]?.pointer, "shadow");
  assert.equal(isMethodPointer("active"), false);
});

test("T17: the subsystem stores nothing itself, and the one ledger has one door", async () => {
  const offenders: string[] = [];
  const importers: string[] = [];

  for (const file of await packageSources()) {
    const code = await codeOf(file);
    if (/from\s+["'][^"']*\/testing\//.test(code)) offenders.push(`${file}: production import of method testing support`);

    for (const marker of RAW_WRITE_MARKERS) {
      if (code.includes(marker)) {
        offenders.push(`${file}: ${marker}`);
      }
    }

    if (code.includes(STORE_IMPORT)) {
      importers.push(file);
    }
  }

  // ① 没有任何一处自己落盘：档的真相只在控制板那一本账上。
  assert.deepEqual(offenders, []);
  // ② 通向那一本账的路**只有一条**：方法卡 → Board 命令的唯一适配器。
  // These adapters all use the one shared Board reader/writer. None owns a
  // second file or journal: cards/feedback, corrections, structural facts, funding.
  assert.deepEqual(importers.sort(), ["board-writer", "experience-correction", "experience-funding", "experience-store"]
    .map(name => `src/internal/learning/agent/subsystems/method/adapters/${name}.ts`).sort());

  // ③ 读写口只有五个动词。没有 `save`、没有 `delete`：所谓「第二本变体账」不是
  //    一个还没被写出来的文件，而是一个在这里无处安放的动词。
  //    （M1 起：`load` 只读；`commitCard` / `recordAccount` / `recordUse` /
  //    `recordFeedback` 只写。）
  const archive = memoryArchive();

  assert.deepEqual(
    Object.keys(archive.port).sort(),
    ["commitCard", "load", "recordAccount", "recordFeedback", "recordUse"],
  );

  // ④ 扫描器自检：哪天目录改名让 `packageSources()` 返回空数组，上面两条会**空转
  //    全绿**。把「扫到了什么」变成断言，假绿就变成一次红。
  const files = await packageSources();

  assert.equal(files.length >= 15, true, `only ${files.length} production files were scanned`);

  for (const prefix of [...PACKAGE_DIRS, "src/internal/loop"]) {
    assert.equal(
      files.some((file) => file.startsWith(prefix)),
      true,
      `nothing from ${prefix} was scanned`,
    );
  }
});

test("#22: a summary is refused at the gate, so it can never enter the archive", async () => {
  // 差分用例：**同一张卡**，只多一个 `summary` 键。多出来的那一个键就是全部的差
  // 别，所以「总结入不了档」不是一条要记得遵守的纪律，是门的形状事实（`§6` 杠 2）。
  const withSummary = await learnWith(proposalJson(HINT, { summary: SUMMARY_LINE }));

  assert.deepEqual(
    withComponent(withSummary.observed, "method_gate").map((one) => one.payload.reason),
    ["card_shape_invalid"],
  );
  assert.deepEqual(withSummary.archive.commits, []);
  assert.equal(withSummary.archive.variants().length, 0);

  // 同一张卡不带 summary 就入档，所以拒绝的原因只可能是那一个键。而那一句要真正
  // 到用户眼前，走的是**通道**那条路（`loop/method-channel.test.ts` 的 T15）：它
  // 在交给门**之前**就被摘掉了，于是它既不进门、也不进档、也不参与排序。
  const bare = await learnWith(proposalJson(HINT));

  assert.equal(bare.archive.commits.length, 1);
  assert.equal(bare.archive.variants().length, 1);
  assert.equal(withComponent(bare.observed, "method_gate").length, 0);
});
