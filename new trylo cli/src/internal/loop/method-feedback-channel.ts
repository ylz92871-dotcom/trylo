import type { ProviderEvent } from "../ports/provider.js";
import type { MethodFeedbackItem, MethodSlotReceipt } from "./method-port.js";

/**
 * 反馈围栏：从**同一回答**里切出模型对方法卡的帮助自报（ME0-3）。
 *
 * 这是本包第三台剥离器，与前两台（`method-channel.ts` 的 `trylo-learning`、
 * `tool-gap-channel.ts` 的工具缺口自报）**刻意互不共享实现**。理由与 `stream.ts`
 * 给第二台写下的一样：三台只在「围栏长什么样」这一点上相同，把它们抽成一个带
 * 参数的机器，会让「改教学围栏」有可能静默改掉「反馈围栏何时被剥离」。所以这里
 * 自己拥有一台解析状态机，自己有一套错误码。
 *
 * 规则少而硬，与 `method-channel.ts` 同口径：
 *
 *  - **fail-visible，不许吞字。** 只剥**正面认出来**的东西：闭合、能解析成 JSON、
 *    且通过闭集校验的围栏。闭合不了、超帽、不是 JSON、形状不对、引用未知或重复
 *    ——一律把扣住的那一段原样外发，只报一个码。模型写了半个围栏然后把活干完，
 *    用户看到的就是那半个。
 *  - **整块拒绝。** 一个块里只要有一条 item 非法，整块都不剥、不落账，原文可见。
 *    不做「接受合法的那几条、丢掉非法的那条」——半接受的反馈块会让「模型说了什么」
 *    与「账上记了什么」对不上。
 *  - **引用只在本请求内有效。** 校验 unknown ref 时比对的是**本请求发出去的那一组
 *    receipts**（构造时注入），不是任何跨请求的清单（`method-port.ts::MethodSlotReceipt`
 *    的 ref 语义）。判完未知，同一个 map 顺手把 ref 解析成 versionId——ref 是执行侧
 *    的、本请求内的短名，versionId 才是账认的持久身份，解析只在这一处发生。
 *  - **零缓冲零延迟。** 文本里没有出现围栏标记时一个字符都不扣；出现半个标记时才
 *    扣住那半个。
 *
 * 合法载荷为 `{items:[{ref,helped:boolean,application?}]}`；application 仅允许
 * practice/result 两个有界字符串，描述实际使用。旧 bool-only 反馈仍兼容。
 * 未知键、非布尔 helped、非数组 items 都是 `feedback_shape_invalid`。
 */

/** 与 `learning/method/port.ts::METHOD_FEEDBACK_FENCE` 同字，由合同测试要求相等。 */
export const FEEDBACK_FENCE = "trylo-method-feedback";

const FENCE = "```";
const MARKER = `${FENCE}${FEEDBACK_FENCE}`;

/**
 * 至多八条，每条可带两项各160字符的实际使用报告。总围栏继续受硬顶约束，
 * 超帽块原样可见；不让合法形状的自报变成无界延迟或正文缓冲。
 */
export const MAX_HELD_CHARS = 4000;
const MAX_FEEDBACK_ITEMS = 8;
const MAX_APPLICATION_CHARS = 160;

const ITEMS_FIELD = "items";
const REF_FIELD = "ref";
const HELPED_FIELD = "helped";
const APPLICATION_FIELD = "application";

export type FeedbackDispositionCode =
  | "held_over_cap"
  | "fence_unterminated"
  | "feedback_not_json"
  | "feedback_shape_invalid"
  | "feedback_ref_unknown"
  | "feedback_ref_duplicate";

/**
 * 一条已解析、已把 ref 对回 versionId 的帮助自报。
 *
 * 类型住在 `method-port.ts`（执行侧的窄合同），由合同测试要求与学习侧互相可赋值。
 * 这里**已经是 versionId 而不是 ref**：ref 的语义到执行侧为止，账只认 versionId。
 */
