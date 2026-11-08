import {
  MAX_CARD_CHARS,
  cardLengthOf,
  specificityOf,
  type FailureFamily,
  type LabelId,
  type VariantRecord,
} from "../domain/contracts.js";
import { candidatePool } from "../assets/archive.js";

/**
 * 上场是**编译**，不是检索。
 *
 * 「检索」暗示一次查询、一个索引、一个可能失败的查找；这里没有那些东西。有的
 * 是：候选来自内存里的档（组合根读一次，入档时同步更新），求值是几个纯比较，
 * 装包是一段排序加三道硬顶。**不跑 LLM、不读磁盘**，所以「每次 buildRequest 读
 * 一次」的代价是一次字符串拼接。
 *
 * 「档变则重编」是自动的：本 turn 刚入档的卡从**下一次**请求起就在候选池里，
 * 所以不需要为 intra 单开一条注入路径——M1 的 `inPlayCard` 特殊态因此消失。
 *
 * 结果是 `0 张` 就是 `0 张`：空档、无匹配、全 dormant、预算为 0，四种情况都编
 * 出空槽，而空槽的注入是恒等（`withInjectedSlot`），于是关学习与开着但空档在
 * 字节上不可区分。
 *
 * **排序第一键不是生次数**（`§8.3`）：槽 A 取匹配最细的，槽 B 才用次数；次数
 * 只做同分打破。抽签、轮转、随机都不会出现——同一次请求必须有同一个槽。
 */

/** 一次编译要问的全部问题。 */
export type CompileRequest = {
  readonly archive: ReadonlyArray<VariantRecord>;
  /** 本轮真实存在的工具名。 */
  readonly toolNames: ReadonlyArray<string>;
  /** 本 session 最近未消解的释放理由族；没有就是没有（家族过滤不生效）。 */
  readonly currentFamily: FailureFamily | undefined;
  /** 上一拍的钩子标签；没有钩子就是不因标签过滤。 */
  readonly hookLabels: ReadonlyArray<LabelId> | undefined;
  readonly slotChars: number;
  readonly slotCards: number;
};

export type CompiledSlot = {
  readonly variants: ReadonlyArray<VariantRecord>;
  readonly hints: ReadonlyArray<string>;
  readonly chars: number;
};

/**
 * 槽行的渲染口径与计费口径。
 *
 * ME0 起每条 hint 在注入文本里**带着自己的短引用**：`- [m1] <hint>`。引用是
 * 「这一版在这一个请求里的名字」——模型按它回反馈，执行侧按它把反馈对回版本
 * （ME0-2/ME0-3）。渲染与计费因此必须同源：**都在这里**，第二个地方重写一遍这条
 * 规则，预算就会和真正打进提示词的文本漂开。
 *
 * 引用按槽内次序编号（`m1`、`m2`…），不是随机数、不是哈希：同一
 * `(turnId, beat)` 的编译是纯函数，所以「这一拍的第 k 条是谁」是确定的。它
 * **不跨请求**——请求 A 的 `m1` 与请求 B 的 `m1` 是两个不同的东西，接收方必须
 * 按「本请求的 receipts」判未知引用。与规格 §5.1「由 turnId + beat + versionId
 * 确定性生成」的字面偏差见 `ME0-STATE.md` 偏离条 D-1（依据 / 影响 / 撤回成本）。
 *
 * 计费仍只算**卡片行**：每张卡占 `hint.length + "- [mN] ".length`。表头一行历来
 * 不计费，本包不改变那条既有约定（偏离条 D-2）。真 token 口径需要组合根注入估算器
 * （学习层不得 import loop 的估算器），属 `OPEN-M2-4`。
 */
export const SLOT_LINE_PREFIX = "- ";

/** 槽内 1-based 序号的短引用。编译、渲染、计费三处共用这一个函数。 */
export function methodRefOf(index: number): string {
  return `m${index + 1}`;
}

/** 渲染一条槽行。渲染与计费共用它，所以两者不会漂。 */
export function slotLineFor(ref: string, hint: string): string {
  return `${SLOT_LINE_PREFIX}[${ref}] ${hint}`;
}

/** 一张卡在预算里占的字符数：`hint` 本体 + 渲染前缀（`- [mN] `）。 */
export function slotCardCharsOf(ref: string, hint: string): number {
  return hint.length + SLOT_LINE_PREFIX.length + ref.length + 3;
}

export function slotCharsOf(hints: ReadonlyArray<string>): number {
  return hints.reduce((total, hint, index) => total + slotCardCharsOf(methodRefOf(index), hint), 0);
}

/** 槽行的渲染结果，按次序。`slotCharsOf` 量的就是这些行。 */
export function slotLinesOf(hints: ReadonlyArray<string>): ReadonlyArray<string> {
  return hints.map((hint, index) => slotLineFor(methodRefOf(index), hint));
}

export function compileSlot(request: CompileRequest): CompiledSlot {
  const eligible = candidatePool(request.archive).filter((variant) => appliesTo(variant, request));
  const first = bestMatch(eligible, request);
  const rest = rankedForSlotB(
    eligible.filter((variant) => variant.versionId !== first?.versionId),
    request,
  );
  const ordered = first === undefined ? rest : [first, ...rest];

  return pack(ordered, request);
}

