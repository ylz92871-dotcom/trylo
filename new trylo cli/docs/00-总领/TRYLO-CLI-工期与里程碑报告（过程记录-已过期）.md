# Trylo CLI 工期与里程碑报告（过程记录，已过期）

> 状态：已替代；仅保存过程记录  
> 替代依据：`TRYLO-LEARNING-AGENT-顶层架构与目标.md`。旧报告中把学习作为待选插槽、按传统 CLI 阶段后置的部分已失效；其中质量、恢复、权限和发布门禁仍可作为历史估算素材。  
> 基线起点：2026-09-09  
> 估算口径：完整追平当前 Trylo 实际用户路径与 CLI 用户面，并完成学习 v0.3、Team、Desktop 切换和分级许可证合规；不是 MVP  
> 最后更新：2026-09-08

## 可以确定的结论

除学习融合细节外，施工的大阶段依赖关系已经稳定：

```text
P00 无悔地基 → L01 学习产品决策 → P01 普通协议/获批的最小学习合同 → P02 Provider/Agent LOOP/一条学习纵切
       → P03 工具权限与验证 → P04 会话恢复
       → P05 完整学习闭环 / P06 Team / P07 扩展生态与 CLI 用户面
       → P08 Desktop 切换 → P09 发布资格
```

四个持续工作流从 P00 开始贯穿全程，不能留到收尾：parity harness、Desktop 事件适配、Provider Matrix、完整发行拓扑的许可证/SBOM 审计与整改。许可门禁分两级：`quality:new-cli` 从 P00 起必须全绿并持续阻断；`audit:release-topology` 在 P00 允许输出 RED backlog，但每项必须有 owner、处置和最迟 gate，P08 前清零，P09 对最终实物重扫。Apache-2.0 在获准的非核心等级可以通过；未知、未批准限制性许可、NOTICE 缺失和核心边界渗透仍然阻断。

允许变化的是每一期内部任务拆分、具体实现选择、学习融合方案和并行度；不允许通过调序把权限地板、崩溃恢复或 parity 证明推迟成后补丁。学习合同只有在 L01 获批后才成为顺序约束。

## 学习接入的确切时间（修订）

- P00：只铺不依赖学习语义的地基；禁止创建旧稿中的正式学习类型。推荐三人配置目标为第 5–8 个有效工作日退出。
- L01：P00 后立即进行产品决策 Sprint；可在 P00 后半段提前准备用户故事和 throwaway spike。目标用 3–5 个有效工作日逐项决定学习的运行时权力，而不是直接冻结旧稿字段。
- P01：只把 L01 批准的最小语义写成合同。若 L01 未获批，普通 Protocol 工作可继续，学习合同不进入主分支。
- P02：Provider/Agent LOOP 开工，同时只实现一条获批的学习纵切；当前目标仍约为三人配置第 3 工程周开始，但会随 L01 选择 A/B/C 调整。
- P03：用真实工具、权限和 checker 验证这条纵切是否产生了超越 prompt 注入的价值；没有证据就收窄，不以沉没成本保留。
- P05：完成 v0.3 外围 Episode、分析、候选、评估、晋升、撤回/删除和指标；若需要新增 LOOP 权力，重新提交 ADR，不预先禁止也不允许反向渗透。

因此最核心的讨论在 L01（P00 后立刻）发生；P01 才把结论合同化，P02 编码，P03 用真实执行证明价值。改变的是“先讨论再写类型”，不是把学习推到中后期。

## 阶段计划

人周表示一个有经验工程师一周的有效产能，不等同于自然周。

