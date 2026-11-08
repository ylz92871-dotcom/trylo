# WP12 搜索-LSP与IDE导航

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R5；角色：施工主责
- 主责能力：C22, C23, C24, L09, L16, L60, L61
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>)
- 集成联验：[WP13](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP13-PDF与Notebook读写.md>)、[WP19](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP19-多模态-图像-语音与computer-use.md>)、[WP20](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP20-Web搜索-抓取与memory读取.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用文本/文件搜索和 LSP 子系统，证明实际项目导航。

本包接点/owner边界：**read-only ToolPort；搜索服务；LSP进程 owner**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C22 | 文件提及与模糊查找 / P1 | 部分 / contracted | @文本文件已有；没有模糊选择器/交互文件搜索。 | 直接构建 codex-file-search，接新版 mention/picker。 |
| C23 | ignore-aware 搜索 / — | 已有 / contracted | 新版已有局部 .gitignore、受控子树和 include/exclude。 | 沿用现有导航事实；file-search 只补增量文件名查找。 |
| C24 | 模型本地读/grep/glob / — | 已有 / contracted | 新版 read/list/search/glob 已覆盖本地读与查找。 | 保留现有工具；完整 shell 接入后自然使用 rg 等程序。 |
| L09 | 读取文本，按 offset/limit 读取（共用 C24） / — | 已有 / contracted | 新版 read/list/search/glob 已覆盖本地读与查找。 | 保留现有工具；完整 shell 接入后自然使用 rg 等程序。 |
| L16 | Glob 文件匹配与 Grep 内容检索 / P1 | 部分 / contracted | regex/glob/ignore有；规模仍受walker限额。 | 取GrepTool/utils/ripgrep，注入rg程序路径。 |
| L60 | LSP 定义、引用、hover、符号、实现、调用图 / P1 | 缺失 / contracted | 无LSP定义/引用/hover/符号/实现/调用图。 | 搬LSPTool+LSPClient/ServerInstance/ServerManager。 |
| L61 | IDE 自动连接、选区与 IDE 日志 / P1 | 缺失 / contracted | 无真实IDE自动连接/选区/IDE日志链。 | 搬IDE MCP transport与selection UI。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C22**：[C22源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:39>)；`tui/src/chatwidget/slash_dispatch.rs:470` @ 入口；`file-search/src/lib.rs:164` create_session、`:297` run；常规；这是用户文件选择能力，不是内置 grep_content 模型工具；`codex-file-search` 最适合直接隔离复用
- **C23**：[C23源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:40>)；`file-search/src/lib.rs:111` ignore 范围、`:130` respect_gitignore 默认 true、`:211` worker；常规；跨 root、增量查询可复用；file-search walker/matcher/session
- **C24**：[C24源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:41>)；`core/src/tools/spec_plan.rs:1032` 加 shell；`:1137` utility 注册不包含 read_file/grep/glob；Codex 主要通过完整 shell + rg 等实现，不能把仓库 crate 都计为模型工具；完整 shell 即可复用系统工具；Trylo 现有 read/search 保留
- **L09**：[L09源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:34>)；普通工具；文件路径与读取权限校验；[tools.ts:203](<D:/CC/trylo/trylo cli/src/tools.ts:203>)、[FileReadTool.ts:227](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:227>)
- **L16**：[L16源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:41>)；普通工具；有嵌入搜索时用相应 shell 工具替代；[tools.ts:201](<D:/CC/trylo/trylo cli/src/tools.ts:201>)
- **L60**：[L60源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:85>)；条件：`ENABLE_LSP_TOOL` + LSP 已连接；9 个操作；[tools.ts:224](<D:/CC/trylo/trylo cli/src/tools.ts:224>)、[LSPTool.ts:61](<D:/CC/trylo/trylo cli/src/tools/LSPTool/LSPTool.ts:61>)、[LSPTool.ts:137](<D:/CC/trylo/trylo cli/src/tools/LSPTool/LSPTool.ts:137>)、[LSPTool.ts:224](<D:/CC/trylo/trylo cli/src/tools/LSPTool/LSPTool.ts:224>)
- **L61**：[L61源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:86>)；普通 `--ide`/`/ide`，有 IDE MCP transport；需实际 IDE 服务；[main.tsx:1048](<D:/CC/trylo/trylo cli/src/main.tsx:1048>)、[REPL.tsx:836](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:836>)、[client.ts:708](<D:/CC/trylo/trylo cli/src/services/mcp/client.ts:708>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP12.1 文件与文本搜索

施工：取 Codex file-search bin 与旧 ripgrep 查询/结果闭包，分别提供文件名与文本语义。

验收：大仓库、ignore、中文、超限和无命中正确；文件名搜索不冒充 grep；二进制路径显式配置。

### WP12.2 LSP 生命周期

施工：取旧 LSPClient/ServerInstance/Manager 和 schema/formatter，进程、cwd与权限通过端口。

验收：真实语言服务器定义/引用/hover/符号返回项目事实；不存在/退出/超时有类型化失败。

#### 2026-10-04 L60 依赖路线实际复核

采用复用路线：接入 `vscode-jsonrpc` 与适配版本的 `vscode-languageserver-protocol`，不以“零新依赖”为目标自写 JSON-RPC 传输层。当前新版 package.json 没有这两个直接依赖；旧 `src/services/lsp/LSPClient.ts` 实际使用 `vscode-jsonrpc/node.js` 的 `createMessageConnection`、`StreamMessageReader`、`StreamMessageWriter`，协议包在该文件为 `import type`。Microsoft 上游明确分别将两包定位为底层消息协议与 TypeScript LSP 协议定义，见 [官方仓库](https://github.com/microsoft/vscode-languageserver-node)。此记录选定接线方向，未安装依赖、未证明 LSP 可用。

##### 2026-10-04 施工人实测更正（依赖已装，探针已跑）

上一节的「协议包在该文件为 `import type`」只对旧 `LSPClient.ts` 成立，对**当前锁定版本**不成立。实测三条，均可复核：

- **依赖归类更正：协议包必须进 `dependencies`，不得进 `devDependencies`。** `vscode-languageserver-protocol@3.18.4` 实际导出 288 个**运行时值**（含 `CancellationTokenSource`、`ErrorCodes`、`AbstractMessageReader` 等），不是纯类型声明。按上一节「存在运行时常量即必须作为运行时依赖」的规则，它归运行时依赖。
- **导入入口更正：`vscode-jsonrpc/node.js` 在 9.x 已不存在。** 旧 CLI 的 `from 'vscode-jsonrpc/node.js'` 在当前 `exports` 映射下抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`；正确入口是 `vscode-jsonrpc/node`（无 `.js`）。旧源码照抄会直接崩，这一处是抽取时必须改的。
- **生命周期事实：必须先 `connection.listen()` 才能发请求。** 旧 `LSPClient` 用的是不同版本，未显式暴露此约束；9.0.3 在 `listen()` 前调用 `sendRequest` 抛 `Error: Call listen() first.`。这是接线顺序的硬约束，不是风格问题。

选定版本与闭包（`vscode-jsonrpc@9.0.3` + `vscode-languageserver-protocol@3.18.4` + `vscode-languageserver-types@3.18.4`）：**三者单一版本、无重复解析**。选 `3.18.4` 而非文档曾提的 `3.17.5`，因为后者把 `vscode-jsonrpc` 精确钉在 `8.2.0`，与顶层 9.0.3 会装两份——正是「版本冲突和升级劳动」那行要避免的情况。实测安装 3 包、1 046 004 字节、122 文件，无额外传递依赖。

已通过的有界探针：

- **真实 stdio JSON-RPC 往返**：`initialize` 取回真实 capabilities，`textDocument/hover` 取回真实结果，`PROBE_OK`。证明库能驱动真实语言服务器，不只是握手。
- **懒加载确实成立**：空闲启动时 `require.cache` 中 LSP 模块数 = **0**；动态 `import('vscode-jsonrpc/node')` 后 = **16**，本次 import 耗时 **50.67ms**（Node 22.22.2 / win32-x64 / 单次样本）。这是「普通命令启动时间」那行的实测证据；懒加载降低启动与驻留成本，**不**降低磁盘安装体积。

未验证范围：尚未对真实语言服务器（如 typescript-language-server）跑六操作；尚未测安装前后体积对比；尚未测同项目连接复用与异常退出清理。这些留给 WP12.2/2.3 按上表交证据。

- 先复核旧锁文件/实际包与抽取代码的 API 兼容关系，记录新版精确版本与传递依赖闭包；旧源注释中出现版本号不等于当前已安装版本。协议包若全闭包仅 type import 可作为开发依赖；存在运行时常量、schema 或其他值导入时必须作为运行时依赖。不要额外引入 VS Code extension host 或整套 languageclient。
- 复用旧 Client/ServerInstance/Manager 的必要机械闭包，调整为 Trylo 的进程、授权、日志、配置和生命周期接点；上游类型仅留在 adapter，核心消费 Trylo 合同。语言服务器启动也需要授权，LSP 查询工具只读不代表启动进程无需授权；服务器请求修改工作区不得绕过现有权限与写入工具。
- 使用真实语言服务器先做有界探针：initialize/initialized、文档同步、definition 或 hover，再验证其余 L60 操作。探针是复用路线的验证步骤，不是自行开发传输层的另一个包，也不能仅握手就签收 L60。
- 负例覆盖：分片/连续帧与 Unicode、并发请求和取消、服务器异常退出及 pending 请求终结、启动不存在/拒权、超时、shutdown/exit 与进程清理。消息大小、输出及诊断队列须有明确限额；已有库负责 framing/消息关联，Trylo 负责配置、资源上限与错误合同。
- 按仓库纪律先保留未修代码红例，再留真实项目导航、失败与隔离安装证据。依赖许可证按用户既有指示不查，版本兼容、架构边界和代码质量门禁仍须完成。

#### L60 降低依赖成本的施工约束与证明

目标是在保持 L60 完整交付范围的前提下，减少包体、启动、资源、升级与替换成本。下列措施是 WP12.2 的交付要求；本节只是施工合同，尚未执行安装、测量或优化。代码纪律优先于为了省依赖数量而制造私有协议实现。

| 成本 | 具体降本办法 | 施工人须提交的证明 |
| --- | --- | --- |
| 安装与发布体积 | 只保留客户端实际消费的两包及必要传递闭包，不带 VS Code extension host、整套 languageclient 或上游开发工具。协议包全闭包仅类型引用时放 devDependencies；任何运行时值引用出现时重新归类。语言服务器由明确配置选择，不给普通 CLI 安装自动塞入多语言服务器全集。 | `npm ls vscode-jsonrpc vscode-languageserver-protocol vscode-languageserver-types` 的树；实际 import 清单；相同构建口径下 CLI 发布包及生产依赖安装后的总字节数、文件数前后对比。仅比较 tarball 会漏掉安装后生产依赖，必须分别报告。 |
| 版本冲突和升级劳动 | 选择与抽取代码及当前 Node/TS 兼容的一组精确版本，提交 lockfile。直接使用的 jsonrpc 与 protocol 的依赖约束尽量对齐，确认能复用同一解析版本；不能用强制 override 掩盖不兼容。升级按安全修复、兼容性问题或确有需要的能力触发，并做一次集中的依赖变更。 | 实际解析版本及依赖路径；若仍有多版本，解释消费者和不能合并的原因；升级 diff、受影响回归与回滚 patch。检查生产依赖安全问题；许可证按用户决定不查。 |
| 普通命令启动时间 | 在首次实际使用 LSP 时动态加载运行时库并启动服务器。复用 WP12 的单一生命周期 owner，避免 CLI 启动就拉起语言服务器。不得把包设成可选依赖后静默缺功能。 | 禁用/未用 LSP 的真实 CLI 启动没有服务器子进程且没有触发 LSP 运行时模块加载；同机同 Node 条件下首次查询与后续查询时间。懒加载降低启动和驻留成本，不降低磁盘安装体积。 |
| 内存、子进程和故障处理 | 在批准的项目/服务器配置身份范围内复用连接；配置变更或不同工作区不能误共享。同一 owner 管理 in-flight 请求、退出、取消和清理。将启动/请求超时、最大并发、输入消息字节数、诊断/日志保留、服务器数量及空闲清理规则收口为一份明确配置，并说明每项的超限结果；复用既有配置/限额合同，不建第二套管理器。 | 并发查询没有重复启动；异常退出使 pending 请求全部终结；取消/空闲清理释放资源，后续查询可按合同重新启动；超限负例与进程退出证据。输入消息限额必须在完整大消息分配前生效：先确认库所选版本的 reader 能力，否则只补必要的有界读取适配，不能另写一套 JSON-RPC 解析器。 |
| 核心耦合与未来替换 | 库类型、连接对象、取消 token 和错误对象只存在于 LSP adapter；转成 Trylo 既有导航/工具合同后才进入核心。复用旧客户端机械层时移除旧全局配置、日志和进程 owner，通过既有接点注入。 | 核心及持久化合同不 import vscode 包；替换 transport 时改动局限于 adapter，工具正常结果、错误和定位格式保持兼容；独立代码 review 检查唯一 owner。 |
| 测试维护 | 采用分层证据：适配层验证边界、并发、取消与异常；真实语言服务器验证 L60 项目事实；生产安装验证依赖归类。库内部 framing 算法不复制成自己的大套单测，重点测 Trylo 的流/限额接点确实正确消费分片、连续帧和 Unicode。 | 未修代码红例；真实项目初始化/同步及 L60 操作结果；运行时值依赖没有被错误裁进开发依赖；安装产物在 `--omit=dev` 条件下，使用显式指定的外部真实语言服务器完成查询。 |

交接材料须同时列出“已测量成本 / 未测量成本 / 已实施措施 / 待实施措施”。不凭猜测写包体或内存节省百分比，不把上游依赖包的开发依赖当作普通消费者生产依赖计算；性能结论须记录 Node、平台、版本、场景与样本，区分首次加载和连接复用。

回滚以本包自己的 adapter/配置/依赖与 lockfile 差异为边界，保留用户和其他工作包改动。实现可分两步交付：先冻结版本和薄 adapter 并跑通真实查询，再接按需加载、复用及限额；每步均须满足代码第一门禁，L60 全量验收仍按原工作包执行。

### WP12.3 IDE 与文件选择入口

施工：复用已有项目导航合同，连接 @选择/定位与适用 IDE 端口。

验收：选中文件确实进入模型上下文；跳转路径/行号正确；断连不切成伪造响应。

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
