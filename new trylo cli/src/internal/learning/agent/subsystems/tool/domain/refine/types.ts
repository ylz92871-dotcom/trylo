/**
 * A 描述精炼的形状（P05 工具学习规格 §6）。
 *
 * 规格给的形状是 `key=工具限定名, {originalHash, refinedDescription,
 * evidenceRefs, state: shadow|enforced, history[]}`，这里照抄，只把 `history`
 * 的元素命名出来——每一版是一次「重写了什么、凭什么重写」的完整事实，回滚时
 * 要能退到它，人审时也要能看见它。
 *
 * 与意识层同一条边界：**这一层没有 IO、没有写路径、不认识执行环**。它拿到的
 * 是一个 store 形状，组合层决定那是文件还是内存。于是「Agent 只提议、人审才
 * 转 enforced」在这里是字面事实，不是一句要记得遵守的纪律。
 */

/** 一版精炼：什么时候写的、写成什么样、凭哪些证据。 */
export type RefinementVersion = {
  readonly at: string;
  readonly description: string;
  readonly evidenceRefs: readonly string[];
};

/**
 * 覆盖层的一个条目。
 *
 * `originalHash` 是这一条里最容易被当成注释看掉、实际最要紧的字段。它有两个
 * 用处，缺一个都会出事：
 *
 *  1. **回滚。** 规格说「单工具回滚（保留 originalHash）」——回滚要能证明退回去
 *     的那段文本就是当初被换掉的那段，否则「回滚」只是换成了另一段猜测。
 *  2. **作废。** 上游工具自己改了描述，基于旧原文做的精炼就不再成立：模型读错的
 *     是**旧**那句话。所以原文一变，这条覆盖层自动失效（见 `resolveDescription`），
 *     而不是继续拿着一段对不上号的话去改模型看到的东西。
 */
export type RefinementEntry = {
  /** 工具限定名（`mcp__<server>__<tool>`），覆盖层的 key。 */
  readonly tool: string;
  /** 被换掉那段原文的哈希：回滚的凭据，也是作废的判据。 */
  readonly originalHash: string;
  readonly refinedDescription: string;
  readonly evidenceRefs: readonly string[];
  /** 当前这版是什么时候写的；`history` 里的旧版各自记着自己那次。 */
  readonly refinedAt: string;
  /** `shadow` 只记录不改行为；`enforced` 才真的换掉模型看到的话。 */
  readonly state: RefinementState;
  /** 旧版，最新的在最后；只留最近 `REFINE_MAX_HISTORY` 版。 */
  readonly history: readonly RefinementVersion[];
};

export type RefinementState = "shadow" | "enforced";

/**
 * 覆盖层的读写口子。
 *
 * 三个方法，因为这一层需要 store 做的事只有三件：读回一个工具的当前条目、把改过的
 * 条目放回去、以及**列出所有条目**（人审要看得见手上压着哪几版）。持久化是组合层的
 * 事（`integration/tool-learning/`），这一层不知道它是 JSON 还是什么。
 */
export type RefinementStore = {
  readonly entryFor: (tool: string) => RefinementEntry | undefined;
  readonly save: (entry: RefinementEntry) => void;
  readonly all: () => readonly RefinementEntry[];
};

/**
 * 注入点要的那半个覆盖层。
 *
 * 刻意**不是一个 store**：挂载处只需要问「这个工具的这段原文，现在该显示成什么」，
 * 它不该拿到写的能力，也不该拿到别的工具的条目。给一个窄函数，`mount.ts` 就
 * 没有途径去改覆盖层——「精炼不改执行语义」因此有一半是类型系统保证的。
 */
export type DescriptionOverlay = {
  /**
   * 该显示的描述；`undefined` = 用原文（没有条目、还在 shadow、或原文已变）。
   */
  readonly descriptionFor: (tool: string, original: string) => string | undefined;
};

/** 一次「要不要提议精炼」的判断输入。 */
export type RefineTriggerInput = {
  /** 针对这个工具攒到的失败证据数。 */
  readonly evidenceCount: number;
  /** 当前条目；没有就是从未精炼过。 */
  readonly entry: RefinementEntry | undefined;
  /** 自上次精炼以来有没有**新**的失败证据。 */
  readonly hasNewEvidenceSince: boolean;
};

/** 提议或不提议，以及不提议的理由——理由要能进账，所以它不是 `boolean`。 */
export type RefineTriggerVerdict =
  | { readonly kind: "propose" }
  | {
      readonly kind: "skip";
      readonly reason:
        | "below_min_evidence"
        | "enforced_and_converged"
        | "no_new_evidence";
    };