| 阶段 | 估算 | 主要内容 | 学习关系 | 不可妥协的退出标准 |
| --- | ---: | --- | --- | --- |
| P00 工程地基 | 3–5 人周 | 完整发行拓扑/工具链 ADR、workspace、质量门禁、测试框架、parity catalog/golden trace、UI adapter skeleton | 不实现或预埋具体学习语义；只保留 canonical 事实 | `quality:new-cli` 全绿；许可分类/NOTICE/边界门禁可执行；至少 8 类合成任务产生真实、脱敏、可重放 trace |
| L01 学习产品决策 Sprint | 0.6–1 人周 | A/B/C 方案、D1–D7、用户学习与 Agent 学习两条故事、关闭/失败路径、throwaway spike | **核心讨论与拍板** | 产品所有者批准 `ADR-L01`；未批准字段不得进入 P01 |
| P01 Trylo Protocol 与最小学习合同 | 1.5–2.5 人周 | 消息、内容块、事件、错误、ID、状态机、tool/permission/session/attempt、ProviderConfig/CredentialSource/model registry；仅加入 L01 获批合同 | **把决策合同化** | CLI/Desktop 共享 fixtures；普通运行合同不依赖学习系统；获批学习语义有最小合同测试 |
| P02 Provider Kernel + Agent LOOP | 4–5.5 人周 | provider-neutral 流、流式工具循环、取消/重试/usage/fallback；实现一条获批学习纵切 | **核心实现开始并跑通** | 真 provider 路径通过；学习关闭/故障时基础 LOOP 可用；纵切能证明实际影响和归因 |
| P03 Tools、权限、产物验证与扩展 SPI | 4–5 人周 | read/search/edit/write/shell/agent；路径、审批、sandbox、截断、artifact；MCP/Skill 核心端口、版本钉住、权限衰减 | **完成非 prompt 化行为闭环** | 攻击/故障测试；副作用与取消清楚；required checks 可驱动 repair；扩展不能绕过权限地板 |
| P04 Session、Context、Compaction 与恢复 | 3–4 人周 | 多会话隔离、运行日志、resume、queue、compaction、warm process fingerprint、崩溃恢复 | 保证获批学习能力在启用/关闭/撤回时不破坏恢复 | 不盲目重放已确认或结果不确定的副作用；不确定状态进入 `unknown/reconcile_required` |
| P05 v0.3 环外学习闭环 | 5–7 人周 | Episode/linker、证据、分析、candidate、实验、晋升、Skill activation、迁移/GC、指标 | **从经历产生经治理的后续影响** | L01 选择对应的验收项通过；后台故障不阻塞；新增 LOOP 权力必须另行 ADR |
| P06 Team Runtime | 4–5 人周 | profile/run 冻结、成员身份、并发、停止、审批、恢复、成本、写者隔离 | 根 attempt 归因；后期加入已晋升 team routing | 禁止 nested spawn；权限只衰减；乱序/取消/恢复/聚合测试；只有用户明确开始才运行团队 |
| P07 扩展生态 + CLI 用户面 | 5–7 人周 | P07-A MCP/Skills/Plugins/Hooks；P07-B commands、login/config 编辑体验、OS secret-store adapter、交互 TUI、非交互 NDJSON、stdin/stdout/exit code、终端恢复 | 加载固定版本 promoted skill | P01/P02 provider config/credential 合同不重写；扩展生命周期、CLI/TUI/headless 用户路径追平；依赖闭包获准 |
| P08 Desktop 切换与 UX parity | 4–6 人周 | 主路径切到新 CLI；聊天、工具卡、审批、附件、结果坞、学习、Team、恢复；完成 Provider Matrix | UI 展示事实回执，不反向决定学习状态 | 无双写/双状态源；冻结 catalog 内全部 provider `real_verified`；全部当前用户路径 parity；发行包和真机验证通过 |
| P09 发布资格 | 3–4 人周 | 完整能力矩阵、安全、SBOM、性能、长跑、恢复、迁移/回滚、可复现构建；最终发行物重跑 v0.3 M01–M20 | 学习效果与治理最终验收 | M01、M17–M20 及所有 Desktop/package 相关项在最终发行拓扑重跑；M01–M20 全绿；无未关闭 P0/P1才标 RC |

上述新 CLI、学习、Team、CLI 用户面和 Desktop 集成本体约 **37–52 人周**。Apache-2.0 放宽后，不再预留“替换全部 Apache 工具链”的 6–12 人周；当前只预留 **3–7 人周**处理未知、强 copyleft、NOTICE/SBOM、类型渗透和最终制品差异。完整产品暂定 **40–59 人周**，P00 发行拓扑审计和 L01 方案选择后重新校准。

## 人员与自然工期

### 推荐配置：3 名核心工程师

在当前范围下，现实基线修订为 **22–30 个自然周**；以 2026-09-09 开始机械计算约为 2027-02-10 至 2027-04-07，假期、人员中断、L01 反复和真 provider 审批会顺延。Apache 放宽减少的是无谓替换工作，不减少 parity、恢复、安全和质量工作。

建议三条主线：

1. Kernel 线：Protocol、Provider、Agent Loop、Session/Recovery；
2. Execution 线：Tools、Permissions、MCP/Skill SPI、Team；
3. Evidence 线：parity、Provider Matrix、Desktop adapter、ExperienceStore、learning worker、全发行拓扑许可整改与 release audit。

P01 合同必须共同评审。P02 前半先用一个 provider 做纵切，避免多人同时扩展 provider 把未稳定的 LOOP 固化成偶然实现。

### 单人全职

当前范围下单人现实基线修订为 **45–64 个自然周**。L01 选择更深的在线学习方案会增加工期；选择上下文增强方案会减少学习核心工作，但必须重新确认是否仍满足产品特色目标。

### 范围放大条件

