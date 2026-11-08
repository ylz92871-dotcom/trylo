# Trylo CLI 总体施工顺序与学习型 LOOP 候选架构（过程记录，已过期）

> 状态：已替代；仅保存过程记录  
> 替代者：`TRYLO-LEARNING-AGENT-顶层架构与目标.md`（2026-09-14 产品所有者明确指定）  
> 禁止用途：不得再作为新工作包、阶段排序或学习权力的施工依据  
> 阶段：全工程  
> 最后更新：2026-09-08  
> 已稳定：自有核心合同、适配器边界、质量/parity 优先、分阶段追平  
> 未稳定：学习进入 LOOP 的权力、接点、类型与时序；等待 L01 决策

## 先纠正两件事

第一，Apache-2.0 不再全面禁用。核心主权层优先最宽松许可；provider SDK、构建工具、MCP client、遥测和其他可隔离外围可以按 A–E 等级评估 Apache-2.0。详见 `开源依赖与参考代码准入政策.md`。

第二，旧版“双循环 + 四端口 + 八接点”不是已批准架构，只是学习融合候选 B。学习方案必须先完成 `学习内容进入LOOP的边界与时序（过程记录-已过期）.md` 中的 L01 决策，不能由文档作者代替产品所有者拍板。

## Trylo CLI 真正需要自研的核心

“自研”不是每一行都从标准库开始写，而是 Trylo 必须拥有下面这些语义和可替换边界：

- canonical message/content/action/event/error/terminal 协议；
- Agent Loop 的状态机、取消、重试、unknown outcome 与终态所有权；
- Capability/Permission/Approval/Sandbox 的规则与审计；
- session、context、queue、compaction、resume 与崩溃恢复语义；
- provider-neutral request/event 和 capability contract；
- tool、MCP、Skill、Plugin、Hook、Team 的 Trylo 自有 SPI；
- CLI/TUI/headless/Desktop 共用的版本化事件层；
- 学习以什么形式、什么权力影响执行——但该项仍待 L01 决定；
- parity catalog、黄金 trace 和 release qualification 的判定标准。

这些核心可以使用成熟叶子库实现机械能力，但第三方类型和生命周期不能成为事实来源。

## 应当积极复用的成熟轮子

只要许可证、闭包、维护状况和隔离边界通过审计，可以复用：

- provider 官方 SDK、Vercel AI SDK/OpenCode 中可隔离的 provider 能力；
- HTTP/SSE/WebSocket、JSON Schema、JWT/SigV4、文件监听、diff/search；
- MCP SDK、PTY/进程控制、TUI 组件、secret store adapter；
- formatter、compiler、linter、test runner、codegen、CI 与 SBOM 工具；
- observability exporter、benchmark 和故障注入工具。

选择标准不是“MIT 才好、Apache 才差”，也不是“大厂轮子一定重”。标准是：Trylo 是否仍拥有合同，组件是否能独立升级/替换，实际质量是否比自研更可靠，以及发行义务能否自动履行。

## 逻辑架构

```text
Trylo Protocol / Domain Contracts
        ↑
Agent Loop / Permission / Session / Context / Team
        ↑
ProviderPort / ToolPort / ExtensionPort / UIEventPort
        ↑
MIT、Apache-2.0 或其他获准的具体 adapters 与工具链
        ↑
CLI / TUI / Headless / Desktop
```

箭头表示具体实现依赖 Trylo 抽象。UI、provider SDK、学习 store 和外部框架都不能反向定义核心领域类型。

学习目前只保留一个位置：它将来通过获批的最小合同影响 LOOP，而不是成为另一套 runtime。到底是上下文增强、薄控制面还是在线学习 LOOP，尚未决定。

## 稳定的施工顺序与开放的学习插槽

```text
P00 工程地基、质量/许可门禁、parity、协议测试壳
  → L01 学习产品决策 Sprint（可在 P00 后半段准备）
  → P01 Trylo Protocol + 被批准的最小学习合同
  → P02 Provider Kernel + Agent Loop + 一条获批学习纵切
  → P03 Tools / Permission / Artifact Verification / Extension SPI
  → P04 Session / Context / Compaction / Recovery
  → P05 v0.3 外围学习闭环
  → P06 Team Runtime
  → P07 Extension Ecosystem + 完整 CLI 用户面
  → P08 Desktop Cutover + Provider Matrix
  → P09 Release Qualification
```

这里真正稳定的是：先地基和观测，再冻结协议；先跑通 LOOP，再大规模接工具；先证明恢复，再完成依赖真实经历的学习治理；最后切换 Desktop 和发布。

尚未冻结的是：

- L01 最终选择 A、B、C 哪种融合深度；
- P01 需要哪些学习合同；
- P02 的学习纵切改变 context、action、verification 中哪几处；
- v0.3 哪些能力前移，哪些留在 P05；
- P02 是否需要拆成原先设想的 A/B 两段。

这些开放项不会阻止 P00，但会阻止学习核心代码开工。

## P00 无悔地基

P00 只建立无论学习方案如何都需要的事实：

- attempt/action/tool/result/terminal 的 canonical 状态和因果 ID；
- provider/tool/UI 适配边界；
- 权限、审批和 sandbox 的唯一所有者；
- 能保留决策与结果差异的 golden trace；
- 可扩展的 schema/version/compatibility 机制；
- 依赖位置分级、NOTICE/SBOM 和类型泄漏门禁；
- 可读性和可维护性第一门禁。

