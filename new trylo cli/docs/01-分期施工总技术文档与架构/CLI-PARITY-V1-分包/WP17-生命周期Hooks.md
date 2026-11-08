# WP17 生命周期Hooks

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R6；角色：施工主责
- 主责能力：C57, L62, L63
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>)、[WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>)
- 集成联验：[WP14](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP14-Skill与项目指令实际消费.md>)、[WP15](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP15-MCP传输-资源-认证与连接管理.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用配置匹配和执行适配，接真实生命周期并保持权限统一。

本包接点/owner边界：**HookInvocation/Result 边界；既有runner；Session事件**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C57 | 生命周期 Hooks / P1 | 缺失 / contracted | 方法学习的 hook 标签不是用户配置的生命周期 Hooks。 | 直接复用旧 hooks 执行器/配置；或 Codex hooks crate 窄进程桥。 |
| L62 | 生命周期 hooks：tool/permission/stop/prompt/session/compact/subagent/task（共用 C57） / P1 | 缺失 / contracted | 方法学习的 hook 标签不是用户配置的生命周期 Hooks。 | 直接复用旧 hooks 执行器/配置；或 Codex hooks crate 窄进程桥。 |
| L63 | hooks 执行器：command/prompt/agent/HTTP；file-change/CWD/指令载入/worktree / P1 | 缺失 / contracted | 无command/prompt/agent/HTTP hook runners。 | 取hooks执行器/schema/matcher，沿新版权限端口。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C57**：[C57源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:74>)；`features/src/lib.rs:1168` hooks Stable true；`core/src/thread_manager.rs:734` refresh_hook_runtimes；tui/src/chatwidget/slash_dispatch.rs:480 /hooks；配置了 hooks 才执行；旧 plugin_hooks flag已Removed；`hooks` crate + hook runtime adapter
- **L62**：[L62源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:87>)；普通 hooks runtime；`--bare` 跳过；允许 blocking/追加上下文等结构化结果；[hooks.ts:3394](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:3394>)、[hooks.ts:3450](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:3450>)、[hooks.ts:3639](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:3639>)、[hooks.ts:3826](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:3826>)、[hooks.ts:3867](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:3867>)
- **L63**：[L63源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:88>)；相关执行器与入口存在；部分事件/类型仍按配置或 feature 判断，不能所有默认运行；[execPromptHook.ts](<D:/CC/trylo/trylo cli/src/utils/hooks/execPromptHook.ts>)、[execAgentHook.ts](<D:/CC/trylo/trylo cli/src/utils/hooks/execAgentHook.ts>)、[execHttpHook.ts](<D:/CC/trylo/trylo cli/src/utils/hooks/execHttpHook.ts>)、[hooks.ts:4260](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:4260>)、[hooks.ts:4928](<D:/CC/trylo/trylo cli/src/utils/hooks.ts:4928>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP17.1 配置与事件映射

施工：取旧 hooksConfigManager/Snapshot/hookEvents 的最小闭包，列明 Session/tool/compact 触发点。

验收：同一事件一次触发、顺序稳定、过滤匹配正确；协议事件与旧全局 context 隔离。

### WP17.2 命令与HTTP hook

施工：command 走现授权与Process，HTTP走注入网络端口，返回观察/阻断/注入的显式合同。

验收：拒权、取消、超时、非零退出/HTTP失败给终局；hook不能绕授权执行副作用。

### WP17.3 prompt 与Agent hook

施工：复用 execPromptHook/execAgentHook 外围，通过 provider/子代理端口执行，限制递归和并发。

验收：真实注入影响后续请求；递归/卸载/关闭有界；Agent hook 联验 WP22 后才标对应能力完成。

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
