# 开源源码拉取清单

> 2026-11-07 路径说明：本文是参考导航；旧目标与命令保留历史含义。当前 checkout 在仓库根 `_workspace/research/new-cli-open/`；新增拉取必须使用该研究区，不能重新创建工程内 `open/`。

> 核验基准：2026-09-09  
> 当前动作：建立目录和可执行清单，尚未批量拉取源码  
> 默认分类：`reference`，不代表依赖采用或核心选型  
> 许可证字段：首轮核验结果；真正拉取时必须以目标 commit 内文件复核

## 优先级与执行方式

- `P0`：现在值得拉，直接服务于 Trylo CLI 核心设计讨论。
- `P1`：对应专题开工前拉，避免当前阅读面失控。
- `P2`：历史对照或特定疑问出现时再拉。
- `Q`：隔离观察；许可、生命周期或仓库内部边界需要专项审计。

在 `new trylo cli` 下执行单条命令。默认使用浅克隆，源码完整但不携带完整历史：

```powershell
git clone --depth 1 <repository-url> <target-path>
git -C <target-path> rev-parse HEAD
```

需要研究历史时只对目标仓库补全：

```powershell
git -C <target-path> fetch --unshallow
```

## P0：第一批应拉

| 类别 | 仓库与目标目录 | 首轮许可 | 重点阅读 | 边界 |
| --- | --- | --- | --- | --- |
| 协议 | `modelcontextprotocol/modelcontextprotocol` → `open/00-protocols/mcp-spec` | MIT（拉取时复核版本迁移） | schema、capability negotiation、生命周期、安全模型 | 协议候选，不等于 SDK 采用 |
| 协议 | `agentclientprotocol/agent-client-protocol` → `open/00-protocols/acp` | Apache-2.0 | editor/agent 双向会话、版本协商、terminal/tool 事件 | 重点学习，Trylo canonical protocol 仍自有 |
| 协议 | `ag-ui-protocol/ag-ui` → `open/00-protocols/ag-ui` | MIT | Agent→UI 事件、状态同步、tool UI、HITL、传输抽象 | 与现有 Desktop 事件流逐项对照 |
| 协议 | `a2aproject/A2A` → `open/00-protocols/a2a` | Apache-2.0 | Agent Card、task 生命周期、流式与长任务 | 面向跨 Agent 边界，不塞进单 Agent LOOP |
| CLI/runtime | `anomalyco/opencode` → `open/01-agent-cli-runtimes/opencode` | MIT | provider/model、session、tool、TUI、事件、配置 | 最重要的 TS 对照；完整 runtime 不默认成为核心 |
| CLI/runtime | `openai/codex` → `open/01-agent-cli-runtimes/codex` | Apache-2.0 | Rust runtime、approval、sandbox、exec、resume、协议层 | 学习成熟实现；核心采用另议 |
| CLI/runtime | `aaif-goose/goose` → `open/01-agent-cli-runtimes/goose` | Apache-2.0 | CLI/Desktop/API 共核、MCP/ACP、扩展与 recipes | 看多前端如何共享 runtime |
| CLI/runtime | `cline/cline` → `open/01-agent-cli-runtimes/cline` | Apache-2.0 | headless CLI、agent events、tool/approval、IDE 边界 | 重点看 UI 事件而非照搬 IDE 架构 |
| CLI/runtime | `google-gemini/gemini-cli` → `open/01-agent-cli-runtimes/gemini-cli` | Apache-2.0 | packages/core 分层、工具、认证、模型流 | 生命周期已有产品迁移信号，只作参考 |
| CLI/runtime | `Aider-AI/aider` → `open/01-agent-cli-runtimes/aider` | Apache-2.0 | repo map、edit format、git/test repair、上下文选择 | 学习算法与评测，不引入 Python 核心 |
| CLI/runtime | `SWE-agent/mini-swe-agent` → `open/01-agent-cli-runtimes/mini-swe-agent` | MIT（拉取时复核） | 极小 Loop、环境接口、轨迹、SWE-bench 集成 | 用来识别最小本质，不作为 parity 上限 |
| Framework | `openai/openai-agents-js` → `open/02-agent-frameworks/openai-agents-js` | MIT | tool loop、handoff、guardrail、session、tracing、HITL | star 未达核心采用门槛，参考足够 |
| Framework | `langchain-ai/langgraph` → `open/02-agent-frameworks/langgraph` | MIT | durable state、checkpoint、interrupt、长期/短期 memory | 防止 Trylo 把恢复与学习混成一个概念 |
| Framework | `pydantic/pydantic-ai` → `open/02-agent-frameworks/pydantic-ai` | MIT | typed loop、provider 抽象、durability、eval、capability | 重点读类型与边界，不引入 Python 类型 |
| Provider | `vercel/ai` → `open/03-provider-model-layer/vercel-ai` | Apache-2.0 | provider spec、stream parts、tool calls、capability/quirks、UI stream | B 级隔离采用候选，禁止类型渗入 Loop |
| Provider | `openai/openai-node` → `open/03-provider-model-layer/openai-node` | Apache-2.0 | Responses 流、错误/重试、取消、请求 ID、tool items | 官方适配参考，和 direct HTTP 做 spike |
| Provider | `anthropics/anthropic-sdk-typescript` → `open/03-provider-model-layer/anthropic-sdk-typescript` | MIT（拉取时复核） | streaming、tool use、errors/retries、Bedrock/Vertex 路径 | B 级候选，先审目标 tag 与闭包 |
| Provider | `googleapis/js-genai` → `open/03-provider-model-layer/google-js-genai` | Apache-2.0 | Gemini/Vertex 双入口、流式、多模态、function calling | B 级候选，先审认证闭包 |
| Tools | `modelcontextprotocol/typescript-sdk` → `open/04-tools-mcp-sandbox/mcp-typescript-sdk` | MIT/Apache-2.0 迁移期；文档另含 CC-BY-4.0 | transport、client/server、schema 生成、版本兼容 | 必须按文件/commit 审计，不能笼统写 MIT |
| Sandbox | `e2b-dev/E2B` → `open/04-tools-mcp-sandbox/e2b` | Apache-2.0 | 隔离环境生命周期、模板、文件/进程 API、自托管边界 | 云服务与源码许可是两件事；只作沙箱参考 |
| Learning | `letta-ai/letta-code` → `open/05-session-memory-learning/letta-code` | Apache-2.0 | git-backed memory、显式教学、dreaming、上下文预算、审计 | 很相关但未达到核心采用 star 门槛；研究优先 |
| Learning | `mem0ai/mem0` → `open/05-session-memory-learning/mem0` | Apache-2.0 | 抽取/更新/删除 memory、作用域、存储接口、评测 | 研究 memory layer，不等于 Trylo 学习 LOOP |
| Eval | `SWE-bench/SWE-bench` → `open/06-evals-benchmarks/swe-bench` | MIT | 可复现实仓任务、容器 harness、报告与缓存陷阱 | 数据集/镜像另审；源码拉取不自动下载数据 |
| Eval | `UKGovernmentBEIS/inspect_ai` → `open/06-evals-benchmarks/inspect-ai` | MIT | tool/multi-turn/model-graded eval、扩展与日志 | 评测框架参考，不进入产品 runtime |
| Eval | `openai/evals` → `open/06-evals-benchmarks/openai-evals` | MIT | registry、模板、model-graded eval、数据组织 | 重点学习 eval 资产结构 |