P00 不创建学习专属正式类型，不规定学习 store，不冻结学习优先级，也不把 v0.3 数据结构复制进 LOOP。

## L01 必须产出的产品决策

L01 不是泛泛开会。它必须逐项回答：

1. 学习只建议，还是能改变工具/步骤/结束条件；
2. 用户明确约定、行为推断和 Agent 经验分别如何生效；
3. 学到的验证能否触发 repair 或阻断 final；
4. 同一任务能否更新临时/长期规则；
5. 原始经历、候选、已晋升资产的边界；
6. 需要哪些归因证据，采集关闭时如何工作；
7. 学习系统失败、超时、撤回、删除时如何降级。

退出物为产品所有者批准的 `ADR-L01-学习进入LOOP的最小权力（过程记录-已过期）.md`、两个端到端用户故事和一个关闭/失败路径。批准前，任何四端口、frozen plan、method guard、journal/generation/CAS 都只是候选实现。

## 学习融合的三个候选

### A. 上下文增强

已筛选记忆进入 context，结果摘要交给环外学习。最轻，但容易停留在 prompt 参数层。

### B. 薄学习控制面

已生效学习可以影响有限决策点，关键行动有归因锚点，部分已批准检查可触发有界 repair；分析、候选、评估和晋升留在外围。当前推荐深入讨论，但未批准。

### C. 在线学习 LOOP

每次 iteration 都可能更新策略或长期资产。适应强，但延迟、恢复、隐私和可重复性风险最高，不建议默认采用。

具体 D1–D7 决策见学习讨论稿。方案 B 之所以值得研究，不是因为旧稿已经写了很多，而是它最有机会同时满足“真实改变行为”和“热路径仍薄”。如果讨论证明 A 更合适，应当舍弃 B；不能因沉没成本继续。

## 各阶段的职责

| 阶段 | 核心交付 | 学习关系 |
| --- | --- | --- |
| P00 | workspace、质量/许可证门禁、parity catalog、golden trace、协议测试壳、Desktop adapter 壳 | 不实现学习语义；只准备 L01 证据 |
| L01 | 七项权力决策、用户/Agent 两条故事、失败/关闭路径 | 决定什么真的进 LOOP |
| P01 | 普通协议、ID/error/state、provider/tool/session/permission contract | 只加入 L01 批准的最小学习合同 |
| P02 | provider-neutral stream、模型/工具循环、取消/重试/fallback | 实现一条获批学习纵切，不预埋整套 v0.3 |
| P03 | 真实工具、权限、artifact、verification、MCP/Skill SPI | 证明学习是否产生超越 prompt 的行为价值 |
| P04 | session/context/compaction/resume/crash recovery | 验证学习启用/关闭/撤回不会破坏恢复 |
| P05 | Episode、分析、候选、实验、晋升、撤回/删除、指标 | 主要位于外围；需要新增 LOOP 权力时重新提 ADR |
| P06 | Team 并发、停止、审批、恢复、成本 | 是否接受 learned routing 由 L01/后续 ADR 决定 |
| P07 | MCP/Skills/Plugins/Hooks 与 CLI/TUI/headless | 扩展不能成为第二状态源 |
| P08 | Desktop 切换、Provider Matrix、完整用户路径 parity | UI 展示事实，不替核心决定学习状态 |
| P09 | 安全、许可、性能、长跑、迁移、最终 v0.3 验收 | 在最终制品上证明真实效果和治理 |

## “追平”判定

“追平现在的样子”不是 UI 显示同名事件或 happy path 可聊天。每项能力必须具备：

1. 行为合同；
2. 黑盒黄金 trace；
3. 错误、取消、拒权、超时、恢复和乱序场景；
4. Desktop 消费验证；
5. 真机/真 provider 证据；
6. 可读性、可维护性、安全、许可证和性能门禁。

能力矩阵区分 `identified → contracted → mock_verified → real_verified → desktop_parity → release_qualified`，禁止用单一百分比掩盖缺口。

## 学习特色的验收方式还需先写成产品故事

至少要证明两件事：

- 用户明确纠正或约定后，下一次真实任务出现可解释、可撤回、可关闭的行为变化；
- Agent 从失败中形成的方法不是模型自夸，而是经过外部证据验证，并能在版本变化或负效果时失效/回滚。

在 L01 结束前，不再列 LL-01…LL-13 这样的“既定验收项”。它们可作为候选 B 的检查素材，但不能倒逼产品选择 B。

## 不做的伪创新

- 不把多塞一段 memory 直接叫学习型 LOOP；
- 不让模型自评后自动晋升长期能力；
- 不在每个工具调用后强制运行重型分析；
- 不把用户画像、store 或 UI 变成第二个调度器；
- 不因 OpenCode、Codex 或某个 SDK 成熟就把它的领域类型当 Trylo 协议；
- 也不因依赖采用 Apache-2.0 就否定成熟实现。

Trylo 的特色最终应该落在一条可证伪的产品判断上：**学习获得了某种外围 memory 做不到的运行时权力，并且这份权力可解释、可验证、可撤回、可关闭，同时没有让 LOOP 失去可维护性。** 这句话是 L01 要验证的目标，不是已经完成的答案。
