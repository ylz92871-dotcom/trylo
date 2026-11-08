import type { SelfReport } from "./types.js";

/**
 * 源③：把围栏里的那段 JSON 读成一条可行动的自报（规格 §2 表格第三行）。
 *
 * 规矩只有一条，但它是这一层最重要的一条：**读不懂就当没说过。** 规格 §2 写
 * 「围栏空/坏 JSON → 只记 observation，不提议」——于是这里的返回值只有两种，
 * 解析出来的自报，或者 `undefined`。没有「部分相信」这种中间态，因为一条半懂的
 * 自报会带着模型自己的猜测进提议队列，而那时佐证规则就形同虚设了。
 *
 * 为什么 `improve_tool` 必须带 `tool`：规格给的自报原文是「改进:工具Y描述总让
 * 我用错」——Y 是从自然语言里读不出来的（`工具Y` 只是举例，不是格式）。所以
 * 格式上要求它另带一个 `tool` 键；缺了就判无效，而不是拿正则去猜。宁可这次不
 * 提议，也不要提议「改进某个说不清的东西」。
 */

const NEW_TOOL_PREFIX = "新工具:";
const IMPROVE_PREFIX = "改进:";

export function parseSelfReport(raw: unknown): SelfReport | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const fields = raw as Record<string, unknown>;
  const need = fields["need"];
  if (typeof need !== "string") {
    return undefined;
  }

  const text = need.trim();
  if (text.startsWith(NEW_TOOL_PREFIX)) {
    const detail = text.slice(NEW_TOOL_PREFIX.length).trim();
    return detail.length === 0 ? undefined : { kind: "new_tool", need: detail };
  }

  if (text.startsWith(IMPROVE_PREFIX)) {
    const detail = text.slice(IMPROVE_PREFIX.length).trim();
    const tool = fields["tool"];
    if (detail.length === 0 || typeof tool !== "string" || tool.trim().length === 0) {
      return undefined;
    }
    return { kind: "improve_tool", tool: tool.trim(), need: detail };
  }

  return undefined;
}
