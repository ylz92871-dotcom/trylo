# PULL-LOG — P0 首次拉取台账

> 生成时间: 2026-09-09T15:10:10.463292+00:00
> 核验基准: 2026-09-09 commit 级浅克隆 (--depth 1 --single-branch, core.longpaths=true)
> 分类: reference (not-evaluated)
> 路径说明: 表格和命令保留 2026-09-09 历史目标；现 checkout 位于仓库根 `_workspace/research/new-cli-open/`。本台账是资料导航，不是设计权威。

## 概览

- 成功: 25/25 P0
- 失败/待重试: 0 (pydantic-ai 采用 --no-checkout 后成功)
- 隔离区 Q 未拉取 (需专项审计后决定)
- openai-evals LFS 部分对象因网络限速过滤较慢，但 HEAD 与主要源码已就绪

## 明细

| 目标 | 状态 | commit | 许可证复核 | 拉取时间 |
| --- | --- | --- | --- | --- |
| open/00-protocols/mcp-spec | pulled | aa8ce04 (2026-09-08) | MIT/Apache-2.0 transition + CC-BY-4.0 docs | 2026-09-09 |
| open/00-protocols/acp | pulled | ecd8d72 (2026-09-09) | Apache-2.0 | 2026-09-09 |
| open/00-protocols/ag-ui | pulled | c358c99 (2026-09-09) | MIT | 2026-09-09 |
| open/00-protocols/a2a | pulled | 98853be (2026-09-01) | Apache-2.0 | 2026-09-09 |
| open/01-agent-cli-runtimes/opencode | pulled | 830d5eb (2026-09-09) | MIT | 2026-09-09 |
| open/01-agent-cli-runtimes/codex | pulled | 73a1148 (2026-09-09) | Apache-2.0 (+ NOTICE, third_party MIT/Apache) | 2026-09-09 |
| open/01-agent-cli-runtimes/goose | pulled | e84de9f (2026-09-09) | Apache-2.0 | 2026-09-09 |
| open/01-agent-cli-runtimes/cline | pulled | 2dd8f11 (2026-09-09) | Apache-2.0 | 2026-09-09 |
| open/01-agent-cli-runtimes/gemini-cli | pulled | ed2ac40 (2026-09-08) | Apache-2.0 (+ third_party MIT) | 2026-09-09 |
| open/01-agent-cli-runtimes/aider | pulled | 5dc9490 (2026-05-22) | Apache-2.0 | 2026-09-09 |
| open/01-agent-cli-runtimes/mini-swe-agent | pulled | 04d809c (2026-09-03) | MIT | 2026-09-09 |
| open/02-agent-frameworks/openai-agents-js | pulled | 064fcb2 (2026-09-09) | MIT | 2026-09-09 |
| open/02-agent-frameworks/langgraph | pulled | e539ac1 (2026-09-09) | MIT | 2026-09-09 |
| open/02-agent-frameworks/pydantic-ai | pulled | 0ec8a5d (2026-09-08) | MIT | 2026-09-09 |
| open/03-provider-model-layer/vercel-ai | pulled | b7670d9 (2026-09-09) | Apache-2.0 | 2026-09-09 |
| open/03-provider-model-layer/openai-node | pulled | 81b6bfe (2026-09-09) | Apache-2.0 | 2026-09-09 |
| open/03-provider-model-layer/anthropic-sdk-typescript | pulled | ba14b1f (2026-09-04) | MIT | 2026-09-09 |
| open/03-provider-model-layer/google-js-genai | pulled | ac23cc6 (2026-09-08) | Apache-2.0 | 2026-09-09 |
| open/04-tools-mcp-sandbox/mcp-typescript-sdk | pulled | 5119ee7 (2026-09-03) | MIT/Apache-2.0 transition (LICENSE says Apache-2.0 for new code) + CC-BY-4.0 docs | 2026-09-09 |
| open/04-tools-mcp-sandbox/e2b | pulled | e0082d4 (2026-09-09) | Apache-2.0 (root) + MIT subpackages | 2026-09-09 |
| open/05-session-memory-learning/letta-code | pulled | de54f4a (2026-09-08) | Apache-2.0 | 2026-09-09 |
| open/05-session-memory-learning/mem0 | pulled | 02f7a9b (2026-09-09) | Apache-2.0 (root) + MIT in mem0-ts/src/oss, n8n-nodes-mem0 | 2026-09-09 |
| open/06-evals-benchmarks/swe-bench | pulled | 02e7a74 (2026-09-02) | MIT | 2026-09-09 |
| open/06-evals-benchmarks/inspect-ai | pulled | d2ed535 (2026-09-09) | MIT | 2026-09-09 |
| open/06-evals-benchmarks/openai-evals | pulled | 8eac7a7 (2026-04-14) | MIT | 2026-09-09 |

