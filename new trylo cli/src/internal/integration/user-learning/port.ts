import type { UserLearningRuntime } from "./runtime.js";
import { USER_POLICY_RECEIPT_PREFIX } from "./runtime.js";

/**
 * 用户学习与方法学习**合成一个槽**（UE-2 的「并排 + 共享一个总预算顶」）。
 *
 * 为什么是合成而不是各开一个口：执行环只认识一个注入点（`LoopPorts.method`，每拍
 * 一次 `requestSlot`，答一条 `system`）。两个子系统各答一条，就变成两条 `system`
 * 争谁先谁后，而「共享一个总顶」这件事在两个口之间**没法表达**——谁先算都不知道
 * 另一个花了多少。合成之后，次序和额度都是同一个函数里的两行：
 *
 *  1. 先问方法槽（原样、一次不改），它的字符数就是「已花」；
 *  2. 再把「已花」交给用户学习，它自己与总顶相减去算可用额度；
 *  3. 两条都有就拼成一条 `system`（方法在前，用户在后）。
 *
 * 三条恒等式是这个形状的承重墙，逐条有测试：
 *
 *  - **没接用户学习时，`requestSlot` 返回的就是方法槽的回答本身**（同一个对象，
 *    不是等值的新对象）。于是 `--learning=method` 这条路与方法子系统单独在跑时
 *    **逐字节相同**，不需要谁去保证。
 *  - **用户学习没编出段时，返回的仍然是方法槽的回答本身。** 「开着但没命中」与
 *    「没开」在字节上不可区分。
 *  - **两个都没接 ⇒ `undefined`。** 于是 `wirePorts` 连 `method` 这个键都不放，
 *    `LoopPorts.method` 是 `undefined`，整条学习结构不存在（I1）。
 *
 * 这里用的端口形状是**结构性**声明的，不 import `loop/**`：`loop/boundary.test.ts`
 * 管的是 loop 不许 import 别人，而反方向也没必要——组合层只要形状对得上，
 * `surface/cli/wiring.ts` 把它赋给 `LoopPorts.method` 时类型检查会替我们验一次。
 */

type SlotMessage = { readonly role: "system"; readonly content: string };

/**
 * 方法槽交付物的**结构性**副本（ME0-1）。
 *
 * 与 `learning/method/port.ts`、`loop/method-port.ts` 各一份，三者由合同测试
 * 互锁。这里不 import 上面两家，和本文件其余部分同一条理由：组合层只要形状对
 * 得上，赋值处（`surface/cli/wiring.ts`）的类型检查会替我们验一次。
 */
type LearningSlotReceipt = {
  readonly ref: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly nicheId: string;
};

type LearningSlotDelivery = {
  readonly message: SlotMessage;
  readonly receipts: readonly LearningSlotReceipt[];
};

type LearningSlotRequest = {
  readonly turnId: string;
  readonly beat: number;
  readonly toolNames: readonly string[];
};

/**
 * 真实发送通知的**结构性**副本（ME0-2）。
 *
 * 与 `learning/method/port.ts`、`loop/method-port.ts` 各一份，三者由合同测试互锁。
 * 同样没有 `observedAt`：执行环不读时钟，上场时刻由方法板盖章。
 */
type LearningFieldingNotice = {
  readonly attemptId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly receipts: readonly LearningSlotReceipt[];
};

/**
 * 帮助自报通知的**结构性**副本（ME0-3）。
 *
 * 与 `learning/method/port.ts`、`loop/method-port.ts` 各一份，三者由合同测试互锁。
 * item 携带的是 **versionId 而不是 ref**：ref→versionId 的解析发生在执行侧的反馈剥
 * 离器里，账只认持久身份。同样没有 `observedAt`：时刻由方法板盖章。
 */
type LearningFeedbackItem = {
  readonly versionId: string;
  readonly helped: boolean;
};

type LearningFeedbackNotice = {
  readonly attemptId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly items: readonly LearningFeedbackItem[];
};