export type MethodFeedbackTake = {
  /** 第一个合法块解析出的条目；缺席 = 这一拍没有可用反馈。 */
  readonly items?: ReadonlyArray<MethodFeedbackItem>;
  /** 第一个非法块的降级码；缺席 = 没有非法块。 */
  readonly code?: FeedbackDispositionCode;
};

/** 流上的反馈剥离器。`rewrite` 是 `stream.ts::StreamRewriter` 要的那一个方法。 */
export type MethodFeedbackChannel = {
  rewrite(event: ProviderEvent): ReadonlyArray<ProviderEvent>;
  /** 流结束后取走产出。不消费，重复读得同一个答案。 */
  take(): MethodFeedbackTake;
};

type BlockState = {
  /** 尚未裁决的尾段：还没作为可见文本外发、也还没被剥离的前缀都已淘汰出这里。 */
  buffer: string;
};

/**
 * 建一台反馈剥离器。
 *
 * `receipts` 是**本请求**真正编进槽的那一组：它既给出合法 ref 的集合（判未知），
 * 又给出 ref→versionId 的解析（落账）。只在 receipts 非空时安装（`method-signal.ts`），
 * 所以这里拿到的总是一个非空集合——空槽不装剥离器，模型也就无从「对一张没展示的
 * 卡回反馈」。
 *
 * 增量解析：每个 `text_delta` 只处理**未裁决的尾段** `buffer`，已裁决的前缀（已外发的
 * 普通文本、已闭合并剥离/示众的围栏）当场淘汰，不再回头重扫。于是整段回答的总扫描量
 * 随长度线性增长，而不是每个 delta 重走全文的二次增长；一个早已闭合剥离的合法块，也
 * 不会因为后续正文变长而被反向改判（P1-2）。
 *
 * 裁决（items/code）只在 `text_end` 落定：流式途中即便围栏已闭合、已解析，也只暂存为
 * pending，`take()` 在流结束前恒返回空——「一枪一块、收口才算数」与旧实现同口径。
 */
export function createMethodFeedbackChannel(
  receipts: ReadonlyArray<MethodSlotReceipt>,
): MethodFeedbackChannel {
  const versionByRef = new Map(receipts.map((receipt) => [receipt.ref, receipt.versionId]));
  const blocks = new Map<string, BlockState>();
  let items: ReadonlyArray<MethodFeedbackItem> | undefined;
  let code: FeedbackDispositionCode | undefined;
  let pendingItems: ReadonlyArray<MethodFeedbackItem> | undefined;
  let pendingCode: FeedbackDispositionCode | undefined;

  const take = (): MethodFeedbackTake => ({
    ...(items === undefined ? {} : { items }),
    ...(code === undefined ? {} : { code }),
  });

  const visibleDelta = (blockId: string, visible: string): ReadonlyArray<ProviderEvent> =>
    visible.length === 0 ? [] : [{ type: "text_delta", blockId, text: visible }];

  return {
    take,
    rewrite: (event) => {
      if (event.type === "text_start") {
        blocks.set(event.blockId, { buffer: "" });
        return [event];
      }

      if (event.type === "text_delta") {
        const state = blocks.get(event.blockId) ?? { buffer: "" };

        state.buffer += event.text;
        const out = consume(state.buffer, true, versionByRef);

        state.buffer = out.rest;
        pendingItems ??= out.items;
        pendingCode ??= out.code;
        blocks.set(event.blockId, state);

        return visibleDelta(event.blockId, out.visible);
      }

      if (event.type === "text_end") {
        const state = blocks.get(event.blockId);

        blocks.delete(event.blockId);

        if (state === undefined) {
          return [event];
        }

        const out = consume(state.buffer, false, versionByRef);

        items ??= out.items === undefined ? pendingItems : out.items;
        code ??= out.code === undefined ? pendingCode : out.code;

        return [...visibleDelta(event.blockId, out.visible), event];
      }

      return [event];
    },
  };
}

type Consumed = {
  readonly visible: string;
  readonly rest: string;
  readonly items: ReadonlyArray<MethodFeedbackItem> | undefined;
  readonly code: FeedbackDispositionCode | undefined;
};

