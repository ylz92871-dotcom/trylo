# WP23 日用TUI输入-渲染-键位与等待原因

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R8；角色：施工主责
- 主责能力：C01, C02, C81, L01, L02, L39, L40, L41, L43, L44, L45, L46, L47
- 接口前置：[WP06](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP06-PTY-长进程-stdin与后台终端.md>)、[WP08](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP08-运行中输入-steer与排队.md>)、[WP11](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP11-diff-review-checkpoint与范围回退.md>)、[WP12](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP12-搜索-LSP与IDE导航.md>)、[WP19](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP19-多模态-图像-语音与computer-use.md>)、[WP21](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP21-用户问答-Plan-Task与Goal生命周期.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)
- 集成联验：[WP14](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP14-Skill与项目指令实际消费.md>)、[WP16](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP16-Plugin-动态工具与延迟搜索.md>)、[WP24](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP24-Headless-诊断-输出样式与工作流入口.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用成熟视图子树，覆盖真实终端日用交互。

本包接点/owner边界：**既有TUI服务；Trylo协议投影；CLI命令**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C01 | 普通交互 Agent 入口 / — | 已有 / contracted | 交互 Agent 与多轮执行已接线。 | 沿用新版 runner/TUI；旧终端视图补呈现。 |
| C02 | 模型流式响应与工具继续执行 / — | 已有 / contracted | 流式文本、reasoning、工具继续执行、usage 已有。 | 沿用 openai-stream 与 loop，补其他 provider 的 wire adapter。 |
| C81 | 多行、粘贴保护、历史与外部编辑器 / P1 | 部分 / contracted | 有多行、历史、补全、@文本；缺同等粘贴保护、外部编辑器和附件。 | 直接搬旧 composer/输入子树；或复用 Codex Composer 状态机。 |
| L01 | 连续模型—工具—结果—模型循环（共用 C01） / — | 已有 / contracted | 交互 Agent 与多轮执行已接线。 | 沿用新版 runner/TUI；旧终端视图补呈现。 |
| L02 | 流式文本、工具参数及思考块（共用 C02） / — | 已有 / contracted | 流式文本、reasoning、工具继续执行、usage 已有。 | 沿用 openai-stream 与 loop，补其他 provider 的 wire adapter。 |
| L39 | 全交互 TTY：草稿/光标/多行输入与长粘贴（共用 C81） / P1 | 部分 / contracted | 有多行、历史、补全、@文本；缺同等粘贴保护、外部编辑器和附件。 | 直接搬旧 composer/输入子树；或复用 Codex Composer 状态机。 |
| L40 | 上下历史与历史搜索 / P1 | 部分 / contracted | readline上下历史有；无同等历史搜索/picker。 | 搬useArrowKeyHistory/useHistorySearch。 |
| L41 | 文件 @、IDE 选区 @、图像粘贴 / P1 | 部分 / contracted | @文本有；IDE选区/图像粘贴缺失。 | 搬paste/@准备模块及IDE MCP transport。 |
| L43 | Markdown、表格、代码块、工具 diff / P1 | 部分 / contracted | frame/theme/details有；缺同等Markdown表格/代码块/diff组件链。 | 搬Markdown/MarkdownTable/StructuredDiff小视图闭包。 |
| L44 | 审批/提问/elicitation 队列与可见等待原因 / P1 | 部分 / contracted | 审批展示与暂停重绘有；提问/elicitation/后台等待队列缺口。 | 搬旧问答/elicitation队列和视图。 |
| L45 | Vim 输入模式 / P2 | 缺失 / contracted | 无Vim输入。 | 搬VimTextInput+src/vim状态机。 |
| L46 | 默认快捷键与自定义 keybindings / P1 | 部分 / contracted | 基本键位有；无产品键表/自定义JSON/热加载。 | 取keybindings parser/resolver/defaultBindings/watcher。 |
| L47 | theme/terminal setup/statusline/config/model/effort / P1 | 部分 / contracted | theme/模型/状态行有；terminal setup/statusline/effort不全。 | 搬旧commands/菜单；补自有effort字段。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C01**：[C01源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:18>)；`cli/src/main.rs:1177` 转发 TUI；`core/src/session/turn.rs:163` 执行 turn、`:335` 采样续行循环（以下均在 codex-rs 下）；常规；不是只发送一次文本；复用成熟 UI / tool adapters；保留 Trylo Loop 所有权
- **C02**：[C02源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:19>)；`core/src/session/turn.rs:367` 冻结该请求视图；`:441` 采样及 child cancellation；常规；一次 turn 可多轮模型/工具交替；provider 流适配、工具协议语义
- **C81**：[C81源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:98>)；`tui/src/bottom_pane/chat_composer.rs:165` paste burst、`:1126` history metadata、`:1214` paste、`:678` editor key；常规；真实Composer状态机，非普通readline prompt；若保持TS终端复用旧Trylo；Codex TUI整体是Rust/ratatui
- **L01**：[L01源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:26>)；普通路径；以实际 tool-use block 决定后续轮，支持 maxTurns 终态；[query.ts:220](<D:/CC/trylo/trylo cli/src/query.ts:220>)、[query.ts:565](<D:/CC/trylo/trylo cli/src/query.ts:565>)、[query.ts:1722](<D:/CC/trylo/trylo cli/src/query.ts:1722>)
- **L02**：[L02源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:27>)；普通 provider 流；思考能力受模型影响；[claude.ts:752](<D:/CC/trylo/trylo cli/src/services/api/claude.ts:752>)、[QueryEngine.ts:766](<D:/CC/trylo/trylo cli/src/QueryEngine.ts:766>)
- **L39**：[L39源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:64>)；普通 React/Ink REPL；paste handler 统一收输入；[REPL.tsx:4903](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:4903>)、[PromptInput.tsx:2173](<D:/CC/trylo/trylo cli/src/components/PromptInput/PromptInput.tsx:2173>)、[BaseTextInput.tsx:57](<D:/CC/trylo/trylo cli/src/components/BaseTextInput.tsx:57>)
- **L40**：[L40源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:65>)；普通交互；[PromptInput.tsx:357](<D:/CC/trylo/trylo cli/src/components/PromptInput/PromptInput.tsx:357>)、[PromptInput.tsx:908](<D:/CC/trylo/trylo cli/src/components/PromptInput/PromptInput.tsx:908>)
- **L41**：[L41源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:66>)；普通输入接点；IDE 需连接；图像需剪贴板/图像依赖；[PromptInput.tsx:1151](<D:/CC/trylo/trylo cli/src/components/PromptInput/PromptInput.tsx:1151>)、[PromptInput.tsx:1283](<D:/CC/trylo/trylo cli/src/components/PromptInput/PromptInput.tsx:1283>)、[BaseTextInput.tsx:65](<D:/CC/trylo/trylo cli/src/components/BaseTextInput.tsx:65>)
- **L43**：[L43源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:68>)；普通 UI 模块；与工具/执行状态分离；[Markdown.tsx](<D:/CC/trylo/trylo cli/src/components/Markdown.tsx>)、[MarkdownTable.tsx](<D:/CC/trylo/trylo cli/src/components/MarkdownTable.tsx>)、[StructuredDiff.tsx](<D:/CC/trylo/trylo cli/src/components/StructuredDiff.tsx>)、[FileEditToolDiff.tsx](<D:/CC/trylo/trylo cli/src/components/FileEditToolDiff.tsx>)
- **L44**：[L44源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:69>)；普通 REPL；权限与工具结果不是只显示成功/失败文本；[REPL.tsx:1101](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:1101>)、[REPL.tsx:1136](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:1136>)、[REPL.tsx:1156](<D:/CC/trylo/trylo cli/src/screens/REPL.tsx:1156>)
- **L45**：[L45源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:70>)；普通 `/vim` 命令及 VimTextInput；不是整个外部编辑器；[commands.ts:319](<D:/CC/trylo/trylo cli/src/commands.ts:319>)、[vim/index.ts:4](<D:/CC/trylo/trylo cli/src/commands/vim/index.ts:4>)、[PromptInput.tsx:111](<D:/CC/trylo/trylo cli/src/components/PromptInput/PromptInput.tsx:111>)
- **L46**：[L46源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:71>)；默认键表存在；自定义 JSON 与 watcher 受 GB gate，默认 fallback false；[defaultBindings.ts](<D:/CC/trylo/trylo cli/src/keybindings/defaultBindings.ts>)、[loadUserBindings.ts:41](<D:/CC/trylo/trylo cli/src/keybindings/loadUserBindings.ts:41>)、[loadUserBindings.ts:133](<D:/CC/trylo/trylo cli/src/keybindings/loadUserBindings.ts:133>)
- **L47**：[L47源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:72>)；普通命令注册；具体 provider 的模型/effort 能力另受约束；[commands.ts:268](<D:/CC/trylo/trylo cli/src/commands.ts:268>)、[commands.ts:276](<D:/CC/trylo/trylo cli/src/commands.ts:276>)、[commands.ts:290](<D:/CC/trylo/trylo cli/src/commands.ts:290>)、[commands.ts:303](<D:/CC/trylo/trylo cli/src/commands.ts:303>)、[commands.ts:312](<D:/CC/trylo/trylo cli/src/commands.ts:312>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP23.1 渲染子树与宽度

施工：取旧 Markdown/Table/StructuredDiff/Fallback/Spinner帧与CJK宽度机械层，props由自有投影提供。

验收：中文/emoji/窄宽窗口/长输出与流式diff真实TTY显示正确；不整搬旧AppState/Loop。

### WP23.2 输入与键位

施工：复用编辑/Vim/历史/补全/多行等组件，命令进入现输入服务。

验收：编辑器退出、粘贴、多行、Ctrl+C、EOF、/exit 行为可用且Node真正退出；无后台残留。

### WP23.3 等待与结果呈现

施工：显示批准/问答/工具运行/子代理等待和错误事实，接会话 picker、导航与媒体投影。

验收：用户能理解等待原因并继续/取消；失败正文不被投影丢弃；安装制品真实TTY复验。

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
