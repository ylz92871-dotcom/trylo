import type { ProviderEvent } from "../ports/provider.js";
import { TOOL_GAP_FENCE } from "./tool-gap-port.js";

/**
 * 围栏标记在这里再出口一次，理由与第一型相同：用它的地方（用例、抓药的人）
 * 读 `channel` 比读声明文件更自然。真正的声明在 `tool-gap-port.ts`，两份字面量
 * 的相等由合同测试要求。
 */
export { TOOL_GAP_FENCE };

/**
 * 第二型围栏的剥离器：从执行文本流里切出模型的**自报**。
 *
 * 这是第一型（学习方法子系统那台）的**第二台**，不是它的一个参数。规格 §2 明写
 * 「围栏的模式是方法子系统立过的先例，但这是独立的一台，不复用其机器」。所以规则
 * 逐字照抄、代码各写各的：第一型改口径时不会顺手改到这一台，两台唯一的公共理解
 * 是「围栏长什么样」。仓库里已有同型先例——两道架构扫描器宁可各写十五行也不共用
 * 一个抽取器，理由是「跨两条边界的错误抽象比重复更糟」，这里照办。
 *
 * 三条规则与第一型相同，因为它们都是「不许骗用户」的不同侧面：
 *
 *  - **一处上游，两处受益。** 文本的两条下游是 `assistant_text` 转录项（下一拍的
 *    请求来源）与 journal 的 `text` 事件（用户终端）。两者唯一的共同上游是消费
 *    循环，所以剥离器装在那里：一次处理，两处干净，第二份剥离逻辑不存在。
 *  - **fail-visible，不许吞字。** 只剥它**正面认出来**的东西：闭合并能解析成
 *    JSON 的围栏。闭合不了、超帽、内容不是 JSON —— 把扣住的那一段原样外发，只报
 *    一个码。模型说了半句围栏然后继续干活，用户看到的就是那半句。
 *  - **零缓冲零延迟。** 文本里没有标记时一个字符都不扣；出现半个标记时才扣住那
 *    半个。正常拍的延迟是 0。
 *
 * 与第一型的一处**刻意差异**：这一台没有「一拍两样」。第一型要把一句给人看的总结
 * 拼回可见流（`§5.5`），自报不需要——它整段就是给学习层的一句话，剥掉即可。
 */

/** 扣留上限。超过它说明模型在写别的文档，不是在写自报。 */
export const MAX_TOOL_GAP_HELD_CHARS = 1200;

const FENCE = "```";
const MARKER = `${FENCE}${TOOL_GAP_FENCE}`;

export type ToolGapDispositionCode = "held_over_cap" | "fence_unterminated" | "self_report_not_json";

export type ToolGapDisposition = {
  readonly visible: string;
  /** 只在围栏闭合并解析成 JSON 时出现。取下第一处。 */
  readonly selfReport?: string;
  readonly code?: ToolGapDispositionCode;
};

export function dispositionOfToolGap(text: string): ToolGapDisposition {
  const walked = walk(text, false);
  return {
    visible: walked.visible,
    ...(walked.selfReport === undefined ? {} : { selfReport: walked.selfReport }),
    ...(walked.code === undefined ? {} : { code: walked.code }),
  };
}

type Walked = {
  readonly visible: string;
  readonly selfReport: string | undefined;
  readonly code: ToolGapDispositionCode | undefined;
};

/**
 * 走一遍文本里的围栏。
 *
 * `holdOpen` 是流式与最终的唯一差别：流式时一个**尚未闭合**的围栏继续被扣住，
 * 最终处置时它变成一次降级。两处用同一个循环，是为了让「流里看到的」与「流结束
 * 时结论的」不可能不一致。
 */