/**
 * 候选的**免费求值**（`§8.2`）。
 *
 * 四项都是纯比较，而且都是「卡的声明」与「本拍的事实」之间的对照：
 *
 *  - `tools`：声明的每个工具都要真的在本轮目录里。不要求目录等于声明——卡是
 *    「这条经验关于某个工具」，不是「这个目录长这样」。
 *  - `failureFamily`：只在当前正撞着这一族时适用。没撞着就是不适用的时刻。
 *  - `labels`：与上一拍的钩子有交集。**没有钩子就不因标签过滤**——没有依据的
 *    过滤会把「没钩子」变成「什么都选不上」。
 *  - `sameSession`：恒真。字段在这里，是为了跨 session 的以后不必改形状。
 */
function appliesTo(variant: VariantRecord, request: CompileRequest): boolean {
  const scope = variant.card.appliesWhen;
  const tools = scope.tools;
  if (tools !== undefined && tools.some((name) => !request.toolNames.includes(name))) {
    return false;
  }

  if (scope.failureFamily !== undefined && scope.failureFamily !== request.currentFamily) {
    return false;
  }

  return withinHook(scope.labels, request.hookLabels);
}

function withinHook(
  declared: ReadonlyArray<LabelId> | undefined,
  hookLabels: ReadonlyArray<LabelId> | undefined,
): boolean {
  if (hookLabels === undefined || hookLabels.length === 0) {
    return true;
  }

  if (declared === undefined || declared.length === 0) {
    return true;
  }

  return declared.some((label) => hookLabels.includes(label));
}

/**
 * 槽 A：至多一张，取**钩子最贴的**。
 *
 * 「最贴」写成一个可数的量：`appliesWhen` 给出几个字段（`specificityOf`）。同分
 * 时用分数、再用档里更靠后的，全部是为了让同一次请求的同一个档得到同一个槽。
 */
function bestMatch(
  eligible: ReadonlyArray<VariantRecord>,
  request: CompileRequest,
): VariantRecord | undefined {
  const ranked = [...eligible].sort(
    (left, right) => specificityOf(right.card.appliesWhen) - specificityOf(left.card.appliesWhen),
  );
  const top = ranked[0];
  if (top === undefined) {
    return undefined;
  }

  const tied = ranked.filter(
    (variant) => specificityOf(variant.card.appliesWhen) === specificityOf(top.card.appliesWhen),
  );

  return tieBreak(tied, request, "uses");
}

/**
 * 槽 B：其余位置按「词表命中 + 次数高」排。
 *
 * 命中是**过滤器**（在 `appliesTo` 里已经生效），这里是同命中条件下的次序：
 * `uses` 降序，同分用 `supports`，再同分用较新的版本。第一键不是生次数，这一
 * 条在 `§8.3` 是明写的。
 */
function rankedForSlotB(
  eligible: ReadonlyArray<VariantRecord>,
  request: CompileRequest,
): ReadonlyArray<VariantRecord> {
  const ranked = [...eligible];

  ranked.sort((left, right) => {
    if (left.ledger.uses !== right.ledger.uses) {
      return right.ledger.uses - left.ledger.uses;
    }

    if (left.ledger.supports !== right.ledger.supports) {
      return right.ledger.supports - left.ledger.supports;
    }

    return archiveIndex(request, right) - archiveIndex(request, left);
  });

  return ranked;
}

function tieBreak(
  tied: ReadonlyArray<VariantRecord>,
  request: CompileRequest,
  _key: "uses",
): VariantRecord | undefined {
  const ranked = rankedForSlotB(tied, request);
  return ranked[0];
}

function archiveIndex(request: CompileRequest, variant: VariantRecord): number {
  return request.archive.findIndex((item) => item.versionId === variant.versionId);
}

/**
 * 装包与三道硬顶。
 *
 * 张数 ≤ `slotCards`、字符 ≤ `slotChars`、单卡 ≤ `MAX_CARD_CHARS`，**谁先到谁
 * 封**：按次序加，遇到第一个放不下的就停，不跳过它去试更小的——「跳过」会让
 * 结果依赖后面有什么，而槽的顺序本身是有含义的（槽 A 是最贴的那一张）。
 *
 * **预算是主顶，张数是兜底**（`§8.3`）：一张卡占 `hint.length + 2`，所以
 * `slotChars` 通常先封；`slotCards` 只是防一手「预算很大而卡很小」的上界。于是
 * **张数是结果**——`0 张` 不是失败，是正常结果，与空档、无匹配、全 dormant 编出
 * 的空槽没有区别。
 *
 * 单卡帽在这里是第三次检查：门已经按整卡字符拒过一张超帽的卡，`skipped` 计数
 * 因此通常是 0。留着它是因为档可能有别的写入者（板是共享的），而「读进来的东
 * 西一律要再量一次」比「相信写进去时量过」便宜。
 */
function pack(
  ordered: ReadonlyArray<VariantRecord>,
  request: CompileRequest,
): CompiledSlot {
  const variants: VariantRecord[] = [];
  const hints: string[] = [];
  let chars = 0;

  for (const variant of ordered) {
    if (variants.length >= request.slotCards) {
      break;
    }

    if (cardLengthOf(variant.card) > MAX_CARD_CHARS) {
      break;
    }

    const next = chars + slotCardCharsOf(methodRefOf(variants.length), variant.card.hint);
    if (next > request.slotChars) {
      break;
    }

    variants.push(variant);
    hints.push(variant.card.hint);
    chars = next;
  }

  return { variants, hints, chars };
}
