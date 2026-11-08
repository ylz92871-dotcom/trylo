# WP18 Provider-认证-Responses与结构化输出

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R9；角色：施工主责
- 主责能力：C68, C69, C70, C71, C74, L05, L67, L68, L69
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)
- 集成联验：[WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>)、[WP15](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP15-MCP传输-资源-认证与连接管理.md>)、[WP19](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP19-多模态-图像-语音与computer-use.md>)、[WP20](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP20-Web搜索-抓取与memory读取.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP24](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP24-Headless-诊断-输出样式与工作流入口.md>)、[WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用成熟 provider/auth 实现并保留现有国模路径。

本包接点/owner边界：**现 ProviderPort/CredentialPort；能力协商；流事件转换**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C68 | Provider自定义与本地模型 / P1 | 部分 / contracted | 自定义 Chat Completions 端点有；缺 Responses 和相应本地/native 路径。 | 新增 Codex Responses adapter；保留现有国模路径，旧 provider 工具可补。 |
| C69 | 认证/登录/退出 / P1 | 部分 / contracted | API key、多账户、PKCE/refresh 已有；官方订阅/device 登录未证明。 | 直接复用 Codex login/device/auth/secure store 的完整账户接线。 |
| C70 | 模型目录/能力驱动工具 / P1 | 部分 / contracted | 模型声明/选择菜单有；能力集仅 streaming/reasoning/tools/cancellation。 | 复用 model catalog/capability DTO：输入模态、窗口、reasoning effort、工具类型。 |
| C71 | 响应重试/连接恢复 / P1 | 部分 / contracted | 发流前有界重试和401 refresh已有；缺 Responses/WS 及连接降级。 | 取 codex-api/client 传输模块，保持明确 before/after stream 语义。 |
| C74 | 结构化最终输出/最后消息文件 / P1 | 部分 / contracted | output-last-message 有；无 schema 约束的结构化最终输出。 | 复用 Codex exec output_schema 接线；ProviderRequest 增 response schema。 |
| L05 | API 错误重试、退避及模型 fallback / P1 | 部分 / contracted | 有重试/401刷新，无可配置fallback模型。 | 取services/api/withRetry与fallback resolver。 |
| L67 | JSON schema 约束输出、系统 prompt 替换/追加（结构化输出共用 C74） / P1 | 部分 / contracted | output-last-message 有；无 schema 约束的结构化最终输出，也缺系统 prompt replace/append 的用户入口。 | 复用 Codex exec output_schema 接线，ProviderRequest 增 response schema；搬旧 prompt 拼装及 CLI flags，保留新版项目规则冻结。 |
| L68 | Anthropic 原生与兼容 endpoint、Bedrock/Vertex/Foundry / P1 | 缺失 / contracted | 真实provider仅Chat Completions家族。 | 搬services/api/client/claude及Anthropic/Bedrock/Vertex/Foundry adapters。 |
| L69 | OAuth/API Key 登录/状态/注销与 doctor/update / P1 | 部分 / contracted | API key/多账户/PKCE/doctor已有；订阅device登录与发布渠道update未闭合。 | 取旧/Codexauth与update外围，连接Trylo自身账户/交付渠道。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C68**：[C68源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:85>)；`model-provider-info/src/lib.rs:570` builtins OpenAI/Bedrock/Ollama/LMStudio；`:609` merge configured；常规配置；wire_api只有Responses（`:75`），明确拒绝chat（`:97`）；Responses adapter局部；国模Chat Completions优先旧Trylo
- **C69**：[C69源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:86>)；`cli/src/main.rs:1588` login、`:1632` logout；`model-provider/src/auth.rs:211` scoped auth；常规；API key/ChatGPT/device/Bedrock等各自路径；login/secret storage外围；账户backend能力不假冒
- **C70**：[C70源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:87>)；`core/src/thread_manager.rs:815` models；core/src/tools/spec_plan.rs:1255/:629；tui/src/chatwidget/slash_dispatch.rs:310 model popup；常规；reasoning/input/tools等按模型目录声明；模型capability DTO，避免所有模型暴露同一工具
- **C71**：[C71源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:88>)；`model-provider-info/src/lib.rs:30` idle timeout、`:35` retry cap；`core/src/client.rs:250` session HTTP fallback；`core/src/responses_retry.rs:44` retry handler；常规；WebSocket按provider supports_websockets；不是全部provider同一传输；`codex-api`/client transport局部或成熟provider SDK
- **C74**：[C74源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:91>)；`exec/src/lib.rs:900` output_schema；`:932` last_message/output_schema条件；`exec/src/cli.rs:69` --output-last-message；常规flag；schema约束与生命周期终态不是质量checker；复用非交互输出合同和文件writer
- **L05**：[L05源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:30>)；普通 retry；fallback 模型需配置；持续无人值守 retry 是编译开关；[withRetry.ts:62](<D:/CC/trylo/trylo cli/src/services/api/withRetry.ts:62>)、[withRetry.ts:100](<D:/CC/trylo/trylo cli/src/services/api/withRetry.ts:100>)、[query.ts:692](<D:/CC/trylo/trylo cli/src/query.ts:692>)、[query.ts:912](<D:/CC/trylo/trylo cli/src/query.ts:912>)
- **L67**：[L67源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:92>)；普通 CLI 参数，结构化输出应走对应终态而非普通字符串约定；[main.tsx:1024](<D:/CC/trylo/trylo cli/src/main.tsx:1024>)、[main.tsx:1036](<D:/CC/trylo/trylo cli/src/main.tsx:1036>)
- **L68**：[L68源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:93>)；分支按 env/config；provider SDK 与凭据路径独立；[client.ts:89](<D:/CC/trylo/trylo cli/src/services/api/client.ts:89>)、[client.ts:213](<D:/CC/trylo/trylo cli/src/services/api/client.ts:213>)、[client.ts:243](<D:/CC/trylo/trylo cli/src/services/api/client.ts:243>)、[client.ts:337](<D:/CC/trylo/trylo cli/src/services/api/client.ts:337>)
- **L69**：[L69源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:94>)；普通命令；更新器面向原应用发行体系，不能只改名称直接用于新包；[main.tsx:4148](<D:/CC/trylo/trylo cli/src/main.tsx:4148>)、[main.tsx:4394](<D:/CC/trylo/trylo cli/src/main.tsx:4394>)、[main.tsx:4410](<D:/CC/trylo/trylo cli/src/main.tsx:4410>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP18.1 认证与模型配置

施工：抽取旧认证/provider 与 Codex login/catalog 外围，配置和密钥由现端口拥有。

验收：login→provider声明→doctor→首个真实工具任务闭环；account ID匹配，错误不拖到首跑才暴露。

### WP18.2 Responses 与流事件

施工：直接复用本地版本实际存在的 Responses 传输解析，经 canonical stream 转換；现兼容路径保留。

验收：真实 endpoint 确认 /responses；工具流、usage、断流、取消及 partial delivery 正确；app-server不是ProviderPort。

### WP18.3 结构化输出与能力差异

施工：声明 schema/effort/上下文/媒体支持，支持才发送，拒绝/降级有显式结果。

验收：结构化输出实际守约；不支持 JSON schema 的模型不冒称支持；配置变更由WP02迁移。

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