## 许可证复核要点

- **mcp-spec** 与 **mcp-typescript-sdk**: 处于 MIT→Apache-2.0 迁移期，LICENSE 明确新代码 Apache-2.0，文档 CC-BY-4.0，不能笼统记 MIT。已按 commit 复核。
- **codex**: Apache-2.0，含 NOTICE 与 third_party/wezterm MIT。
- **gemini-cli**: Apache-2.0，含 third_party/get-ripgrep MIT 与 NOTICES.txt。
- **vercel/ai**: Apache-2.0，harness 等子包亦 Apache-2.0。
- **e2b**: 根 Apache-2.0，子包 js-sdk 等 MIT。
- **mem0**: 根 Apache-2.0，但 mem0-ts/src/oss 与 n8n-nodes-mem0 为 MIT。
- **ag-ui**: MIT 全仓一致，子包亦 MIT (除 mastra 集成 Apache-2.0)。
- 其余均与 PULL-LIST 首轮一致，无 enterprise/commercial 混入。

## 可复现命令

```powershell
# 已执行的 25 条 (--depth 1 --single-branch, core.longpaths=true)
git clone --depth 1 --single-branch https://github.com/modelcontextprotocol/modelcontextprotocol.git open/00-protocols/mcp-spec
git clone --depth 1 --single-branch https://github.com/agentclientprotocol/agent-client-protocol.git open/00-protocols/acp
git clone --depth 1 --single-branch https://github.com/ag-ui-protocol/ag-ui.git open/00-protocols/ag-ui
git clone --depth 1 --single-branch https://github.com/a2aproject/A2A.git open/00-protocols/a2a
git clone --depth 1 --single-branch https://github.com/anomalyco/opencode.git open/01-agent-cli-runtimes/opencode
git clone --depth 1 --single-branch https://github.com/openai/codex.git open/01-agent-cli-runtimes/codex
git clone --depth 1 --single-branch https://github.com/block/goose.git open/01-agent-cli-runtimes/goose
git clone --depth 1 --single-branch https://github.com/cline/cline.git open/01-agent-cli-runtimes/cline
git clone --depth 1 --single-branch https://github.com/google-gemini/gemini-cli.git open/01-agent-cli-runtimes/gemini-cli
git clone --depth 1 --single-branch https://github.com/Aider-AI/aider.git open/01-agent-cli-runtimes/aider
git clone --depth 1 --single-branch https://github.com/SWE-agent/mini-swe-agent.git open/01-agent-cli-runtimes/mini-swe-agent
git clone --depth 1 --single-branch https://github.com/openai/openai-agents-js.git open/02-agent-frameworks/openai-agents-js
git clone --depth 1 --single-branch https://github.com/langchain-ai/langgraph.git open/02-agent-frameworks/langgraph
git clone --depth 1 --single-branch https://github.com/pydantic/pydantic-ai.git open/02-agent-frameworks/pydantic-ai
git clone --depth 1 --single-branch https://github.com/vercel/ai.git open/03-provider-model-layer/vercel-ai
git clone --depth 1 --single-branch https://github.com/openai/openai-node.git open/03-provider-model-layer/openai-node
git clone --depth 1 --single-branch https://github.com/anthropics/anthropic-sdk-typescript.git open/03-provider-model-layer/anthropic-sdk-typescript
git clone --depth 1 --single-branch https://github.com/googleapis/js-genai.git open/03-provider-model-layer/google-js-genai
git clone --depth 1 --single-branch https://github.com/modelcontextprotocol/typescript-sdk.git open/04-tools-mcp-sandbox/mcp-typescript-sdk
git clone --depth 1 --single-branch https://github.com/e2b-dev/E2B.git open/04-tools-mcp-sandbox/e2b
git clone --depth 1 --single-branch https://github.com/letta-ai/letta-code.git open/05-session-memory-learning/letta-code
git clone --depth 1 --single-branch https://github.com/mem0ai/mem0.git open/05-session-memory-learning/mem0
git clone --depth 1 --single-branch https://github.com/SWE-bench/SWE-bench.git open/06-evals-benchmarks/swe-bench
git clone --depth 1 --single-branch https://github.com/UKGovernmentBEIS/inspect_ai.git open/06-evals-benchmarks/inspect-ai
git clone --depth 1 --single-branch https://github.com/openai/evals.git open/06-evals-benchmarks/openai-evals
```

## 后续

- `_workspace/research/new-cli-open/` 已隔离，禁止 import/build/package；历史 `open/` 目标不作为新的写入位置。
- 如需历史研究: git -C <target> fetch --unshallow