type LearningBeatReport = {
  readonly turnId: string;
  readonly beat: number;
  readonly failures: readonly {
    readonly tool: string;
    readonly code: string;
    readonly fingerprint: string;
  }[];
  readonly succeededTools: readonly string[];
  readonly toolNames: readonly string[];
  readonly proposal?: string;
};

export type LearningPortShape = {
  readonly observe: (report: LearningBeatReport) => Promise<void>;
  readonly intentOn: (turnId: string, beat: number) => boolean;
  /** Optional post-compilation confirmation; absence preserves legacy teaching behavior. */
  readonly confirmIntent?: (turnId: string, beat: number) => boolean;
  readonly requestSlot: (request: LearningSlotRequest) => Promise<LearningSlotDelivery | undefined>;
  readonly recordFielding: (notice: LearningFieldingNotice) => Promise<void>;
  readonly recordFeedback: (notice: LearningFeedbackNotice) => Promise<void>;
  readonly endTurn: (turnId: string, signal?: AbortSignal) => Promise<void>;
};

export type ComposeLearningInput = {
  /** 方法子系统，或没接。 */
  readonly method: LearningPortShape | undefined;
  /** 用户学习运行时，或没接。 */
  readonly user: UserLearningRuntime | undefined;
};

export function composeLearningPorts(input: ComposeLearningInput): LearningPortShape | undefined {
  const { method, user } = input;

  if (user === undefined) {
    return method;
  }

  const userVersions = new Set<string>();

  return {
    observe: async (report) => {
      await method?.observe(report);
    },
    intentOn: (turnId, beat) => method?.intentOn(turnId, beat) ?? false,
    ...(method?.confirmIntent === undefined ? {} : { confirmIntent: (turnId: string, beat: number) => method.confirmIntent!(turnId, beat) }),
    requestSlot: async (request) => mergeSlots(await method?.requestSlot(request), user, request, userVersions),

    // User owns its exposure. Method never receives a peer's opaque receipt.
    recordFielding: async (notice) => {
      const receipts = notice.receipts.filter(receipt => !receipt.ref.startsWith(USER_POLICY_RECEIPT_PREFIX));
      try { await method?.recordFielding(receipts.length === notice.receipts.length ? notice : { ...notice, receipts }); }
      finally { user.recordFielding?.(notice); }
    },

    // Model self-reports cannot stand in for the human's opinion about a policy.
    recordFeedback: async (notice) => {
      const items = notice.items.filter(item => !userVersions.has(item.versionId));
      await method?.recordFeedback(items.length === notice.items.length ? notice : { ...notice, items });
    },

    endTurn: async (turnId, signal) => {
      try { await method?.endTurn(turnId, signal); }
      finally {
        user.finishTurn();
        userVersions.clear();
      }
    },
  };
}

/**
 * 一条 `system`，两个来源。
 *
 * `spentChars` 用 `content.length` 而不是别的口径，与方法槽自己的投影口径**故意
 * 不同**：那边量的是它要花多少，这边量的是它已经占了提示词里多少字符。两个数都
 * 对着同一段最终文本，所以它们不会漂。真 token 口径仍然缺席（`OPEN-M2-4`），
 * 本包不引入第二个估算器。
 */
function mergeSlots(
  learned: LearningSlotDelivery | undefined,
  user: UserLearningRuntime,
  request: LearningSlotRequest,
  userVersions: Set<string>,
): LearningSlotDelivery | undefined {
  // Reserve the separator too; the shared character ceiling covers the final text.
  const spent = learned === undefined ? 0 : learned.message.content.length + 1;
  const injected = user.policyFor(spent, request);
  if (injected === undefined) {
    return learned;
  }

  if (injected.receipt !== undefined) userVersions.add(injected.receipt.versionId);

  return {
    message: {
      role: "system",
      content:
        learned === undefined ? injected.text : `${learned.message.content}\n${injected.text}`,
    },
    // A User-only slot still needs an opaque receipt: the execution owner only
    // notifies actual fielding for a nonempty receipt set after stream_start.
    receipts: [...(learned?.receipts ?? []), ...(injected.receipt === undefined ? [] : [injected.receipt])],
  };
}