/**
 * 增量消费一段未裁决文本，返回（新外发的可见文本，仍未裁决的尾段，本段裁决出的
 * items/code）。
 *
 * `holdOpen` 是流式与最终的唯一差别：流式时一个尚未闭合、且未超帽的围栏整段留在
 * `rest` 里继续等后续 delta；最终处置时它变成一次 `fence_unterminated` 降级。两处用
 * 同一个循环，于是「流里看到的」与「收口结论的」不可能不一致。
 *
 * 计帽只对**围栏段**（marker→闭合```）计，不对 marker→文本末尾计：一个闭合的短反馈块
 * 后面跟着长正文是真实回答的常态，不能因此被误判 `held_over_cap` 而把围栏泄漏出去
 * （P1-2）。已裁决的前缀当场淘汰进 `visible`，`rest` 只保留尚未裁决的尾段，所以全文
 * 总扫描量线性而非二次。
 *
 * 第一个**合法**块给出 items；第一个**非法**块给出 code。两者各自只取第一次，与
 * `method-channel.ts` 的 proposal/code 同口径：一枪一块，第二块不是本拍要处理的。
 */
function consume(
  buffer: string,
  holdOpen: boolean,
  versionByRef: ReadonlyMap<string, string>,
): Consumed {
  let visible = "";
  let rest = buffer;
  let items: ReadonlyArray<MethodFeedbackItem> | undefined;
  let code: FeedbackDispositionCode | undefined;

  for (;;) {
    const open = rest.indexOf(MARKER);
    if (open === -1) {
      if (holdOpen) {
        const partial = partialMarkerStart(rest);
        const cut = partial === -1 ? rest.length : partial;
        visible += rest.slice(0, cut);
        rest = rest.slice(cut);
      } else {
        visible += rest;
        rest = "";
      }
      break;
    }

    visible += rest.slice(0, open);
    const held = rest.slice(open);
    const close = held.slice(MARKER.length).indexOf(FENCE);
    if (close === -1) {
      // 未闭合：流式且未超帽就整段扣住等后续；超帽是模型在写别的文档（runaway），
      // 收口时则是始终没闭合。两种都把这一段原样外发，只报一个码。
      if (holdOpen && held.length <= MAX_HELD_CHARS) {
        rest = held;
        break;
      }

      visible += held;
      code ??= holdOpen ? "held_over_cap" : "fence_unterminated";
      rest = "";
      break;
    }

    const fenceLen = MARKER.length + close + FENCE.length;
    if (fenceLen > MAX_HELD_CHARS) {
      // 闭合围栏段本身超帽：不是反馈块，连同其后正文一起原样外发。
      visible += held;
      code ??= "held_over_cap";
      rest = "";
      break;
    }

    const body = held.slice(MARKER.length, MARKER.length + close).trim();
    const parsed = parseFeedbackBlock(body, versionByRef);
    if (parsed.ok) {
      items ??= parsed.items;
    } else {
      // 非法块原样可见：把这一段围栏放回 visible，只报一个码。
      visible += held.slice(0, fenceLen);
      code ??= parsed.code;
    }

    rest = held.slice(fenceLen);
  }

  return { visible, rest, items, code };
}

type ParsedBlock =
  | { readonly ok: true; readonly items: ReadonlyArray<MethodFeedbackItem> }
  | { readonly ok: false; readonly code: FeedbackDispositionCode };

/**
 * 一个围栏体 →（合法条目 | 降级码）。
 *
 * 闭集校验，任何一处不符都让**整块**失败。校验次序是「先形状、后引用」：形状不对
 * 时连 ref 都读不出来，报形状码；形状对了再逐条查引用。
 */
function parseFeedbackBlock(
  body: string,
  versionByRef: ReadonlyMap<string, string>,
): ParsedBlock {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, code: "feedback_not_json" };
  }

  const items = closedSetItems(parsed);
  if (items === undefined) {
    return { ok: false, code: "feedback_shape_invalid" };
  }

  const resolved: MethodFeedbackItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const one = resolveItem(item, versionByRef, seen);
    if (one === undefined) {
      return { ok: false, code: itemCodeOf(item, versionByRef, seen) };
    }
    resolved.push(one);
  }

  return { ok: true, items: resolved };
}

