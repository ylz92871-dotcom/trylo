# WP15 MCP传输-资源-认证与连接管理

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R6；角色：施工主责
- 主责能力：C46, C47, C48, C50, L56, L57, L58
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>)、[WP18](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP18-Provider-认证-Responses与结构化输出.md>)
- 集成联验：[WP16](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP16-Plugin-动态工具与延迟搜索.md>)、[WP17](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP17-生命周期Hooks.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用传输和资源管理，真实 server 工具及资源可消费。

本包接点/owner边界：**现 McpClient；CredentialPort；资源读取；Permission owner**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C46 | MCP stdio 与 HTTP / — | 已有 / contracted | MCP stdio、HTTP/SSE 注册、tools/list/call/cancel 已接线。 | 保留现有 McpClientPort；增加协议面见 C47–C50。 |
| C47 | MCP OAuth/凭据管理 / P1 | 缺失 / contracted | 通用 provider OAuth 不是 MCP HTTP server 的 OAuth 登录/登出。 | 直接复用 rmcp-client MCP OAuth/凭据 adapter。 |
| C48 | MCP resources/templates/read / P1 | 缺失 / contracted | 缺 MCP resources/templates/read；当前只挂工具。 | 复用 mcp_resource handlers/rmcp transport，增加资源工具。 |
| C50 | MCP 状态/刷新/elicitation / P1 | 部分 / contracted | 有配置清单和每轮重新打开；无同等 TUI status/refresh/elicitation。 | 复用 rmcp client 与状态/刷新 UI；保留现有取消和超时合同。 |
| L56 | MCP 配置 CRUD、strict config、导入 desktop、serve / P2 | 部分 / contracted | MCP CRUD有；strict配置/desktop导入/serve无。 | 搬旧MCP配置/导入/serve handlers。 |
| L57 | MCP stdio/SSE/Streamable HTTP/WebSocket/IDE 连接 / P1 | 部分 / contracted | stdio/HTTP/SSE有；WebSocket/IDE transport缺。 | 搬services/mcp/client对应transport。 |
| L58 | MCP OAuth/资源/prompts/elicitation/连接管理 / P1 | 部分 / contracted | 已有连接管理、list/call/cancel；MCP prompts/resources/OAuth/elicitation 用户链未接全。 | 搬 MCPConnectionManager/auth/elicitationHandler/prompt loader，接现有 MCP 客户端。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C46**：[C46源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:63>)；`cli/src/mcp_cmd.rs:111` stdio/http shape；`:220` run；`core/src/tools/spec_plan.rs:159` append_mcp_tools；常规配置能力；startup、transport、工具注册是真的接线；`rmcp-client` / codex-mcp 的传输adapter，Trylo McpClientPort
- **C47**：[C47源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:64>)；`cli/src/mcp_cmd.rs:71` login、`:72` logout；app-server/src/message_processor.rs:1632 oauth dispatch；条件：HTTP server OAuth支持；OAuth client/credential adapter；无需再造协议
- **C48**：[C48源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:65>)；`core/src/tools/spec_plan.rs:1128` 三资源 handler（有servers才注册）；core/src/tools/handlers/mcp_resource；常规；与 tool/call 是不同能力；resource handlers + rmcp transport
- **C50**：[C50源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:67>)；`tui/src/chatwidget/slash_dispatch.rs:542` /mcp；app-server/src/message_processor.rs:1635 reload、`:1638` status；core/src/session/handlers.rs:133 resolve_elicitation；常规工具清单/刷新；部分新MCP协议 flags UnderDevelopment；rmcp client + 明确刷新和用户问题协议
- **L56**：[L56源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:81>)；普通 MCP CLI；desktop 导入明确限 Mac/WSL；[main.tsx:3942](<D:/CC/trylo/trylo cli/src/main.tsx:3942>)、[main.tsx:3993](<D:/CC/trylo/trylo cli/src/main.tsx:3993>)、[main.tsx:1048](<D:/CC/trylo/trylo cli/src/main.tsx:1048>)
- **L57**：[L57源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:82>)；普通 connector 有各分支；实际启用依赖配置、认证与服务器；[client.ts:595](<D:/CC/trylo/trylo cli/src/services/mcp/client.ts:595>)、[client.ts:619](<D:/CC/trylo/trylo cli/src/services/mcp/client.ts:619>)、[client.ts:784](<D:/CC/trylo/trylo cli/src/services/mcp/client.ts:784>)、[client.ts:944](<D:/CC/trylo/trylo cli/src/services/mcp/client.ts:944>)
- **L58**：[L58源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:83>)；普通配置后路径；资源工具不是无条件常驻模型表，按特殊工具处理；[tools.ts:245](<D:/CC/trylo/trylo cli/src/tools.ts:245>)、[tools.ts:309](<D:/CC/trylo/trylo cli/src/tools.ts:309>)、[MCPConnectionManager.tsx](<D:/CC/trylo/trylo cli/src/services/mcp/MCPConnectionManager.tsx>)、[auth.ts](<D:/CC/trylo/trylo cli/src/services/mcp/auth.ts>)、[elicitationHandler.ts](<D:/CC/trylo/trylo cli/src/services/mcp/elicitationHandler.ts>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP15.1 传输与连接

施工：复用 Codex rmcp/connection 管理与旧 MCP 外围，保持 stdio/HTTP 生命周期、版本和错误映射。

验收：真实 server 启动/断连/重连/关闭有效；超时和迟到响应不跨代串线。

### WP15.2 OAuth 与资源

施工：将凭据放唯一 CredentialPort，连接资源列表/模板/读取和确实存在的 OAuth 接口。

验收：过期/拒绝/回调失败可恢复；资源内容确实进入任务上下文；日志不包含密钥。

### WP15.3 动态 catalog 与调用

施工：注册工具/资源 schema 后实际调用，授权走统一 Permission，不从 server 自报完成推质量。

验收：连接切换/卸载停止工具；server 错误和 unknown delivery 保留；资源读取不绕路径权限。

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
