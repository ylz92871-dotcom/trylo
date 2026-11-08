import type { ProviderEvent } from "../ports/provider.js";

/**
 * 共枪附加通道：从执行文本流里切出学习产出，并把切不掉的原样外发。
 *
 * 这是本包风险最高的地方，所以它的规则少而硬：
 *
 *  - **一处上游，两处受益。** 文本有两条下游——`applyTextBlock` 造的
 *    `assistant_text` transcript item（下一拍的请求来源），与
 *    `providerEventToInput` → reducer 的 journal `text` 事件（用户终端）。
 *    两者唯一的共同上游是 `loop/stream.ts::consumeProviderStream` 的那个循环，
 *    所以剥离器就装在这一层：一次处理，两处干净。surface 层不动，第二份剥离
 *    逻辑不存在。
 *  - **fail-visible，不许吞字。** 抽取器只剥它**正面认出来**的东西：闭合并能
 *    解析成 JSON 的围栏。闭合不了、超帽、内容不是 JSON —— 一律把扣住的那一段
 *    原样外发，只报一个码。「模型说了半句围栏、然后正常把活干完」，用户看到的
 *    就是那半句。
 *  - **零缓冲零延迟。** 文本里没有出现围栏标记时，一个字符都不扣；出现半个
 *    标记（` ` `` `` 这类前缀）时才扣住那半个。正常拍的延迟是 0。
 *  - **一拍两样，收件人不同（`§5.5`）。** 围栏里除了那张卡，还有一句**给人看
 *    的总结**。卡走门、进档、对用户不可见；总结由这一层拼回可见流（`text_end`
 *    时在该块的文本之后追加一条 `text_delta`）。于是剥离器有两个产出，而**门
 *    一行不改**：`summary` 在交给门之前就被摘掉了，它不是卡的一部分。
 *
 * 扣留上限 `MAX_HELD_CHARS = 1200` ≥ 单卡字符帽（`MAX_CARD_CHARS = 900`），所以
 * 一张合法卡永远不会撞上它；撞上的都是模型在写别的文档。两者的大小关系由合同
 * 测试钉住，而不是靠这两处的注释互相保证。
 */

/** 与 `learning/method/port.ts::LEARNING_FENCE` 同字，由合同测试要求相等。 */
export const LEARNING_FENCE = "trylo-learning";

const FENCE = "```";
const MARKER = `${FENCE}${LEARNING_FENCE}`;

/** 扣留上限。见文件头：一张合法卡（≤900）永远撞不上它。 */
export const MAX_HELD_CHARS = 1200;

/** 那一句给人看的总结在围栏体里的键名。它不是卡的一部分（`§5.5`）。 */
const SUMMARY_FIELD = "summary";

export type DispositionCode = "held_over_cap" | "fence_unterminated" | "proposal_not_json";

export type Disposition = {
  readonly visible: string;
  /** 只在围栏闭合并解析成 JSON 时出现。取下第一处。 */
  readonly proposal?: string;
  /**
   * 这一拍那句给人看的总结（`§5.5`）。只回答「看到了什么」，**不**拼进
   * `visible`：怎么把它送到用户眼前是 `createMethodChannel` 的事。
   */
  readonly summary?: string;
  readonly code?: DispositionCode;
};

/**
 * 一段**完整**文本的最终处置：外发什么、抽出什么、降级了没有。
 *
 * 纯函数，所以它可以直接被用例摆布。围栏可以有多处：每处各自判，能剥的剥掉、
 * 判不了的那一段原样外发（`visible` 在那一刻变成原文的余下部分）。第一处合法
 * 的 JSON 作为 proposal——共枪一枪一张卡，第二张不是本包要处理的东西。`summary`
 * 与它同口径：**第一处**解析出来的那一句生效。
 */
export function dispositionOf(text: string): Disposition {
  const walked = walkFences(text, false);
  return onlyPresent(walked.visible, walked.proposal, walked.summary, walked.code);
}

type Walked = {
  readonly visible: string;
  readonly proposal: string | undefined;
  readonly summary: string | undefined;
  readonly code: DispositionCode | undefined;
};

function onlyPresent(
  visible: string,
  proposal: string | undefined,
  summary: string | undefined,
  code: DispositionCode | undefined,
): Disposition {
  return {
    visible,
    ...(proposal === undefined ? {} : { proposal }),
    ...(summary === undefined ? {} : { summary }),
    ...(code === undefined ? {} : { code }),
  };
}

/**
 * 走一遍文本里的围栏。
 *
 * `holdOpen` 是流式与最终的唯一差别：流式时一个**尚未闭合**的围栏继续被扣住
 * （不往外发），最终处置时它变成一次 `fence_unterminated` 降级。两处用同一个
 * 循环，是为了让「流里看到的」与「流结束时结论的」不可能不一致。
 */
function walkFences(text: string, holdOpen: boolean): Walked {
  let visible = "";
  let rest = text;
  let proposal: string | undefined;
  let summary: string | undefined;
  let code: DispositionCode | undefined;

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
    if (held.length > MAX_HELD_CHARS) {
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
      code ??= "proposal_not_json";
      break;
    }

    // 卡与总结在这里分开：交给门的是**摘过 summary 的那一份**，所以「总结不过
    // 门」是字面事实（`§2.2` 案 A），而不是一句要记得遵守的纪律。
    const split = splitSummary(body);

    proposal ??= split.body;
    summary ??= split.summary;
    rest = held.slice(MARKER.length + close + FENCE.length);
  }

  return { visible, proposal, summary, code };
}

