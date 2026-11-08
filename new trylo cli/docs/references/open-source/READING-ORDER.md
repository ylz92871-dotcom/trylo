# 源码阅读顺序

> 2026-11-07 路径说明：本文是参考导航；旧目标与命令保留历史含义。当前 checkout 在仓库根 `_workspace/research/new-cli-open/`；新增拉取必须使用该研究区，不能重新创建工程内 `open/`。

不建议把二十多个仓库逐个从入口读到底。按 Trylo 要回答的问题横向读，才不会把某个上游的世界观误当成标准答案。

## 第一轮：先定边界，再看实现

1. `ag-ui`：列出 Trylo Desktop 当前缺少、已有和不应该拥有的 UI 事件。
2. `acp`：理解 client 与 agent 如何协商能力、管理 session、terminal 和 tool call。
3. `mcp-spec`：只研究 tool/resource/prompt 的协议职责，不把 MCP 当 Agent Loop。
4. `a2a`：确认跨 Agent 协作属于 Loop 外围还是核心状态机。

产出应是协议对照表，不是“选一个协议照抄”。

## 第二轮：横向比较成熟 CLI/runtime

按同一个问题依次看 `opencode`、`codex`、`goose`、`cline`、`gemini-cli`、`aider`、`mini-swe-agent`：

- 一轮的状态所有者是谁；
- model stream 如何变成 canonical event；
- tool call、approval、cancel、timeout 和 unknown outcome 如何建模；
- session 如何持久化、恢复和迁移；
- CLI、Desktop、SDK 是否共享同一个 runtime；
- 错误发生后哪些状态仍可信。

每个问题做一张横向表。禁止按仓库写七篇互不相干的读后感。

## 第三轮：Provider 和流式事件

先读 `opencode` 与 `vercel-ai` 的统一抽象，再读三个官方 SDK。目标是建立 Trylo 自有的 request/event/error/capability 词汇，而不是选择一个 SDK 的类型作为公共合同。

必须特别记录：tool-call 增量参数、reasoning、usage、finish reason、重试、取消、请求 ID、兼容端点差异和未知事件保真。

## 第四轮：学习专题，等待 L01 问题驱动

对 `letta-code`、`mem0`、`langgraph` 只回答这些问题：

- 什么证据足以触发学习候选；
- 写入发生在 active turn、turn end、compaction 还是后台任务；
- user preference、project fact、procedure、episode 和 policy 如何分域；
- 谁能确认、否决、回滚和删除；
- 如何避免错误经验被强化；
- 学习资产如何按需进入上下文而不压垮 Loop。

在 L01 决策前，不以任何仓库现有 schema 反向冻结 Trylo 学习合同。

## 第五轮：用评测反推设计

从 `swe-bench`、`inspect-ai`、`openai-evals` 提炼可复现任务、轨迹记录、评分、回归和报告格式。Trylo parity 不能只靠 demo 观感，必须能比较任务成功率、工具正确性、恢复能力、成本、延迟与学习副作用。
