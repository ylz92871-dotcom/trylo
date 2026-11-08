# WP21 用户问答-Plan-Task与Goal生命周期

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R7；角色：施工主责
- 主责能力：C27, C28, C29, C30, C61, L22, L23, L24, L25
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP08](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP08-运行中输入-steer与排队.md>)、[WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>)
- 集成联验：[WP19](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP19-多模态-图像-语音与computer-use.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用问答和任务工具，让用户回答与计划真正控制后续执行。

本包接点/owner边界：**UserInputPort；Task/Goal状态owner；现Permission独立**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C27 | 用户 Todo/Plan 工具 / — | 已有 / contracted | 有 todo_write 的 pending/in_progress/completed 列表。 | 沿用新版 todo；持久任务和 Plan mode另见 C28/L增量。 |
| C28 | Plan 模式 / P1 | 缺失 / contracted | /mode 是权限模式，不能替代“先计划、再执行”的 Plan mode。 | 取 Codex collaboration-mode 模板或旧 Enter/ExitPlanMode。 |
| C29 | 结构化向用户提问 / P1 | 缺失 / contracted | 无专门的多选/文本向用户提问工具。 | 复用 request_user_input DTO/表单；TS 优先旧 AskUserQuestion。 |
| C30 | 异步用户提问/消息 / P2 | 缺失 / contracted | 无异步提问、回答到达后继续工作的用户消息协议。 | 取 Codex async 用户输入合同，接新版输入队列；按模型能力启用。 |
| C61 | 持续 Goal/预算与生命周期 / P2 | 部分 / contracted | 有单轮预算；无持续 Goal 工具、跨轮目标和预算生命周期。 | 取 ext/goal 状态/预算模块，映射自有任务事实；与学习分开。 |
| L22 | 模型主动多选问用户（共用 C29） / P1 | 缺失 / contracted | 无专门的多选/文本向用户提问工具。 | 复用 request_user_input DTO/表单；TS 优先旧 AskUserQuestion。 |
| L23 | Todo 列表（共用 C27） / — | 已有 / contracted | 有 todo_write 的 pending/in_progress/completed 列表。 | 沿用新版 todo；持久任务和 Plan mode另见 C28/L增量。 |
| L24 | Task 创建、读取、更新、列举与依赖/认领 / P1 | 缺失 / contracted | todo不是持久Task CRUD；缺依赖/认领/锁。 | 搬utils/tasks+TaskCreate/Get/Update/List，store根注入。 |
| L25 | 进入计划与退出计划审批（共用 C28） / P1 | 缺失 / contracted | /mode 是权限模式，不能替代“先计划、再执行”的 Plan mode。 | 取 Codex collaboration-mode 模板或旧 Enter/ExitPlanMode。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C27**：[C27源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:44>)；`core/src/tools/spec_plan.rs:1142` update_plan_enabled → PlanHandler；`core/src/config/mod.rs:2665` resolver；显式配置启用，默认 false；与 Plan mode 不是同一概念；`handlers/plan` 状态与呈现；复用旧 Trylo todo
- **C28**：[C28源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:45>)；`tui/src/chatwidget/slash_dispatch.rs:318` apply_plan_slash_command；`core/src/thread_manager.rs:826` mode masks；普通模式选择；旧 collaboration_modes flag 已 Removed true，不能说仍需实验开启；collaboration-mode-templates + 模式合同
- **C29**：[C29源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:46>)；`core/src/tools/spec_plan.rs:1158` RequestUserInputHandler；`handlers/request_user_input`；条件：experimental_request_user_input_enabled；默认只 Plan，DefaultModeRequestUserInput 为 UnderDevelopment false；提问 DTO + TUI 选择表单；不把权限审批混进去
- **C30**：[C30源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:47>)；`core/src/tools/spec_plan.rs:1167` request_user_input_async；`:1192` send_message_to_user_async；条件：root agent + 模型 experimental_supported_tools；不能计为全部默认模型共有；async notification/answer contract
- **C61**：[C61源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:78>)；`app-server/src/extensions.rs:85` install Goal；`:93` goals flag；`ext/goal/src/extension.rs:104` persistent state/review exclusion；goals Stable true；token_budget另外UnderDevelopment false；不是“completion即质量通过”；Goal state/accounting，映射Trylo自有任务预算
- **L22**：[L22源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:47>)；普通交互工具；channels 场景按 isEnabled 避免无人看终端的挂起；[tools.ts:211](<D:/CC/trylo/trylo cli/src/tools.ts:211>)、[AskUserQuestionTool.tsx:135](<D:/CC/trylo/trylo cli/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:135>)、[AskUserQuestionTool.tsx:209](<D:/CC/trylo/trylo cli/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:209>)
- **L23**：[L23源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:48>)；Task V2 未启用时启用 TodoWrite；与 Task CRUD 是替代显示路径，不是默认两套同开；[tools.ts:208](<D:/CC/trylo/trylo cli/src/tools.ts:208>)、[TodoWriteTool.ts:52](<D:/CC/trylo/trylo cli/src/tools/TodoWriteTool/TodoWriteTool.ts:52>)
- **L24**：[L24源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:49>)；交互默认启用；非交互需 `CLAUDE_CODE_ENABLE_TASKS`；状态落盘、claim 加锁；[tools.ts:217](<D:/CC/trylo/trylo cli/src/tools.ts:217>)、[tasks.ts:133](<D:/CC/trylo/trylo cli/src/utils/tasks.ts:133>)、[TaskCreateTool.ts:80](<D:/CC/trylo/trylo cli/src/tools/TaskCreateTool/TaskCreateTool.ts:80>)、[tasks.ts:536](<D:/CC/trylo/trylo cli/src/utils/tasks.ts:536>)
- **L25**：[L25源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:50>)；普通 EnterPlanMode/ExitPlanModeV2；plan 是权限模式/执行约束；[tools.ts:202](<D:/CC/trylo/trylo cli/src/tools.ts:202>)、[tools.ts:213](<D:/CC/trylo/trylo cli/src/tools.ts:213>)、[commands.ts:331](<D:/CC/trylo/trylo cli/src/commands.ts:331>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP21.1 问答请求与回答

施工：取 AskUserQuestion schema、校验与视图，以独立requestId管理多选/自由答/取消/EOF。

验收：答案进入后续模型/动作；重复/迟到回答拒绝；答案绝不当作动作授权。

### WP21.2 Plan 与 Task CRUD

施工：复用旧 Plan/Task 工具和 Codex plan 机械层，冻结状态转换、依赖与持久身份。

验收：计划→执行真实推进；任务创建/更新/读取/阻塞原因可见；task completed不能代替验证通过。

### WP21.3 Goal 与中断恢复

施工：沿用普通任务生命周期，区分用户暂停、预算中断、取消和质量完成。

验收：恢复后原目标与约束仍在；不因预算耗尽宣称成功；Goal不能成为新增学习调度器。

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
