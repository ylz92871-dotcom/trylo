# WP11 diff-review-checkpoint与范围回退

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R4；角色：施工主责
- 主责能力：C20, C21, C38, C75, L37
- 接口前置：[WP02](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP02-会话管理-fork与配置迁移.md>)、[WP10](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP10-多文件patch与精确修改.md>)
- 集成联验：[WP13](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP13-PDF与Notebook读写.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP24](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP24-Headless-诊断-输出样式与工作流入口.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

审阅真实变更，并仅回退本任务负责的范围。

本包接点/owner边界：**Checkpoint/Review 服务；Session owner；TUI投影**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C20 | 每轮净 diff 追踪 / P0 | 缺失 / contracted | 缺本轮所有已发生改动的净 diff 汇总。 | 取 turn_diff_tracker 算法；用新版 turn ID 与实际写入事实。 |
| C21 | 用户 /diff（含未跟踪） / P0 | 缺失 / contracted | TUI 无 /diff 或整体变更审阅。 | 复用 Codex Git diff 入口及旧 StructuredDiff 组件。 |
| C38 | 会话回滚 / P1 | 缺失 / contracted | 没有按轮回退对话历史；文件 restore 是另一条能力。 | 取 thread/rollback 语义，沿新版 journal 增追加回退事实。 |
| C75 | exec恢复/fork与review / P1 | 部分 / contracted | 已有按 ID 的 headless resume；没有专门 review target/base/commit/uncommitted 和 exec fork 工作流。 | 直接取 Codex exec resume/fork 外围、review prompts/target resolver；复用旧 review/PR 命令外围。 |
| L37 | 文件 checkpoint、diff、rewind / P0 | 部分 / contracted | 写前checkpoint与独立restore有；TUI diff/rewind/对话回退未成闭环。 | 取旧fileHistory的diff/restore与rewind视图；继续自有快照writer。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C20**：[C20源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:37>)；`core/src/turn_diff_tracker.rs:47`、`:49` TurnDiffTracker；消费 committed patch delta；常规；不是仅最后一个 patch 文案；diff tracker 算法，Trylo 自有轮次 ID
- **C21**：[C21源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:38>)；`tui/src/chatwidget/slash_dispatch.rs:444` get_git_diff→DiffResult；`tui/src/slash_command.rs:125` 用户说明；常规 Git 仓库；失败可见；旧 Trylo Git/UI 若已成熟优先；Codex workspace command runner 可参照
- **C38**：[C38源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:55>)；`app-server-protocol/src/protocol/common.rs:741` thread/rollback；`core/src/session/handlers.rs:254` drop turns；常规 RPC；回滚历史与回退磁盘文件不能混为一谈；rollback 合同、Trylo checkpoint 继续自有
- **C75**：[C75源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:92>)；`exec/src/cli.rs:150` subcommands；`cli/src/main.rs:1245` Review；`exec/src/cli.rs:274` ReviewArgs；常规；review支持base/commit/uncommitted；不是只让模型“看看代码”；review prompts+target resolver，映射Trylo审查工具
- **L37**：[L37源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:62>)；交互默认开；SDK/print 需 env；只能恢复已跟踪的编辑，不是任意 shell 副作用回滚；[fileHistory.ts:63](<D:/CC/trylo/trylo cli/src/utils/fileHistory.ts:63>)、[fileHistory.ts:86](<D:/CC/trylo/trylo cli/src/utils/fileHistory.ts:86>)、[fileHistory.ts:347](<D:/CC/trylo/trylo cli/src/utils/fileHistory.ts:347>)、[REPL.tsx:4912](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:4912>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP11.1 diff 与 review

施工：复用 Codex diff_tracker/delta 和旧 StructuredDiff，领域给 canonical diff，UI只显示。

验收：新增/删改/移动、二进制和部分写入呈现真实；review 结果不等于未经执行的修复。

### WP11.2 checkpoint 与 rewind

施工：复用旧 fileHistory 机械层，绑定实际写入前后事实与用户原有 dirty 状态。

验收：回退不抹用户原修改；无 Git、冲突文件和删除/移动可解释；失败不静默全仓 reset。

### WP11.3 会话审阅入口

施工：将 turn diff、检查结果、历史定位和范围回退接命令与 TUI。

验收：用户能从具体 turn 看到实际 diff/失败并选择回退；重启后的 checkpoint 可核对。

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
