# WP08 运行中输入-steer与排队

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R2；角色：施工主责
- 主责能力：C03, C41, C82, L42
- 接口前置：[WP01](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP01-耐久会话与未知动作核对.md>)、[WP07](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP07-取消-进程树清理与输出限额.md>)
- 集成联验：[WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>)、[WP21](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP21-用户问答-Plan-Task与Goal生命周期.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

让运行中追加要求实际改变后续操作，并保留正确顺序。

本包接点/owner边界：**现 pendingInput owner；turn 输入命令；队列投影**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C03 | 运行中补充输入/steer / P0 | 未接全 / contracted | 核心有队列；运行中的 TUI 没有继续读用户输入。 | 取 Codex turn_input/input_queue 接到新版既有队列。 |
| C41 | 背景消息队列 / P2 | 未接全 / contracted | 库有输入队列；无持久后台消息排队/CLI queue 工作流。 | 取 ext/queue 的命令/状态形状，接已有队列与单 writer。 |
| C82 | Composer运行中排队与草稿恢复 / P0 | 未接全 / contracted | TUI 运行中 queue/steer/草稿恢复未贯通。 | 复用 input_queue/draft，与 C03 同一输入所有者交付。 |
| L42 | 运行中提交额外消息/排队（共用 C03） / P0 | 未接全 / contracted | 核心有队列；运行中的 TUI 没有继续读用户输入。 | 取 Codex turn_input/input_queue 接到新版既有队列。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C03**：[C03源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:20>)；`core/src/session/turn_input.rs:202` 分派；`:242` start_or_steer；`app-server/src/request_processors/turn_processor.rs:254`；常规；有 expected turn ID 和显式提交结果；`turn_input` + `tui/src/chatwidget/input_queue` 合同
- **C41**：[C41源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:58>)；`cli/src/main.rs:1514` Queue；app-server-protocol/src/protocol/common.rs:631–666 queue RPC；CLI 普通入口；细分 queue RPC 显式 Experimental；`ext/queue` + 唯一 writer 队列模型
- **C82**：[C82源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:99>)；tui/src/bottom_pane/chat_composer.rs:382` Queued result、`:459` action；tui/src/chatwidget/input_queue.rs`；常规输入能力；队列提交与steer不混同；queue/draft状态机合同、Trylo Repl唯一writer
- **L42**：[L42源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:67>)；普通 REPL 持有消息队列；不需退出当前命令再重开；[REPL.tsx:625](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:625>)、[REPL.tsx:3889](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:3889>)、[messageQueueManager.ts](<D:/CC/trylo/trylo cli/src/utils/messageQueueManager.ts>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP08.1 输入队列与 turn 身份

施工：复用旧输入队列和 Codex turn_input/input_queue 语义，关联 expected turn ID。

验收：旧 turn 的迟到输入不污染新 turn；排队有界；接收/拒绝/取消明确。

### WP08.2 steer 进入请求视图

施工：在已批准边界消费新输入并冻结下次 provider/tool 请求，不在渲染层改执行状态。

验收：真实多步任务途中追加约束，后续命令/文件变更遵循；不能只测试 UI 显示新消息。

### WP08.3 终态竞态与恢复

施工：处理完成同时到达输入、取消后排队、重连重复投递和恢复后的未消费输入。

验收：每条输入最多被消费一次，接受后不无声丢弃；取消与排队结果可恢复。

## 4. 前置与跨包交接

接口前置包只交其被本包消费的稳定合同、真实adapter与证据，必须写清输入输出、失败/取消、兼容和版本；不要等待其全包所有条目验收。允许先做本包来源闭包、合同和红例工作，不能在依赖未接通时伪造功能成功。

本包给下游交：上述接点的真实实现、版本化合同与负例、适用平台结果、来源hash、变更/回滚patch和未闭合项。集成联验里的每个实际消费者须有调用链和行为证据；尚未连接的ID保持partial，最终由WP27汇总、WP28实机签收。

## 5. 纪律复核、风险与回滚

实现人和独立reviewer依 [统一代码纪律](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 逐项检查：可读性维护性、唯一owner/类型、权限不扩大、错误终局、取消清理、提交后unknown、迟到/重复事件、持久化守卫、类型隔离和兼容。新增回归先留红，工程检查不提高原阈值；许可证按用户豁免不查。

直接抽取不允许复制旧runtime的大状态总管或把Codex core当普通Provider。source_missing、外部服务/模型/平台限制分别记录，不能以fixture替代真实账户与安装包。回滚按本包固定基线生成patch，保留用户原dirty改动、旧会话及兼容路径；若格式已经写盘，按迁移合同处理，不能删记录假装从未执行。

## 6. 必须提交的材料

1. 按 [单包交接模板](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 填完整的施工记录，归档到P00工程产出；说明本包实际接通哪些ID。
2. 每根线的合同与来源闭包账、未修代码红例、适用检查日志、独立review发现与修复/复验。
3. 真实入口到副作用/输出/持久事实的证据；平台、provider、安装和TTY做了哪些及未做哪些。
4. 主矩阵中具体ID的证据更新、风险/缺件/未闭合项、rollback patch、可供下一包消费的接口版本。

包内任务逐根收口，文档“已批准”只代表本范围可施工，不代表代码完成。全量追平必须通过WP27与WP28，不以子任务completed或绿色单测替代。
