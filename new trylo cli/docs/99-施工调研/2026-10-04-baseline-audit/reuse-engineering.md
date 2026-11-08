# 两个基线的直接复用工程建议

> 状态：草案  
> 阶段：普通 Agent 基底追平调研；不是施工批准书  
> 负责人：Codex 复用审计子任务  
> 最后更新：2026-10-04  
> 依赖决策：按用户最新指令，两个基线全部默认可以复用；本报告不设许可证或成熟度准入阻断。只比较真实代码边界、依赖成本与可验证的接入路径。

## 1. 结论

建议采取组合路线：**旧版的界面与工具模块直接抽取，Codex 的独立执行模块放在薄进程桥后，新版继续拥有现有执行合同和学习控制面。** 对需要整段 Codex Agent 能力的场景，先用 `app-server` 做可卸载的委托执行后端。SDK 适合较简单的后台委托任务；它不是模型 API SDK，不能直接塞进 `ProviderPort` 当一个模型。

这符合“能用就直接复用”：修改只放在模块周围的输入/输出、配置与状态适配处。并不要求再实现同一套 patch、PTY、搜索或完整终端渲染算法。整套旧内核或 Codex core 直接替换新版，需要迁移学习注入、权限、session/recovery、provider 和 UI 五条已有合同；成本高于有界模块复用，不能由功能数量推导出更省工。

本次是源码核查，没有运行候选、安装依赖或做真实 provider 试验。下文“可接入”表示代码边界存在，“能达到用户的真实任务效果”仍要由后续 spike 证明。

## 2. 已确认的接点与限制

