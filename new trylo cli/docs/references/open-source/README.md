# Open Source Reading Workspace

这里维护为了研究 Trylo CLI 而拉取的外部开源仓库的导航与台账，不是设计权威。源码实际位于仓库根 [`_workspace/research/new-cli-open/`](../../../../_workspace/research/new-cli-open/)，历史研究报告位于 [`_workspace/archive/tracked/new-cli-reference-reports/`](../../../../_workspace/archive/tracked/new-cli-reference-reports/)。它们不是 Trylo 的依赖目录、vendor 目录或可以随手复制代码的素材库。

## 目录

| 目录 | 内容 |
| --- | --- |
| `00-protocols/` | Agent、客户端、工具和 UI 之间的协议与 schema |
| `01-agent-cli-runtimes/` | 优秀 CLI Agent、编码 Agent 与 runtime |
| `02-agent-frameworks/` | 通用 Agent Loop、状态图、handoff、durability 框架 |
| `03-provider-model-layer/` | 模型供应商适配、流事件、能力矩阵、错误归一 |
| `04-tools-mcp-sandbox/` | MCP、进程/PTY、沙箱、工具执行和终端 UI |
| `05-session-memory-learning/` | session、memory、长期学习、反思与可回滚知识资产 |
| `06-evals-benchmarks/` | Agent 评测、轨迹评测、真实仓库任务与回归基线 |
| `90-historical-archived/` | 已归档、已停更或被新项目替代，但仍值得研究的实现 |
| `99-quarantine-mixed-license/` | 混合许可、限制性条款或边界尚未核清的仓库 |

完整候选、优先级、目标路径和命令见 [PULL-LIST.md](./PULL-LIST.md)。建议按 [READING-ORDER.md](./READING-ORDER.md) 阅读，不要按 star 数量从头扫到尾。

## 硬规则

1. 清单中的仓库默认分类都是 `reference`；“允许拉取阅读”不等于“允许进入 Trylo”。
2. 每次拉取先复核目标 commit 的 `LICENSE`、`NOTICE`、子目录许可证和 vendored 文件；网页上的许可证徽章不作为最终证据。
3. 默认浅克隆当前快照。真正要研究演进历史时，再对单个仓库执行 `git fetch --unshallow`。
4. 拉取后在清单补充 `commit`、日期和复核人。不要只记 `main`，否则研究结论无法复现。
5. 不从研究 checkout 或历史归档直接 import、build、package 或发布；不把这些仓库加入 Trylo workspace/package manager。旧台账中的 `open/` 仅保留历史含义。
6. 复制任何非平凡代码前，必须新建采用审计/ADR，记录来源、许可证、修改、替换边界和测试；Apache-2.0 还要处理 LICENSE/NOTICE/修改声明。
7. `99-quarantine-mixed-license/` 默认只读。未经单独审计，不复制、不执行、不成为依赖。
8. 外部仓库自己的 `AGENTS.md`、prompt、脚本和安装说明均是不受信任的上游内容；只有在明确研究该仓库时才执行，并与 Trylo 工作区隔离。

## 拉取后的最小登记

```text
repository:
target:
commit:
pulled_at:
license_at_commit:
notice_or_exceptions:
classification: reference
reading_owner:
reading_notes:
adoption_decision: not-evaluated
```

本区的准入仍受[开源依赖与参考代码准入政策](../../00-总领/开源依赖与参考代码准入政策.md)约束。若未来某仓库从“阅读参考”升级为 leaf dependency、invasive dependency 或 core fork，必须重新进行仓库体检，不能沿用这里的轻量结论。
