/**
 * 贡献助手：**一段固定的话，不走 LLM**（规格 §9，所有者 2026-09-17 明确）。
 *
 * 为什么是固定的：用户点「提交开源贡献」时，我们要给他的是**起点**而不是成品。
 * 让模型当场起草会引入两个我们都不要的东西——一次不再是零成本的模型调用，以及
 * 一份**可能把本地工作区的内容带出去**的正文。固定模板把这两条同时关掉：它只
 * 包含用户自己看得到的东西（他要贡献的工具、它的上游、他想说明的改动），一个
 * 字都不来自我们。
 *
 * 所以这段文本里**没有**任何内容是从轨迹、日志或 diff 里自动摘的。改动描述是一
 * 个显式占位符，由用户自己填。这正是「用户自己点了才贡献，Agent 只帮起草」在
 * 代码层面的样子：连「起草」都交给用户，我们只负责把格式铺好。
 */

/** 用户要自己填的改动描述。它是一段占位符，不是一个待填的模板变量。 */
export const CONTRIBUTION_PLACEHOLDER = "<在这里写你改了什么、为什么改>";

export type ContributionContext = {
  /** 要贡献的工具名。 */
  readonly tool: string;
  /** 上游仓库地址（来自元数据，域名锚定已核过）。 */
  readonly upstreamUrl: string;
  /** 建议的分支名。 */
  readonly branch: string;
};

export function contributionPrompt(context: ContributionContext): string {
  return [
    `我想把我们本地对 ${context.tool} 的改进提交回上游。`,
    "",
    `上游仓库：${context.upstreamUrl}`,
    `建议分支：${context.branch}`,
    "",
    "请帮我：",
    "1. 先读一遍上游仓库里这个工具的现状，确认我的改动确实不冲突；",
    "2. 把改动整理成一个最小、聚焦的提交（不要顺手改无关的东西）；",
    "3. 写一段说明，讲清**改之前什么不行、改之后什么行了**；",
    `4. 涉及具体代码差异的地方，等我补充——${CONTRIBUTION_PLACEHOLDER}。`,
    "",
    "先别 push、别开 issue，把方案给我看过再说。",
  ].join("\n");
}