| 已确认事实 | 对直接复用的含义 | 证据 |
| --- | --- | --- |
| 新版模型口只有 `stream(request, signal)`，事件包含文字、工具请求和 usage；工具由新版单独执行 | 完整 Codex Agent 输出已经包含工具执行结果，不能冒充一个普通 provider；否则会出现两套执行所有者 | [ProviderPort](<D:/CC/trylo/new trylo cli/src/internal/ports/provider.ts:185>)、[ToolPort](<D:/CC/trylo/new trylo cli/src/internal/ports/tools.ts:48>) |
| 新版已有 `ShellSpawner(spec) → Promise<ShellSpawnResult>` 注入点；输入支持 argv、cwd、取消和输出限制 | 可替换一次性进程执行实现；但该合同无 live session ID、stdin/resize、增量读输出，不能把交互 PTY 静默压成一次 Promise | [ShellSpawner](<D:/CC/trylo/new trylo cli/src/internal/adapters/tools/mutating/shell-spawn.ts:18>) |
| 当前 spawner 把 stdin 设为 ignore，取消/超时调用 child.kill；网络限制注释明确是环境级而非 OS 隔离 | Codex PTY/进程组/Windows sandbox 是具体可复用增量；需要新的进程会话合同和相应工具面 | [shell-spawn.ts](<D:/CC/trylo/new trylo cli/src/internal/adapters/tools/mutating/shell-spawn.ts:64>)、[runSingle](<D:/CC/trylo/new trylo cli/src/internal/adapters/tools/mutating/shell-spawn.ts:130>) |
| 新版有后台委托口 submit/progress/cancel/wait/status，并区分观察超时与任务终态 | 简单 Codex SDK 任务可接 `ToolRunnerPort`；新 wire DTO 不应进入学习资产或 SessionPort | [ToolRunnerPort](<D:/CC/trylo/new trylo cli/src/internal/ports/tool-runner-port.ts:44>) |
| 新版权限票据按具体参数 fingerprint 判定，session journal 记录 issued/committed/unknown，恢复有 reconcileRequired | app-server 审批和恢复必须映射真实动作与事实；不能把一条外部 completed 直接当成新版所有副作用已 verified | [PermissionPort](<D:/CC/trylo/new trylo cli/src/internal/ports/permission.ts:19>)、[SessionPort](<D:/CC/trylo/new trylo cli/src/internal/ports/session.ts:14>) |
| 本地 Codex 是 `73a1148c9c775c2a4616ce5096291740a00ed68a`（本地提交日期 2026-09-09），origin 是 openai/codex；本地只有一条可用历史 | 以该 commit 的源码/schema 为基线；在线文档仅帮助判断接入路线，不能假设最新 API 已存在于本地版本 | [对应官方提交](https://github.com/openai/codex/commit/73a1148c9c775c2a4616ce5096291740a00ed68a)、本次 `git log -1` / `git rev-list --count HEAD` 只读核查 |
| 本地 TypeScript SDK 启动 `codex exec --experimental-json`，stdin/stdout 交换事件；包含 win32 x64/arm64 可执行包映射 | 复用 SDK 也要交付 Codex 二进制、进程生命周期、事件转换、版本配对和重启恢复，不是只加一个 JS import | [sdk exec.ts](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/sdk/typescript/src/exec.ts:49>)、[启动逻辑](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/sdk/typescript/src/exec.ts:92>) |
| 本地 Codex WireApi 仅 Responses，`wire_api="chat"` 明确返回 removed 错误 | 新版当前 `messages` 兼容服务不能只改 baseUrl 就保证接入 Codex。SDK、app-server 与完整 core 都继承这一限制；先用用户实际 endpoint 测 /responses | [WireApi](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/model-provider-info/src/lib.rs:61>)、[新版请求体](<D:/CC/trylo/new trylo cli/src/internal/adapters/provider/openai-compatible.ts:300>) |
| 当前官方 app-server 文档描述 stdio 双向 JSON-RPC、版本配套 schema 和服务端审批请求；部分接口/transport 是 experimental | 有审批交互、steer、实时 item 事件的集成优先 stdio app-server；按本地版本生成 schema 后选择确实存在的接口 | [OpenAI Docs app-server](https://learn.chatgpt.com/docs/app-server)、[本地 app-server 依赖](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/app-server/Cargo.toml:29>) |
| Codex 本地有 Windows x64/arm64 构建、helper 与平台测试流水线；PTY 库有 ConPTY、JobObject、Windows 输入归一 | 比单看 Windows 安装器更实在，但流水线存在不等于本次机器已通过。要在真实 PowerShell 和用户工作区路径上复验 | [Windows 制品矩阵](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/.github/workflows/rust-release-windows.yml:6>)、[PTY 导出](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/utils/pty/src/lib.rs:16>)、[官方 Windows 支持](https://learn.chatgpt.com/docs/windows/windows-sandbox) |

## 3. 具体直接复用清单

| 能力 | 直接取哪段现成实现 | 新版接入方式 | 实际依赖/语义成本 | 建议 |
| --- | --- | --- | --- | --- |
| Markdown、diff、加载状态、终端列宽/CJK/emoji | 旧版 `components/Markdown.tsx`、`MarkdownTable.tsx`、`StructuredDiff.tsx`、`StructuredDiff/Fallback.tsx`、`Spinner/*`、`utils/truncate.ts`、`ink/stringWidth.ts` | 抽取视图子树及其必需辅助函数，用新版 TUI 投影 DTO 供给 props；主题/settings/terminal-size 由桥提供 | Markdown/diff 依赖 React/Ink/marked 等；StructuredDiff 还走 native color-diff 和旧 settings/theme。Spinner 主文件依赖 AppState、tasks、feature 等，优先取 animation row/frames 子模块，别把整 AppState 一并搬来 | 优先复用；渲染算法和交互组件保留上游实现，裁剪原 runtime 调用 |
| 高效代码文本搜索 | 旧版 `utils/ripgrep.ts` 及 GrepTool 使用它的查询/结果处理 | 独立 `rg.exe` + 新版 read-only ToolPort adapter，继续输出新版 hits/truncation metadata | 旧 helper 自带 system/builtin/embedded 三种路径；其 builtin vendor 根基于旧 bundle，不能原样引用。复制查询与结果代码，把二进制绝对路径和 spawn 注入即可 | 优先复用；大仓库性能增量明显，保留新版搜索 DTO |
| 文件名模糊查找、@ 文件选择 | Codex `codex-rs/file-search` 完整独立 crate/bin | `codex-file-search --json` 进程桥供 TUI picker/可选文件名工具；转为新版相对路径 DTO | 内部依赖主要是 ignore/nucleo/tokio/serde 等，Cargo.toml 无 codex-core。它是文件/目录名称匹配，不是代码文本 grep，不能替代 `search_text` | 优先独立二进制复用；源码不需要改写成 TypeScript |
| 多文件 patch、新增/删除/移动、宽容匹配、流式 patch | Codex `apply-patch/src/{parser,streaming_parser,file_update,seek_sequence,text_file}.rs` 或现成 apply_patch binary | 新建 `apply_patch` ToolPort adapter；沿用新版 sandbox/权限、错误合同和 file_write 事实 | 新版现有 patch 是一文件 unified diff，语义不等同。Codex 完整 crate 直接依赖 exec-server/path-uri/tree-sitter；parser 也引用 ApplyPatchArgs/PathUri，不能只复制一个 parser.rs 宣称闭包完成。默认 standalone 跟随 symlink 且更新默认 LF，需要明确选 PreserveLineEndings，并在桥层检查所有路径 | 第一选择复用独立二进制；若制品过重，抽取上列源码闭包而非重写算法 |
| PTY、stdin/resize、持续进程与进程树取消 | Codex `utils/pty`（pipe/process/process_group/pty/win/windows_input） | 一个薄 Rust helper 暴露 spawn/read/write/resize/signal/exit；新版 ProcessPort 拥有会话；一次性调用可接原 ShellSpawner | 依赖 portable-pty/tokio + Windows native APIs；无需 codex-core。已有 ShellSpawner 无 live state，扩口是必要成本。PTY 解决交互进程，不等于 OS sandbox | 优先复用；单独验 Windows 取消和句柄回收 |
| 完整 shell 语义与平台选择 | 旧版 `utils/shell/{shellProvider,bashProvider,powershellProvider,powershellDetection}.ts`，`ShellCommand.ts` | 抽取 provider/quoting 与命令执行机械层，配置/日志/cwd/task-output 通过新版端口给入 | 旧 Shell.ts 混合 bootstrap/session、TaskOutput、SandboxManager、analytics；整文件直搬会扩大闭包。可以复制 providers 与执行机械实现，保留新版 PermissionPort 决策 | 与 PTY 包并行复用；先明确 PowerShell/bash 选择和真实 pipeline 行为 |
| 一整个委托 Agent 的工具/上下文/恢复能力 | Codex TypeScript SDK + 官方 binary，或 app-server stdio | 简单后台任务走 `ToolRunnerPort`；需要审批与实时控制用 app-server adapter。父任务只持久化 delegate ID/版本/结果/执行事实映射 | SDK 子进程不是单请求模型；app-server 包绑定 core/config/tools/rollout/thread-store 等，闭包大但留在外进程。需解决实际 Responses endpoint、审批请求、取消和重启 resume；learning snapshot 可先作为显式 instructions/context 注入，精确 receipt 不能假定已自动产生 | 做有界 sidecar spike；成本通过端口控制，不把 Codex types 泄入新版 |
| LSP 定义/引用/hover/符号/调用层次 | 旧版 `tools/LSPTool/{LSPTool,schemas,formatters,prompt}.ts` 与 `services/lsp/{LSPClient,LSPServerInstance,LSPServerManager,config}.ts` | 直接抽取 LSP client/server 管理与结果转换，在新版 ToolPort 后注册 LSP 工具；进程启动、配置、日志、cwd 经桥提供 | 旧工具绑定旧 ToolDef、read permission 和 React UI；需去掉这些边界依赖。真实语言服务仍是额外可执行程序，连接成功必须用实际项目查询证明 | 直接复用现成 LSP 子系统；源码入口：[LSPTool](<D:/CC/trylo/trylo cli/src/tools/LSPTool/LSPTool.ts:1>) |
| Jupyter notebook cell 替换/插入/删除 | 旧版 `tools/NotebookEditTool/NotebookEditTool.ts`、`types/notebook.ts`、`utils/notebook.ts` | 复制 cell 定位与变更算法/输入 schema；新版 mutating ToolPort 接读盘、atomic write、PermissionPort 与 file_write 事实 | ToolDef/UI、旧 fileHistory 与日志不可直接进入新版；需要明确 cell ID、metadata、输出保留和失败时原文件不变 | 窄工具适合先复用；源码入口：[NotebookEditTool](<D:/CC/trylo/trylo cli/src/tools/NotebookEditTool/NotebookEditTool.ts:1>) |
| 向用户提问、多选、自由答案与取消 | 旧版 `tools/AskUserQuestionTool/AskUserQuestionTool.tsx` 的 question/schema/答案结构，以及对应问答呈现组件 | 复用问题 schema、校验和视图；新建 UserInputPort 管理 requestId、回答/取消/EOF，再把结果交回工具调用 | 旧实现经 permission component 收集答案，不能把普通问答与动作授权共用票据语义。新版现有 PermissionPort 只表达批准/拒绝，需新增独立问答合同 | 直接复用交互与校验，薄桥拥有请求生命周期；源码入口：[AskUserQuestionTool](<D:/CC/trylo/trylo cli/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:14>) |
| SKILL.md 发现/frontmatter/参数替换/显式调用/子 Agent 技能 | 旧版 `skills/loadSkillsDir.ts`、`utils/frontmatterParser.ts`、`argumentSubstitution.ts`、`markdownConfigLoader.ts` 和 `tools/SkillTool/SkillTool.ts` | 先复制 loader/parser/参数替换闭包，输出新版 SkillDescriptor/context；显式 Skill tool 再接 ToolPort。fork 运行转给现有子 Agent/ToolRunnerPort | loader 本身也带 settings/plugin/mcp/hooks、prompt shell 执行与全局缓存；SkillTool 还带旧 messages/runAgent。以功能拆包，原算法保留，配置源/缓存/执行机制注入；学习资产激活仍由新版控制板拥有 | 直接复用加载与调用机制，受治理学习 Skill 和用户文件 Skill 分别标明来源；[loader](<D:/CC/trylo/trylo cli/src/skills/loadSkillsDir.ts:1>)、[SkillTool](<D:/CC/trylo/trylo cli/src/tools/SkillTool/SkillTool.ts:1>) |
| hooks 注册、会话/工具前后事件、命令/HTTP/prompt/Agent hooks | 旧版 `utils/hooks/{hooksConfigManager,hooksConfigSnapshot,hookHelpers,hookEvents,sessionHooks,AsyncHookRegistry,execHttpHook,execPromptHook,execAgentHook}.ts` | 复制配置解析、匹配规则与执行适配器；在新版已有执行事件边界发 HookInvocation，由统一 runner 执行并归一 HookResult | hookHelpers 跨旧 ToolUseContext/session/message 全局状态，不能整文件接入核心。允许阻断/注入的 hook 必须有显式新合同，命令 hook 走现有授权与进程口；普通观察 hooks 可先接 Journal/event | 分生命周期复用，先接 command/观察 hooks；[hook 事件结构](<D:/CC/trylo/trylo cli/src/utils/hooks/hookEvents.ts:21>)、[hookHelpers](<D:/CC/trylo/trylo cli/src/utils/hooks/hookHelpers.ts:1>) |

源码证据：旧版 [Markdown](<D:/CC/trylo/trylo cli/src/components/Markdown.tsx:1>)、[StructuredDiff](<D:/CC/trylo/trylo cli/src/components/StructuredDiff.tsx:1>)、[Spinner](<D:/CC/trylo/trylo cli/src/components/Spinner.tsx:1>)、[ripgrep](<D:/CC/trylo/trylo cli/src/utils/ripgrep.ts:23>)、[Shell](<D:/CC/trylo/trylo cli/src/utils/Shell.ts:1>)；Codex [file-search 依赖](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/file-search/Cargo.toml:22>)、[文件匹配结果类型](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/file-search/src/lib.rs:41>)、[patch 闭包](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/apply-patch/Cargo.toml:19>)、[patch 默认更新与路径策略](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/apply-patch/src/lib.rs:63>)、[PTY 依赖](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/utils/pty/Cargo.toml:10>)、[新版单文件 patch](<D:/CC/trylo/new trylo cli/src/internal/adapters/tools/mutating/patch-engine.ts:1>)。

旧版的一些原有能力还有工程空洞：构建把 `@ant/*` 变成空模块，并输出空 BROWSER_TOOLS/COMPUTER_USE_TOOLS。因此“旧目录有入口或工具名”不等于该能力可以原样工作；复制时要查看是否触及 stub。证据：[build.mjs](<D:/CC/trylo/trylo cli/scripts/build.mjs:124>)。

## 4. 三条路线的真实成本比较

以下是工程工作量形状，不是已经验证的排期。没有真实包构建、Windows sidecar 和实际 endpoint 证据，现在给确定天数会误导。

| 路线 | 能保留的现成工作 | 必须付出的成本 | 长期更新/退出成本 | 本次建议 |
| --- | --- | --- | --- | --- |
| 旧版模块直接抽取 | TypeScript 工具/终端呈现，与新版同语言；现有 provider 兼容路径继续用新版 | 每个模块收集最小 import 闭包；替换 bootstrap/AppState/analytics/config/task-output 边界；选中的 React/Ink 或 native render 依赖；真实 TTY 比较 | 每个抽取模块记录来源路径/commit，局部更新；换实现只改 view/tool adapter | 优先用于 TUI、grep、shell provider、窄工具；不是整包继承旧 lockfile |
| Codex 模块/sidecar 隔离复用 | Rust patch/PTY/file picker 原实现；或一整个可委托 Agent 的真实能力 | 独立平台制品+进程桥+事件 DTO。完整 sidecar 另外付 RPC/审批/session ID/重启/Responses provider/学习上下文映射 | crate/helper 较易替换；完整 app-server 若只存 delegate reference 则退出可控；若复制它的 thread store/types 到新版，迁移成本增大 | leaf helper 先接；完整 Agent 用 app-server spike，证明缺口覆盖和 provider 适配 |
| 扩展新版现有内核 | 已有 provider/tool/session/PermissionPort、Journal 与学习接线 | 保留现有合同；复制成熟实现后补缺失端口/工具。若不复用而从头做 PTY、patch、完整 TUI，开发/维护范围最大 | 自有合同稳定，但新写实现都成为团队维护负担 | 推荐“延展内核 + 直接复用模块”；学习与治理增量自有，普通能力用现成实现 |

整核替换需要先回答：谁发模型请求、谁执行工具、谁决定权限、谁写 session、谁把学习资产映射成实际每次 dispatch 的行为证据。当前没有证明两边五个所有者可以无损合并的接线，所以不把整核替换当默认施工方案。证据：[旧 QueryEngine 的跨域依赖](<D:/CC/trylo/trylo cli/src/QueryEngine.ts:1>)、[Codex app-server 闭包](<D:/CC/trylo/new trylo cli/open/01-agent-cli-runtimes/codex/codex-rs/app-server/Cargo.toml:29>)、[新版端口目录](<D:/CC/trylo/new trylo cli/src/internal/ports/tools.ts:1>)。

## 5. 后续有界 spike

每个 spike 只验证一条复用路径，先给可安装候选和真实结果，再扩大范围；本次不执行这些试验。

1. **S1，patch helper：** 固定本地 Codex 源码版本，只接一个 apply_patch 工具。接受任务必须覆盖新增/删除/移动/多文件、CRLF 与无末尾换行、上下文不匹配、路径越界/symlink、取消、结果对应实际磁盘 diff。记录与新版原 patch 的行为差异。成功后扩目录；失败保留旧 edit_file。
2. **S2，Windows process helper：** 只取 utils/pty；一次性命令先接 ShellSpawner，新建会话工具再覆盖连续输出、stdin、resize、EOF、timeout、取消含子进程、重启后的失联会话判定。要求测试退出码和残留进程，不以 helper 启动成功验收。
3. **S3，旧版 TUI 小闭包：** 只移 Markdown/table/diff/fallback 与必要 terminal-width/theme 组件。真实 TTY 验宽/窄窗口、中文/emoji、流式输出、长工具结果、审批详情、Ctrl+C 与退出；衡量需要带入多少旧 AppState/hooks，超过视图边界就继续切分子模块。
4. **S4，Codex 委托后端：** 一个普通修复任务，固定 app-server binary/schema、隔离其 home 与用户凭据来源。实际用户 endpoint 先验证 Responses；再验证审批拒绝/接受、turn interrupt、断进程后 resume、tool/file facts 和新版 delegate journal 对得上。最后同任务比较无学习/固定学习 snapshot 的行为 receipt；任一关键映射失败不扩成默认主执行后端。

以上 spike 的完成证据应包括独立安装、真实 provider/Windows、磁盘 diff、项目验收测试、exit code、resume、TTY；代码存在、绿色门禁或外部 Agent 的 completed 只覆盖其中一部分。

## 2026-10-04 Windows复用路线更正

见 [更正ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)。旧CLI底层已安装sandbox-runtime 0.0.73带原生Windows helper；此前平台描述止于adapter旧注释，调查未覆盖实际依赖和制品。Windows先验证现成runtime/helper薄桥，Codex保留候选。新版生产缺口、未完成状态和实际隔离验收要求不因找到制品而改变。

## 强制实际复核（2026-10-04用户决定）

[实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)是WP01–WP28的强制签收项。文档中的具体源码判断和复用建议只作候选；进入生产集成前必须追到当前实际调用链、依赖实现/版本、预编译制品和最小闭包，跑有界探针并留失败/反例。代码纪律仍是第一门禁，vendor JS不因检测盲区豁免。

每根关键接线必须交“原判断→实际来源/hash→探针与未验证范围→选用/纠正路线→独立复核”记录。只读诊断成功不代表就绪，注册/搬运不代表接线，未验证阶段不能升成熟度。证据推翻文档时同步更正本包、来源建议、ADR和矩阵；已批准需求与Trylo owner不因候选事实更正失效。

