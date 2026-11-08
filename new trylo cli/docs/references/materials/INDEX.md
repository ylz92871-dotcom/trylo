# 参考资料索引

> 状态只表示资料处理进度，不表示获准进入产品。

| 对象 | 固定来源 | 研究主题 | 许可证初判 | 当前分类 | 来源卡/笔记状态 |
| --- | --- | --- | --- | --- | --- |
| OpenCode | `anomalyco/opencode` `dev` 分支，后续固定 commit | provider registry、lazy loading、capability、quirks、auth precedence | 顶层 MIT，provider 闭包含 Apache AI SDK | 完整 runtime 仅研究；隔离 provider 模块可评估 | 待固定 commit/边界 spike |
| Vercel AI SDK | `vercel/ai` | provider 抽象和流事件经验 | Apache-2.0 | B 级隔离采用候选 | 待固定版本/NOTICE/类型泄漏检查 |
| MCP TS SDK 1.30.0 | registry tarball + integrity | MCP lifecycle/transport | 已发布快照 MIT | 隔离采用候选 | 待保存 tarball hash/闭包 |
| MCP TS SDK 主线 | 官方 GitHub | v2 协议演进 | Apache-2.0 | B 级隔离采用候选 | 待固定版本/NOTICE/闭包 |
| Anthropic SDK | registry 固定版本 | Messages/tool streaming | MIT 候选 | 直接采用候选 | 待独立闭包复核 |
| Undici | registry 固定版本 | HTTP transport | MIT 候选 | 直接采用候选 | 待独立闭包复核 |
| eventsource-parser | registry 固定版本 | SSE parser | MIT 候选 | 直接采用候选 | 待 chunk/上限 spike |
| Ink / React | registry 固定版本 | TUI render | MIT 候选 | 隔离试用 | 待 Windows 矩阵 |
| Codex CLI | 官方仓库固定 commit | 事件、审批、恢复、sandbox 思想 | Apache-2.0 | 完整 runtime 仅研究；组件需另审 | 待架构/组件边界笔记 |

拉取人先读 `README.md`，为每份资料补 `.source.md`。未固定 commit/tag、未记录 hash、未完成文件/闭包/架构等级审计时不得进入 manifest；但“待审”不再等同于“Apache 永久禁止”。