### P0 拉取命令

```powershell
git clone --depth 1 https://github.com/modelcontextprotocol/modelcontextprotocol.git open/00-protocols/mcp-spec
git clone --depth 1 https://github.com/agentclientprotocol/agent-client-protocol.git open/00-protocols/acp
git clone --depth 1 https://github.com/ag-ui-protocol/ag-ui.git open/00-protocols/ag-ui
git clone --depth 1 https://github.com/a2aproject/A2A.git open/00-protocols/a2a
git clone --depth 1 https://github.com/anomalyco/opencode.git open/01-agent-cli-runtimes/opencode
git clone --depth 1 https://github.com/openai/codex.git open/01-agent-cli-runtimes/codex
git clone --depth 1 https://github.com/aaif-goose/goose.git open/01-agent-cli-runtimes/goose
git clone --depth 1 https://github.com/cline/cline.git open/01-agent-cli-runtimes/cline
git clone --depth 1 https://github.com/google-gemini/gemini-cli.git open/01-agent-cli-runtimes/gemini-cli
git clone --depth 1 https://github.com/Aider-AI/aider.git open/01-agent-cli-runtimes/aider
git clone --depth 1 https://github.com/SWE-agent/mini-swe-agent.git open/01-agent-cli-runtimes/mini-swe-agent
git clone --depth 1 https://github.com/openai/openai-agents-js.git open/02-agent-frameworks/openai-agents-js
git clone --depth 1 https://github.com/langchain-ai/langgraph.git open/02-agent-frameworks/langgraph
git clone --depth 1 https://github.com/pydantic/pydantic-ai.git open/02-agent-frameworks/pydantic-ai
git clone --depth 1 https://github.com/vercel/ai.git open/03-provider-model-layer/vercel-ai
git clone --depth 1 https://github.com/openai/openai-node.git open/03-provider-model-layer/openai-node
git clone --depth 1 https://github.com/anthropics/anthropic-sdk-typescript.git open/03-provider-model-layer/anthropic-sdk-typescript
git clone --depth 1 https://github.com/googleapis/js-genai.git open/03-provider-model-layer/google-js-genai
git clone --depth 1 https://github.com/modelcontextprotocol/typescript-sdk.git open/04-tools-mcp-sandbox/mcp-typescript-sdk
git clone --depth 1 https://github.com/e2b-dev/E2B.git open/04-tools-mcp-sandbox/e2b
git clone --depth 1 https://github.com/letta-ai/letta-code.git open/05-session-memory-learning/letta-code
git clone --depth 1 https://github.com/mem0ai/mem0.git open/05-session-memory-learning/mem0
git clone --depth 1 https://github.com/SWE-bench/SWE-bench.git open/06-evals-benchmarks/swe-bench
git clone --depth 1 https://github.com/UKGovernmentBEIS/inspect_ai.git open/06-evals-benchmarks/inspect-ai
git clone --depth 1 https://github.com/openai/evals.git open/06-evals-benchmarks/openai-evals
```

