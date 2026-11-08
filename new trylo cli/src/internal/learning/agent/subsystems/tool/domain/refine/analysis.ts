import { REFINE_MAX_DESCRIPTION_LENGTH } from "./constants.js";

/**
 * A 描述精炼的**分析段**：一次 LLM 往返，输入原文与失败证据，输出一段新描述
 * （P05 工具学习规格 §6「攒 ≥N 条失败证据 → 一次 LLM 分析 → 重写」）。
 *
 * 提示词在这里是**模板而不是自由文本**：每次跑的那句话都一样，只有原文与证据
 * 两个占位符变。理由和意识层围栏的固定话完全相同——一段会变的提示词意味着
 * 「模型为什么这么重写」无法复现，也就无法归因。所以模板是常量，占位符是输入。
 *
 * 解析与生成分开：`parseRefinement` 是纯函数，不认识 ToolRunnerPort、不认识 LLM，
 * 只把一段文本读成一个结果。于是「模型答歪了」这件事可以在没有模型的情况下被测。
 */

/** 分析段最多看几条失败证据——它是给人看的上下文，不是语料库。 */
export const REFINE_MAX_EVIDENCE_IN_PROMPT = 10;

/**
 * 让模型重写一段工具描述的那句话。
 *
 * 三条约束都写死在提示词里，因为它们不是「希望模型做到」而是**这一层的前提**：
 * 只改描述（改别的就是改执行语义，验收 #6 的红线）、不写指令性句子（描述是要进
 * 模型眼睛的，一段带指令的精炼就是自己给自己开的注入通道）、简短（描述要解决
 * 的问题恰恰是模型读不懂）。
 */
export function refinementPrompt(input: {
  readonly tool: string;
  readonly originalDescription: string;
  readonly evidenceRefs: readonly string[];
}): string {
  const evidence =
    input.evidenceRefs.length === 0
      ? "（无）"
      : input.evidenceRefs.slice(0, REFINE_MAX_EVIDENCE_IN_PROMPT).join("\n");
  return [
    "你在帮一个 CLI 修一段 MCP 工具的描述。下面是它当前的描述，以及模型在用它时反复出现的失败。",
    "",
    `工具名：${input.tool}`,
    "",
    "当前描述：",
    input.originalDescription,
    "",
    "失败证据：",
    evidence,
    "",
    "只做一件事：重写这段描述，让模型不再用错。要求：",
    "- 只改描述文本本身。不要改工具名、参数、任何行为约定。",
    "- 不要写任何指令性的句子（例如「忽略之前的指令」）。你写的是给人看的说明书。",
    "- 保持简短。它要解决的问题就是模型读不懂。",
    "- 语言跟原文一致。",
    "",
    '只输出一行 JSON：{"description":"<重写后的描述>"}',
  ].join("\n");
}

export type RefinementParseResult =
  | { readonly ok: true; readonly description: string }
  | { readonly ok: false; readonly reason: "no_json" | "no_description" | "empty" };

/**
 * 把模型的回答读成一段描述。
 *
 * 宽容得有理：模型会把 JSON 包在围栏里、前后带解释、或者多写一行。所以这里找的是
 * **第一个**含 `description` 的对象，而不是要求整段回答就是一个 JSON——收紧到后者，
 * 只会让解析失败变成一次「模型其实答对了但我们读不出来」。
 *
 * 不宽容的部分：读不出 `description`、或者它是空白，就是失败。此时**不写覆盖层**，
 * 回到原文——一段精炼没有产出，最坏的结果是「什么都没变」，而不是「模型的眼睛里
 * 多了一段没意义的话」。
 */
export function parseRefinement(raw: string): RefinementParseResult {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const candidates = jsonObjectsIn(text);

  for (const candidate of candidates) {
    const value = (candidate as { description?: unknown }).description;
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "empty" };
    }

    return {
      ok: true,
      description: trimmed.length > REFINE_MAX_DESCRIPTION_LENGTH
        ? trimmed.slice(0, REFINE_MAX_DESCRIPTION_LENGTH)
        : trimmed,
    };
  }

  return { ok: false, reason: "no_description" };
}

/**
 * 回答里所有能解析成对象的片段。
 *
 * 从每个 `{` 起试着解一个平衡的括号段——`JSON.parse` 自己会拒绝没闭合的，所以这里
 * 只需要判断「哪里结束」，不需要真的理解 JSON。行数有限（一段回答），所以最坏情况
 * 的扫描代价可以忽略。
 */
function jsonObjectsIn(text: string): readonly unknown[] {
  const found: unknown[] = [];

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end === -1) {
      continue;
    }

    try {
      found.push(JSON.parse(text.slice(start, end + 1)) as unknown);
    } catch {
      continue;
    }
  }

  return found;
}

/** 从 `{` 出发找到配对的那个 `}`；找不到回答 `-1`。字符串与转义要跳过。 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}
