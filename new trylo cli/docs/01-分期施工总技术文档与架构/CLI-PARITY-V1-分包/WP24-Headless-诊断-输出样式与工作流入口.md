# WP24 Headless-诊断-输出样式与工作流入口

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R8；角色：施工主责
- 主责能力：C72, C73, C86, L48, L66, A08, A12
- 接口前置：[WP02](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP02-会话管理-fork与配置迁移.md>)、[WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>)、[WP11](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP11-diff-review-checkpoint与范围回退.md>)、[WP18](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP18-Provider-认证-Responses与结构化输出.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)
- 集成联验：[WP16](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP16-Plugin-动态工具与延迟搜索.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)、[WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用可用命令与样式，机器入口和交互入口共享执行事实。

本包接点/owner边界：**CLI入口；headless协议；现diagnostic服务**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C72 | headless exec / — | 已有 / contracted | headless run、stdin 文本、预算、退出码已有。 | 保留现有 run 入口；增加子命令时复用 Codex/旧命令外围。 |
| C73 | JSONL machine输出 / — | 已有 / contracted | stream-json 实时机器输出与 run_result 已有。 | 继续投影 Trylo Protocol，不创建第二种核心事件。 |
| C86 | 安装健康诊断/自动补全/升级 / P1 | 部分 / contracted | doctor 和三种 shell completion 已有；缺完整升级/渠道/包交付。 | 复用 cli doctor/completion/update 外围；发布清单排除测试与fixture。 |
| L48 | Output styles：用户/项目 Markdown 风格 prompt / P2 | 缺失 / contracted | 无Output styles发现/选择。 | 搬outputStyles loader/frontmatter parser。 |
| L66 | 非交互文本/JSON/流 JSON、双向流输入及 partial chunks / P1 | 部分 / contracted | stream-json有；无同等多消息双向stream输入。 | 取print双向流/partial adapter，接既有队列。 |
| A08 | Workflow scripts、终端捕获、context inspect/snip / P3 | 缺失 / contracted | 无Workflow scripts/terminal capture/context inspect-snip。 | 取旧对应tools/commands，接进程/context边界。 |
| A12 | remote managed settings / snapshot chooser / P3 | 基线缺件 / contracted | remote managed settings/security/snapshot chooser有固定结果/空UI。 | 取DTO/client，接真实管理服务/选择器，不能搬固定成功。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C72**：[C72源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:89>)；`cli/src/main.rs:1229` exec→`exec/src/lib.rs:259` run_main、`:820` run_exec_session；普通命令；headless默认AskForApproval::Never（exec/src/lib.rs:568），不能等待交互审批；CLI exec事件适配、终态/退出合同
- **C73**：[C73源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:90>)；`exec/src/lib.rs:842` Json EventProcessor；exec/src/cli.rs --json；常规；stdout逐条JSONL，human output另processor；`exec/event_processor_with_jsonl_output`映射Trylo Protocol
- **C86**：[C86源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:103>)；`cli/src/main.rs:1644` completion、`:1652` update、`:1660` doctor；普通CLI命令；具体升级方式按发行渠道；doctor/completion/installer外围，复用旧Trylo渠道
- **L48**：[L48源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:73>)；普通 loader；`/output-style` 已弃用，入口改 `/config`；[loadOutputStylesDir.ts:14](<D:/CC/trylo/trylo cli/src/outputStyles/loadOutputStylesDir.ts:14>)、[loadOutputStylesDir.ts:26](<D:/CC/trylo/trylo cli/src/outputStyles/loadOutputStylesDir.ts:26>)、[output-style/index.ts:5](<D:/CC/trylo/trylo cli/src/commands/output-style/index.ts:5>)
- **L66**：[L66源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:91>)；普通 print；流 JSON 在 print 要 `--verbose`；不等于本地TTY/UI；[main.tsx:1024](<D:/CC/trylo/trylo cli/src/main.tsx:1024>)、[print.ts:455](<D:/CC/trylo/trylo cli/src/cli/print.ts:455>)、[print.ts:787](<D:/CC/trylo/trylo cli/src/cli/print.ts:787>)
- **A08**：[A08源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:111>)；`WORKFLOW_SCRIPTS` / `TERMINAL_PANEL` / `CONTEXT_COLLAPSE` / `HISTORY_SNIP`；[tools.ts:110](<D:/CC/trylo/trylo cli/src/tools.ts:110>)、[tools.ts:113](<D:/CC/trylo/trylo cli/src/tools.ts:113>)、[tools.ts:123](<D:/CC/trylo/trylo cli/src/tools.ts:123>)、[tools.ts:129](<D:/CC/trylo/trylo cli/src/tools.ts:129>)
- **A12**：[A12源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:115>)；本地重建有 stub，安全检查返回固定结果，不能宣称云端管理/快照流程完整；[securityCheck.jsx.ts:1](<D:/CC/trylo/trylo cli/src/services/remoteManagedSettings/securityCheck.jsx.ts:1>)、[SnapshotUpdateDialog.ts:1](<D:/CC/trylo/trylo cli/src/components/agents/SnapshotUpdateDialog.ts:1>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP24.1 Headless 与诊断

施工：取旧 print/诊断入口外围，保持新版CLI参数、stdout/stderr、事件流和exit合同。

验收：无TTY真实工具任务/取消/错误/恢复可解析；诊断不泄露凭据；机器消费者不会收到UI噪声。

### WP24.2 输出样式与工作流

施工：复用旧 outputStyles 和实际存在 workflow/context inspect/snip 的输入输出机械层。

验收：样式真正消费但不改权限/执行事实；工作流有真实运行结果；开关关闭保留旧行为。

### WP24.3 managed settings缺件

施工：核查 A12 固定安全检查与 chooser stub，列明本地可用部分与缺失云端服务。

验收：stub 保持 source_missing，不用固定安全结果当实测；未找到两基线实装前不能验收对应ID。

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