function walk(text: string, holdOpen: boolean): Walked {
  let visible = "";
  let rest = text;
  let selfReport: string | undefined;
  let code: ToolGapDispositionCode | undefined;

  for (;;) {
    const open = rest.indexOf(MARKER);
    if (open === -1) {
      if (holdOpen) {
        const partial = partialMarkerStart(rest);
        visible += partial === -1 ? rest : rest.slice(0, partial);
        break;
      }

      visible += rest;
      break;
    }

    visible += rest.slice(0, open);
    const held = rest.slice(open);
    if (held.length > MAX_TOOL_GAP_HELD_CHARS) {
      visible += held;
      code ??= "held_over_cap";
      break;
    }

    const close = held.slice(MARKER.length).indexOf(FENCE);
    if (close === -1) {
      if (holdOpen) {
        break;
      }
      visible += held;
      code ??= "fence_unterminated";
      break;
    }

    const body = held.slice(MARKER.length, MARKER.length + close).trim();
    if (!isJson(body)) {
      visible += held;
      code ??= "self_report_not_json";
      break;
    }

    // 第一处合法自报生效：一拍一句话，第二处不是本层要处理的东西。
    selfReport ??= body;
    rest = held.slice(MARKER.length + close + FENCE.length);
  }

  return { visible, selfReport, code };
}

/**
 * 结尾处那个可能是标记前缀的长度。
 *
 * `text_delta` 会从任意位置切开标记——` ` `` `` ` `` ` ```t `` 都可能是一拍的结尾。
 * 扣住这个后缀（而不是整段）是「零缓冲」得以成立的另一半。
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

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export type ToolGapTake = {
  readonly selfReport?: string;
  readonly code?: ToolGapDispositionCode;
};

/**
 * 一条流上的第二型剥离器。
 *
 * 它按 `blockId` 分别记账（文本块可以交错），非文本事件**原样**通过（同一个对象，
 * 不是副本）——这是「不改工具目录、不改权限、不改 turn 语义」在代码层面的样子。
 */
export type ToolGapChannel = {
  rewrite(event: ProviderEvent): ReadonlyArray<ProviderEvent>;
  take(): ToolGapTake;
};

type BlockState = {
  raw: string;
  emitted: number;
};

export function createToolGapChannel(): ToolGapChannel {
  const blocks = new Map<string, BlockState>();
  let selfReport: string | undefined;
  let code: ToolGapDispositionCode | undefined;

  const take = (): ToolGapTake => ({
    ...(selfReport === undefined ? {} : { selfReport }),
    ...(code === undefined ? {} : { code }),
  });

  return {
    take,
    rewrite: (event) => {
      if (event.type === "text_start") {
        blocks.set(event.blockId, { raw: "", emitted: 0 });
        return [event];
      }

      if (event.type === "text_delta") {
        const state = blocks.get(event.blockId) ?? { raw: "", emitted: 0 };
        state.raw += event.text;
        blocks.set(event.blockId, state);
        return emitNew(state, walk(state.raw, true).visible, event);
      }

      if (event.type === "text_end") {
        const state = blocks.get(event.blockId);

        blocks.delete(event.blockId);

        if (state === undefined) {
          return [event];
        }

        const walked = walk(state.raw, false);

        selfReport ??= walked.selfReport;
        code ??= walked.code;

        return [...emitNew(state, walked.visible, event), event];
      }

      return [event];
    },
  };
}

/**
 * 这一次增量里新露出来的可见文本。
 *
 * `visible` 是原文的**前缀一致**函数：扣住时它停在前缀处，降级时它一步跳到原文
 * 末尾。所以「已经发到哪」就是一个下标，而不是一份要去重的历史。
 */
function emitNew(
  state: BlockState,
  visible: string,
  event: ProviderEvent,
): ReadonlyArray<ProviderEvent> {
  const next = visible.slice(state.emitted);

  state.emitted = visible.length;

  if (next.length === 0) {
    return [];
  }

  return event.type === "text_delta" || event.type === "text_end"
    ? [{ type: "text_delta", blockId: event.blockId, text: next }]
    : [];
}
