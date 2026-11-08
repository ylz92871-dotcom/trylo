# WP16 Plugin-动态工具与延迟搜索

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R6；角色：施工主责
- 主责能力：C49, C54, C55, C56, C83, L08, L54, L55, L59
- 接口前置：[WP14](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP14-Skill与项目指令实际消费.md>)、[WP15](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP15-MCP传输-资源-认证与连接管理.md>)
- 集成联验：[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

安装、搜索、注册、调用和卸载形成可复核闭环。

本包接点/owner边界：**现 catalog/ToolPort；Plugin配置；动态schema边界**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C49 | MCP tool 安全策略/暴露 / P1 | 部分 / contracted | 有描述清洗、审批与工具名边界；缺细粒度暴露和 deferred 策略。 | 复用 Codex MCP exposure/discovery；转为自有 ToolBinding。 |
| C54 | Plugins/marketplace 安装/移除 / P1 | 缺失 / contracted | 无 Plugin bundle、marketplace、安装/卸载和实际消费。 | 直接复用旧 plugins manager/commands；Codex plugins 格式作兼容。 |
| C55 | Apps/connector 工具 / P2 | 部分 / contracted | MCP 可接外部服务；无原生 connector 账户/发现/状态工作流。 | 复用 Codex Apps client/MCP bridge，接 Trylo 自己的账号服务。 |
| C56 | 模型可搜索的延迟工具 / P1 | 缺失 / contracted | 全部工具 schema 进入目录；无按需 tool_search/deferred 加载。 | 取 Codex discovery/schema 或旧 MCP tool search，按模型能力接入。 |
| C83 | 动态工具由客户端提供 / P2 | 缺失 / contracted | 无客户端动态工具声明/调用响应的 app-server 模式。 | 复用 dynamic_tools DTO/机械层，映射自有 ToolPort。 |
| L08 | 工具 allow/deny、按需显露与合并 MCP（共用 C49） / P1 | 部分 / contracted | 有描述清洗、审批与工具名边界；缺细粒度暴露和 deferred 策略。 | 复用 Codex MCP exposure/discovery；转为自有 ToolBinding。 |
| L54 | Plugins/marketplace 安装、卸载、启停、更新、inline plugin-dir（共用 C54） / P1 | 缺失 / contracted | 无 Plugin bundle、marketplace、安装/卸载和实际消费。 | 直接复用旧 plugins manager/commands；Codex plugins 格式作兼容。 |
| L55 | Plugin 贡献 commands/skills/agents/output styles / P1 | 缺失 / contracted | Plugin不能贡献command/skill/agent/style。 | 搬旧plugin loader聚合，接各注册端口。 |
| L59 | deferred tool 搜索、减少工具描述上下文（共用 C56） / P1 | 缺失 / contracted | 全部工具 schema 进入目录；无按需 tool_search/deferred 加载。 | 取 Codex discovery/schema 或旧 MCP tool search，按模型能力接入。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C49**：[C49源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:66>)；`core/src/tools/spec_plan.rs:197` exposure policy；`:210` server policy；`:245` deferred/code-mode；模型 namespace/search 与配置决定；不能全量塞schema；codex-mcp tool policy/discovery，转换成 Trylo tool DTO
- **C54**：[C54源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:71>)；`cli/src/main.rs:1278` plugin，`:1302` marketplace；app-server/src/message_processor.rs:1545 install；features/src/lib.rs:1362 plugins true；常规；plugin bundle可以包含 skills/MCP，不是散装tool registry；`plugin` / `core-plugins` / utils/plugins 边界组件
- **C55**：[C55源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:72>)；`tui/src/chatwidget/slash_dispatch.rs:545` apps；core/src/tools/spec_plan.rs:159 apps_enabled；features/src/lib.rs:1284 apps true；条件：连接的账户/服务；Codex backend相关能力不能靠本地代码凭空获得；通用 MCP bridge + Trylo账户适配
- **C56**：[C56源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:73>)；`core/src/tools/spec_plan.rs:629` supports_search_tool+namespace；`:245` deferred；`:373` search registration；tool_search旧flag已Removed；是否暴露由模型+provider capability决定；`tools` discovery/tool_search schema，减少上下文
- **C83**：[C83源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:100>)；`core/src/tools/handlers/dynamic.rs:117` handler；`app-server/src/dynamic_tools.rs:18` boundary；`app-server-protocol/src/protocol/common.rs:1772` 动态tool调用通知；app-server/client条件；不是全部CLI默认工具；dynamic DTO/provider tool bridge
- **L08**：[L08源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:33>)；普通工具表最终通过 deny 规则与 isEnabled；工具搜索为条件路径；[tools.ts:193](<D:/CC/trylo/trylo cli/src/tools.ts:193>)、[tools.ts:271](<D:/CC/trylo/trylo cli/src/tools.ts:271>)、[tools.ts:333](<D:/CC/trylo/trylo cli/src/tools.ts:333>)、[tools.ts:353](<D:/CC/trylo/trylo cli/src/tools.ts:353>)
- **L54**：[L54源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:79>)；普通 CLI 命令与 operations，用户/项目/local scope；[main.tsx:4196](<D:/CC/trylo/trylo cli/src/main.tsx:4196>)、[main.tsx:4257](<D:/CC/trylo/trylo cli/src/main.tsx:4257>)、[pluginOperations.ts:321](<D:/CC/trylo/trylo cli/src/services/plugins/pluginOperations.ts:321>)、[pluginOperations.ts:427](<D:/CC/trylo/trylo cli/src/services/plugins/pluginOperations.ts:427>)
- **L55**：[L55源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:80>)；普通各 loader 合并；不会单独成为 execution loop；[commands.ts:460](<D:/CC/trylo/trylo cli/src/commands.ts:460>)、[loadAgentsDir.ts:37](<D:/CC/trylo/trylo cli/src/tools/AgentTool/loadAgentsDir.ts:37>)、[loadOutputStylesDir.ts:11](<D:/CC/trylo/trylo cli/src/outputStyles/loadOutputStylesDir.ts:11>)
- **L59**：[L59源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:84>)；provider 支持与运行时条件；默认 auto 阈值为上下文的 10%；[toolSearch.ts:45](<D:/CC/trylo/trylo cli/src/utils/toolSearch.ts:45>)、[tools.ts:249](<D:/CC/trylo/trylo cli/src/tools.ts:249>)、[claude.ts:1164](<D:/CC/trylo/trylo cli/src/services/api/claude.ts:1164>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP16.1 Plugin 最小闭包

施工：取旧 plugins 的发现/配置/装载机械层，经现配置源提供 skill/MCP/agent/style 描述。

验收：固定版本来源与依赖；加载失败不半注册；卸载能回收连接/资源而非只删 UI 项。

### WP16.2 延迟工具搜索

施工：复用现成 deferred/tool-search 算法，转换成 canonical catalog，保持 schema版本和注册代次。

验收：模型先搜索后真实调用；未暴露/卸载工具不能执行；schema冲突/迟到调用拒绝。

### WP16.3 扩展消费与并发更新

施工：Skill 走 WP14，agent 走 WP22，style 走 WP23；固定请求快照后切换下一代。

验收：安装与卸载跨包实际验证；注册不等于消费；并发更新不改已经派发请求的含义。

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