若“追平”被改成追踪外部 CLI 的全部隐藏、历史或未进入 Trylo 当前用户路径的能力，需先建立新增能力清单，预计再增加 **12–18 人周**。这不改变施工依赖顺序，只扩大 P02–P09 的工作量。

## 并行图

```text
工程周     01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20+

Kernel     P00  L01/P01 ── P02 ───── P03 ───── P04 ───── hardening
Evidence   P00 parity/adapter/provider-matrix/new-cli-license ─ release
Learning       L01 decide  P01 contract  P02 slice ── P05 outer loop
Execution              P03 tools/SPI ─── P06 Team ── P07-A ecosystem
CLI surface                                      P07-B ─────── P08 → P09
Desktop    release-topology audit(RED allowed) / remediation ── P08 zero → P09 rescan
```

这里的格子是并行窗口，不是允许跳过依赖。普通 Protocol 可以与 L01 后段并行，但学习合同和生产实现必须等待 `ADR-L01`；P05 完整效果闭环仍需等待 P02/P03/P04 的真实事件、工具和恢复语义稳定。

明确依赖为：`P00 → L01 → 学习合同/纵切`；`P02 + P03 + P04 → P05`；`P03 + P04 → P06 core`；是否需要 `P05 → learned team routing` 由 L01/后续 ADR 决定；`P03 SPI → P07-A`；`P02–P07 + 发行合规 → P08 → P09`。

## 里程碑与退出门

| 里程碑 | 目标窗口 | 可演示结果 | 不能拿来冒充完成的东西 |
| --- | --- | --- | --- |
| M0 地基生效 | P00 结束 | 一个故意违规依赖和一个架构越界都能被 CI 拒绝 | 只有目录和空脚本 |
| L1 学习权力获批 | L01 结束 | A/B/C 选择、D1–D7、用户/Agent 两条故事和关闭路径获批 | 作者自行写下的接口草图 |
| M1 合同冻结 | P01 结束 | Desktop/CLI fixture 双向合同测试；provider config/credential 与获批最小学习合同 | 把旧稿字段原样搬入 |
| M2 首条学习纵切 | P02 中段 | fixture 下学习产生 L01 所定义的可观察行为变化，且可关闭/降级 | prompt 多了一段文字但无产品价值证据 |
| M3 核心 LOOP 完成 | P02 结束 | 多工具、取消、重试、降级、终态；学习关闭时仍可工作 | happy-path 聊天 |
| M4 执行安全闭环 | P03 结束 | PermissionGate 阻断越权；获批学习影响与真实工具/验证协作；artifact 可证明 | Agent 自述“已检查” |
| M5 可恢复运行时 | P04 结束 | 故障注入、resume、compaction、warm invalidation；unknown 副作用需 reconcile | 正常退出后重新打开 |
| M6 学习 v0.3 | P05 结束 | 经历生成并晋升新资产，下一任务采用；CLI host 可执行验收通过 | 单次 demo 的偶然好结果或提前宣称 M01–M20 最终全绿 |
| M7 Team | P06 结束 | 并发与停止/恢复可控，根 attempt 可归因 | 多开几个进程 |
| M8 扩展生态与 CLI 用户面 | P07 结束 | MCP/Skill/Plugin/Hook 生命周期和权限一致；commands/config/auth/TUI/headless JSON 可用 | 能连接一个 server 或只有内核 API |
| M9 Desktop parity | P08 结束 | 当前 Trylo 主路径无旧 runtime 双写 | UI 看起来一样 |
| M10 Release candidate | P09 结束 | 安全、许可、性能、恢复、迁移及最终 M01–M20 全证据 | 测试数量很多 |

## 施工顺序变更规则

以下高层依赖视为稳定，学习内部架构除外：

- P00 质量/许可/parity 先于生产实现；
- L01 先于学习正式合同和生产实现；
- P01 只冻结 L01 已批准的最小学习协议；
- P02 用一条纵切验证价值，不预埋整套未决定方案；
- P03 才允许大量工具与扩展落地；
- P04 先证明恢复，再完成依赖其事件的学习归因；
- P08 前持续做 Desktop adapter，而非一次性大爆炸切换；
- Provider Matrix 从 P02 持续到 P08，当前用户路径里的 provider 不能无 ADR 延后；
- P09 不与功能开发混为同一“最后一周”。

只有发现合同事实错误、许可证不可接受、真实平台能力不成立或关键安全模型改变，才允许提议跨阶段换序。提议必须附影响分析、替代路径、迁移方案和新的退出证据。

## 估算如何校准

P00 起每周记录：完成的合同点、有效测试场景、返工来源、review 等待时间、真机阻塞和新增未知项。每两周滚动更新剩余人周，但退出标准保持不变。若连续两次预测偏差超过 25%，必须拆分过大工作包或重估范围，不能只改截止日期掩盖问题。