## P1：专题开工前拉

| 类别 | 仓库与目标目录 | 首轮许可 | 何时拉 / 为什么 |
| --- | --- | --- | --- |
| Framework | `microsoft/agent-framework` → `open/02-agent-frameworks/microsoft-agent-framework` | MIT（拉取时复核） | P06 前；研究 AutoGen 后继的 workflow/multi-agent 边界 |
| Framework | `huggingface/smolagents` → `open/02-agent-frameworks/smolagents` | Apache-2.0 | P03 前；研究约千行的 code-agent/tool-calling loop 与 sandbox 边界 |
| Framework | `crewAIInc/crewAI` → `open/02-agent-frameworks/crewai` | MIT | P06 前；对照 role/crew 与 event-driven flow，重点识别过重抽象 |
| Framework | `microsoft/semantic-kernel` → `open/02-agent-frameworks/semantic-kernel` | MIT（拉取时复核） | P06/P07 前；研究 plugin、process、multi-agent 与企业集成边界 |
| CLI/runtime | `QwenLM/qwen-code` → `open/01-agent-cli-runtimes/qwen-code` | Apache-2.0（拉取时复核） | Provider/P08 专题；比较 Gemini CLI 派生后的模型适配和 CLI 改造 |
| Tools | `microsoft/node-pty` → `open/04-tools-mcp-sandbox/node-pty` | MIT | P03 前；Windows PTY、resize、退出与进程树 |
| Tools | `xtermjs/xterm.js` → `open/04-tools-mcp-sandbox/xterm-js` | MIT | P08 前；终端事件、buffer、resize 与前端边界 |
| Learning | `letta-ai/agent-file` → `open/05-session-memory-learning/letta-agent-file` | Apache-2.0 | L01/P05；研究可移植、版本化 Agent state 格式 |
| Learning | `letta-ai/claude-subconscious` → `open/05-session-memory-learning/claude-subconscious` | MIT | L01/P05；研究后台反思触发与写回，但不预设采用 |
| Eval | `letta-ai/letta-evals` → `open/06-evals-benchmarks/letta-evals` | Apache-2.0 | 学习方案比较时；研究 stateful-agent eval |
| Eval | `SWE-agent/SWE-agent` → `open/90-historical-archived/swe-agent` | MIT | 需要比较“大框架 vs mini”时；上游已推荐 mini-SWE-agent |