/** 顶层必须是 `{items: [...]}`，且**只有** `items` 一个键。不符返回 undefined。 */
function closedSetItems(parsed: unknown): ReadonlyArray<unknown> | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const fields = parsed as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== ITEMS_FIELD) {
    return undefined;
  }

  const items = fields[ITEMS_FIELD];

  return Array.isArray(items) && items.length <= MAX_FEEDBACK_ITEMS ? (items as ReadonlyArray<unknown>) : undefined;
}

/** 一条 item →（已解析条目 | undefined）。ref 未知或重复也算失败。 */
function resolveItem(
  item: unknown,
  versionByRef: ReadonlyMap<string, string>,
  seen: Set<string>,
): MethodFeedbackItem | undefined {
  const shape = itemShape(item);
  if (shape === undefined) {
    return undefined;
  }

  const versionId = versionByRef.get(shape.ref);
  if (versionId === undefined || seen.has(shape.ref)) {
    return undefined;
  }

  // 记录已见：同一个 ref 在本块里出现第二次是 `feedback_ref_duplicate`。
  seen.add(shape.ref);

  return { versionId, helped: shape.helped, ...(shape.application === undefined ? {} : { application: shape.application }) };
}

type FeedbackShape = { readonly ref: string; readonly helped: boolean;
  readonly application?: NonNullable<MethodFeedbackItem["application"]> };

/** Closed item contract; optional reports never supply persistent identity. */
function itemShape(item: unknown): FeedbackShape | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return undefined;
  }

  const fields = item as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.some(key => ![REF_FIELD, HELPED_FIELD, APPLICATION_FIELD].includes(key))) {
    return undefined;
  }

  const ref = fields[REF_FIELD];
  const helped = fields[HELPED_FIELD];
  const application = fields[APPLICATION_FIELD];

  if (typeof ref !== "string" || typeof helped !== "boolean") {
    return undefined;
  }

  if (application !== undefined && !applicationShape(application)) return undefined;

  return { ref, helped, ...(application === undefined ? {} : { application }) };
}

/** Structural mirror of the learning-side application-report guard; loop must
 * not import learning policy. The cross-boundary contract tests keep it aligned. */
function applicationShape(value: unknown): value is NonNullable<MethodFeedbackItem["application"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const text = (entry: unknown) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= MAX_APPLICATION_CHARS;
  return Object.keys(fields).length === 2 && text(fields.practice) && text(fields.result);
}

/**
 * 一条非法 item 的降级码。
 *
 * 只在 `resolveItem` 已经返回 undefined 之后调用，所以这里只需区分「为什么非法」：
 * 形状不对 → shape；引用不在本请求 → unknown；引用重复 → duplicate。次序与
 * `resolveItem` 的判定次序一致，于是「报出来的码」就是「第一个不通过的那道闸」。
 */
function itemCodeOf(
  item: unknown,
  versionByRef: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
): FeedbackDispositionCode {
  const shape = itemShape(item);
  if (shape === undefined) {
    return "feedback_shape_invalid";
  }

  if (!versionByRef.has(shape.ref)) {
    return "feedback_ref_unknown";
  }

  if (seen.has(shape.ref)) {
    return "feedback_ref_duplicate";
  }

  return "feedback_shape_invalid";
}

/**
 * 结尾处那个可能是标记前缀的长度。
 *
 * `text_delta` 会从任意位置切开标记，扣住这个后缀（而不是整段）是「零缓冲」得以
 * 成立的另一半：没有前缀时一个字都不扣。与 `method-channel.ts` 同形，但各自独立
 * ——见文件头：三台剥离器刻意不共享实现。
 */
function partialMarkerStart(text: string): number {
  const longest = Math.min(MARKER.length - 1, text.length);

  for (let length = longest; length > 0; length -= 1) {
    if (MARKER.startsWith(text.slice(text.length - length))) {
      return text.length - length;
    }
  }

  return -1;
}