/**
 * 围栏体 →（摘掉顶层 `summary` 之后的体，那一句或 `undefined`）。
 *
 * 三条规则，每条都有一条用例：
 *
 *  - **不是普通对象就原样返回。** 它是不是一张合法的卡是门的事，通道不替门下
 *    判断——这里只回答「有没有那一句」。
 *  - **`summary` 不是非空字符串时只摘键、不产生那一句。** 坏 summary 永不拒卡：
 *    它本就不属于卡，所以它坏掉的代价只能是「用户看不到轻提示」。
 *  - **只摘这一个键。** 别的键一个不动，于是 `{"hint":…,"junk":1,"summary":…}`
 *    摘完仍带 `junk`，门照旧拒 `card_shape_invalid`——杠 2 不被削弱。
 *
 * 摘键要重走一次 `JSON.stringify`，但那**只影响字节排布**：门读的是重建后的卡
 * （`gate.ts::buildCard`），字符帽量的是规范 JSON（`cardLengthOf`），两者都与
 * 载荷的排布无关。
 */
function splitSummary(body: string): {
  readonly body: string;
  readonly summary: string | undefined;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { body, summary: undefined };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { body, summary: undefined };
  }

  const fields = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(fields, SUMMARY_FIELD)) {
    return { body, summary: undefined };
  }

  const value = fields[SUMMARY_FIELD];
  const rest: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(fields)) {
    if (key !== SUMMARY_FIELD) {
      rest[key] = entry;
    }
  }

  return {
    body: JSON.stringify(rest),
    summary: typeof value === "string" && value.length > 0 ? value : undefined,
  };
}

/**
 * 结尾处那个可能是标记前缀的长度。
 *
 * `text_delta` 会从任意位置切开标记——` ` `` `` ` `` ` ```t `` 都可能是一拍的
 * 结尾。扣住这个后缀（而不是整段）是「零缓冲」得以成立的另一半：没有前缀时
 * 一个字都不扣。
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

export type MethodChannelTake = {
  readonly proposal?: string;
  /**
   * 这一拍那句总结，**已经**作为 `text_delta` 拼回可见流了。
   *
   * 它在这里出现，是为了让「这一拍到底发了什么」有一个能被读一次的答案——呈现
   * 由通道做完，读它的人不必再去重放一遍事件。
   */
  readonly summary?: string;
  readonly code?: DispositionCode;
};

/**
 * 一条流上的剥离器。
 *
 * 它按 `blockId` 分别记账：文本块可以交错，而每个块自己的可见前缀是独立的。
 * 非文本事件**原样**通过（一个字段都不改），这是「不改工具目录、不改权限、不改
 * turn 语义」在代码层面的样子：附加通道在 `tool_call` 之外。
 */
export type MethodChannel = {
  /** 一个事件进去，应当外发的事件序列出来（可能为空，也可能多出一条 delta）。 */
  rewrite(event: ProviderEvent): ReadonlyArray<ProviderEvent>;
  /** 流结束后取走产出。不消费，重复读得同一个答案。 */
  take(): MethodChannelTake;
};

type BlockState = {
  raw: string;
  emitted: number;
};

export function createMethodChannel(): MethodChannel {
  const blocks = new Map<string, BlockState>();
  let proposal: string | undefined;
  let summary: string | undefined;
  let code: DispositionCode | undefined;

  const take = (): MethodChannelTake => ({
    ...(proposal === undefined ? {} : { proposal }),
    ...(summary === undefined ? {} : { summary }),
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
        const visible = walkFences(state.raw, true).visible;
        return emitNew(state, visible, event);
      }

      if (event.type === "text_end") {
        const state = blocks.get(event.blockId);

        blocks.delete(event.blockId);

        if (state === undefined) {
          return [event];
        }

        const walked = walkFences(state.raw, false);

        proposal ??= walked.proposal;
        code ??= walked.code;
        // 与 proposal 同口径：**第一处**解析出的那一句生效，且只在这个块后面发。
        const fresh = summary === undefined ? walked.summary : undefined;

        summary ??= walked.summary;

        return [
          ...emitNew(state, walked.visible, event),
          ...(fresh === undefined ? [] : [summaryDelta(event.blockId, walked.visible, fresh)]),
          event,
        ];
      }

      return [event];
    },
  };
}

/**
 * 把那一句总结拼回可见流（`§5.5`）。
 *
 * 它挂在这一刻而不是挂在 `text_delta` 上：整段围栏是被**扣住**的，所以那一句和
 * 卡一样要等到这个块闭合才知道成不成立。加在 `text_end` **之前**，是为了让它落
 * 在同一个块里——“assistant_text” 转录项与 journal 文本吃的都是这个块的文本，
 * 于是两条下游都会看到它，谁都不需要再问一次。
 *
 * 可见文本非空且不以换行结尾时先补一个 `\n`：那句话是给人看的，不该粘在上一句
 * 的句尾。
 */
function summaryDelta(blockId: string, visible: string, summary: string): ProviderEvent {
  const needsBreak = visible.length > 0 && !visible.endsWith("\n");
  return { type: "text_delta", blockId, text: `${needsBreak ? "\n" : ""}${summary}` };
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