## P2：历史对照

| 仓库与目标目录 | 首轮许可/状态 | 阅读目的 |
| --- | --- | --- |
| `RooCodeInc/Roo-Code` → `open/90-historical-archived/roo-code` | Apache-2.0；2026-05 已归档 | 只研究曾经的 mode/tool/approval 设计，不作为采用候选 |
| `continuedev/continue` → `open/90-historical-archived/continue` | Apache-2.0；已停止活跃维护 | 只研究 IDE/CLI/config 演进与失败经验 |
| `microsoft/autogen` → `open/90-historical-archived/autogen` | MIT；维护模式 | 比较旧式 multi-agent 抽象与后继 Agent Framework |

## Q：隔离区，不能和普通参考混放

| 仓库与目标目录 | 风险 | 处理 |
| --- | --- | --- |
| `OpenHands/OpenHands` → `open/99-quarantine-mixed-license/openhands` | 根仓库 MIT，但存在 `enterprise/` PolyForm 等额外边界，且项目形态发生变化 | 如需研究 sandbox/event/server，可拉；先列文件级许可地图，禁止复制 enterprise 内容 |
| `BerriAI/litellm` → `open/99-quarantine-mixed-license/litellm` | 仓库同时出现开源与 commercial/enterprise 表述，当前不能只凭顶层页面判定全部边界 | provider gateway 专题需要时再拉；先做包/目录级许可审计 |

## 明确不进入本轮拉取清单

- CC CLI 源码：其使用边界已另行明确，本清单不重复讨论。
- GPL/LGPL/AGPL、BUSL/BSL、SSPL、PolyForm、Commons Clause、无许可证仓库：除非进入 `99-quarantine` 且有明确研究问题，否则不拉。
- 各种 “awesome-agent” 链接大全：信息密度低、许可混杂，先不占本地空间。
- 单纯套壳 chat UI、低维护 demo、无法追溯来源的 fork：不因为 star 或截图好看加入。
- 完整模型权重和 SWE-bench 数据/镜像：与源码仓库分开决策，避免误拉数十到数百 GB。

## 每次拉取后的复核动作

1. 记录 `git rev-parse HEAD`，不要只写 branch。
2. 检查根 `LICENSE*`、`NOTICE*`、`COPYING*`、`package.json`/`pyproject.toml`/`Cargo.toml` 与子包许可证。
3. 查找 `enterprise`、`commercial`、`source-available`、`vendored`、`third_party`、`assets`、`fixtures` 的例外。
4. 在对应分类 `README.md` 记下真正要回答的问题和入口文件，避免漫无目的通读。
5. 若产生采用意图，停止复制代码，另开依赖审计或 ADR；先定义 Trylo port/DTO 与退出路径。

## 清单状态栏

| 目标 | 状态 | commit | 许可证复核 | 阅读笔记 |
| --- | --- | --- | --- | --- |
| P0 全部 | `not-pulled` | — | 首轮完成，commit 级未完成 | — |
| P1 全部 | `deferred` | — | 待拉取 | — |
| P2 全部 | `deferred` | — | 待拉取 | — |
| Q 全部 | `quarantined` | — | 需专项审计 | — |
