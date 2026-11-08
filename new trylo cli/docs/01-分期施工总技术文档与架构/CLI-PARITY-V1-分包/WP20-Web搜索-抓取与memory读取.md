# WP20 Web搜索-抓取与memory读取

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R9；角色：施工主责
- 主责能力：C58, C60, L20, L21, L51
- 接口前置：[WP12](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP12-搜索-LSP与IDE导航.md>)、[WP18](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP18-Provider-认证-Responses与结构化输出.md>)
- 集成联验：[WP14](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP14-Skill与项目指令实际消费.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP24](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP24-Headless-诊断-输出样式与工作流入口.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用现成搜索/抓取和记忆读取工具，提供可追溯实际内容。

本包接点/owner边界：**只读ToolPort；内容上下文；来源与截断metadata**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C58 | 缓存/实时网络搜索 / P1 | 缺失 / contracted | web_fetch 只抓给定 URL，不提供 cached/live web search 与引用。 | 复用 Codex hosted search；支持上游搜索工具的 Anthropic/Vertex/Foundry 路径直接取旧 WebSearch；其他兼容端点接真实搜索服务 adapter。 |
| C60 | memory检索与上下文 / P2 | 部分 / contracted | 新版学习/知识代码已有；没有同等可选择的独立 memory 读取/工具面。 | 仅复用 Codex memories 的检索/上下文叶子，保留 Trylo 学习所有权。 |
| L20 | URL 抓取、网页内容处理 / P1 | 部分 / contracted | URL文本fetch有；缺网页prompt处理/缓存/二进制材料引用。 | 取WebFetchTool内容处理、缓存及材料引用。 |
| L21 | 网页搜索（共用 C58） / P1 | 缺失 / contracted | web_fetch 只抓给定 URL，不提供 cached/live web search 与引用。 | 复用 Codex hosted search/扩展 adapter；非 Responses 服务走旧 WebSearch 实现。 |
| L51 | 本地 memory 与自动 memory 读取 / P2 | 部分 / contracted | 学习/知识代码有；memory维护/读取入口不等价。 | 取memory/context读写叶子，接现有学习/隐私所有者。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C58**：[C58源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:75>)；`core/src/tools/spec_plan.rs:613` cached/live/disabled hosted tool；`:1038` standalone gate；`core/src/config/mod.rs:3693` 默认Cached；条件：provider web_search；默认缓存搜索，live需选择；standalone_web_search UnderDevelopment false（ResponsesLite 另分支）；hosted provider tool adapter 或 `ext/web-search`；没有通用离线搜索
- **C60**：[C60源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:77>)；`ext/memories/src/extension.rs:48` memories+use_memories；`:138` dedicated_tools gate；app-server/src/extensions.rs:110 install；memories Stable 默认 false；是可选记忆能力，不能等同于Trylo完整学习闭环；memory read/context叶子；不替代Learning Board
- **L20**：[L20源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:45>)；普通 WebFetch；域名权限，返回处理后的内容及二进制落盘引用；[tools.ts:207](<D:/CC/trylo/trylo cli/src/tools.ts:207>)、[WebFetchTool.ts:104](<D:/CC/trylo/trylo cli/src/tools/WebFetchTool/WebFetchTool.ts:104>)、[WebFetchTool.ts:208](<D:/CC/trylo/trylo cli/src/tools/WebFetchTool/WebFetchTool.ts:208>)
- **L21**：[L21源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:46>)；provider 条件：firstParty、指定 Vertex Claude 4 系列、Foundry；其他 provider 返回 false；[tools.ts:209](<D:/CC/trylo/trylo cli/src/tools.ts:209>)、[WebSearchTool.ts:168](<D:/CC/trylo/trylo cli/src/tools/WebSearchTool/WebSearchTool.ts:168>)
- **L51**：[L51源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:76>)；普通 memory/context 模块；自动提取不是本次已证明的学习闭环；[context.ts:155](<D:/CC/trylo/trylo cli/src/context.ts:155>)、[claudemd.ts:381](<D:/CC/trylo/trylo cli/src/utils/claudemd.ts:381>)、[memory.ts:5](<D:/CC/trylo/trylo cli/src/utils/memory.ts:5>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP20.1 搜索与来源

施工：取旧 WebSearch 与 Codex 搜索接口，保留查询、实际来源、时间与失败结果。

验收：真实查询返回可核查来源；provider 不支持时明确 unavailable；不能返回伪造搜索结果。

### WP20.2 抓取与内容处理

施工：复用旧 WebFetch 的解析/缓存机械层，通过网络端口保持取消、大小与类型上限。

验收：重定向、失败、超大和非文本有明确结果；实际正文进入工具结果，来源信息保留。

### WP20.3 memory读取

施工：按基线复用运行上下文记忆读取/项目记录入口，经现上下文合同消费。

验收：真文件/记录改变后续任务上下文；这包不改变学习沉降、资产治理与写权限。

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
