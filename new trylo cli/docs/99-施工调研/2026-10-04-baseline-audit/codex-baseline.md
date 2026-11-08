# Codex 本地源码生产能力基线

> 2026-10-07 WP26 来源复核补充：[全项施工与复核纠正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-07-ADR-WP26全项施工与复核纠正.md>)。Codex 本地有 exec-server 的服务实现及 app-server-daemon 跨平台生命周期机械层；不能只读协议就将服务整体判为缺件或必须 Cloud 账户。实际 backend/auth/制品仍须独立验证，不能搬 Codex core 作为 Trylo 的第二个 Agent owner。本补充不表示新版接通或真实远端验收通过。

- 状态：草案（源码审计事实；供逐项差距报告引用）
- 阶段：CLI 普通 Agent 基底调研
- 负责人：Codex 审计 Agent
- 最后更新：2026-10-04
- 依赖决策：用户指定只对照旧 Trylo CLI 与 open 中的 Codex；用户指定默认允许复用，本报告不进行许可证判定。
- 审计根目录：`D:\CC\trylo\new trylo cli\open\01-agent-cli-runtimes\codex`
- 固定 HEAD：`73a1148c9c775c2a4616ce5096291740a00ed68a`；`git describe --tags --always` 为 `73a1148`。Rust workspace version 为 `0.0.0`（`codex-rs/Cargo.toml:153`），不能据此冒称发行版本。
- 方式：读取生产入口、注册条件、调用链与实现；未运行 Codex、未运行整体测试、未修改产品源码。源码接线成立不等于本机、真实账户或远端运行已经验收。

下表路径均相对于审计根目录。**常规**指代码存在普通入口；**条件**指模型、认证、配置或服务决定可用性；**实验/开发**严格沿用源码标记，不能计入默认日用追平要求。flags 的权威文件为 `codex-rs/features/src/lib.rs`，不能仅凭某 crate 存在就认定功能默认可用。

## 逐项矩阵

| ID | 对照能力 | 本地 Codex 生产入口与证据 | 状态与限制 | 推荐复用落点 |
|---|---|---|---|---|
| C01 | 普通交互 Agent 入口 | `cli/src/main.rs:1177` 转发 TUI；`core/src/session/turn.rs:163` 执行 turn、`:335` 采样续行循环（以下均在 codex-rs 下） | 常规；不是只发送一次文本 | 复用成熟 UI / tool adapters；保留 Trylo Loop 所有权 |
| C02 | 模型流式响应与工具继续执行 | `core/src/session/turn.rs:367` 冻结该请求视图；`:441` 采样及 child cancellation | 常规；一次 turn 可多轮模型/工具交替 | provider 流适配、工具协议语义 |
| C03 | 运行中补充输入/steer | `core/src/session/turn_input.rs:202` 分派；`:242` start_or_steer；`app-server/src/request_processors/turn_processor.rs:254` | 常规；有 expected turn ID 和显式提交结果 | `turn_input` + `tui/src/chatwidget/input_queue` 合同 |
| C04 | 显式中断及工具取消 | `core/src/session/handlers.rs:59` interrupt；`core/src/tools/parallel.rs:176` 取消分支；`app-server/src/request_processors/turn_processor.rs:265` | 常规；不能只关闭显示 | Trylo 现有取消端口接同等生命周期 |
| C05 | 工具并行/串行有序仲裁 | `core/src/tools/parallel.rs:107` supports_parallel；`:148` 读写 gate；`:160` dispatch | 常规；按工具能力判定，不是任意并行写入 | 工具 registry 的并行声明与互斥策略 |
| C06 | 完整 shell 命令字符串 | `core/src/tools/spec_plan.rs:1079` 注册；`core/src/tools/handlers/unified_exec/exec_command.rs:290` get_command；`core/src/shell.rs:22` derive_exec_args | 常规；shell_tool/unified_exec 均 Stable 默认 true；实际 shell 解释管道、重定向和控制语法 | `shell-command` / shell 检测与参数构造，接 Trylo ProcessPort |
| C07 | PowerShell/Bash/Zsh 等平台 shell | `core/src/shell.rs:22`，`:32` PowerShell `-Command`；`:62` 从执行环境恢复 shell | 常规；远端使用远端 OS/shell，指定其他 shell 有校验 | `shell-command/src/shell_detect`，而非字符串替换器 |
| C08 | PTY/交互程序 | `core/src/tools/spec_plan.rs:1095` allow_tty；`utils/pty/src/pty.rs:128` spawn_process；`:44` ConPTY 支持探测 | Stable 默认 true（unified_exec_tty）；tty 参数可选；Windows 原生实现 | `codex-utils-pty` 窄 sidecar，复用 portable-pty 与 Windows backend |
| C09 | 非 PTY 管道进程 | `core/src/tools/handlers/shell_spec.rs:50` tty=false 使用 pipes；`utils/pty/src/pipe.rs` 为真实实现 | 常规；PTY 与 pipes 是两种后端 | 同一 ProcessPort 可选择两种后端 |
| C10 | 长运行命令 yield 与 session ID | `core/src/tools/handlers/unified_exec/exec_command.rs:426` 请求 yield；`core/src/tools/handlers/shell_spec.rs:31` Windows 10–30 秒范围；`:216` session_id | 常规；超时返回运行句柄，不能误当命令完成 | `core/src/unified_exec/process_manager` 的句柄/终态合同 |
| C11 | write_stdin 后续交互/轮询 | `core/src/tools/spec_plan.rs:1106` 注册；`core/src/tools/handlers/unified_exec/write_stdin.rs:58` handle_call、`:84` manager 调用 | 常规；空写轮询和真实输入区分 | `unified_exec` 进程会话协议 |
| C12 | 背景终端可发现与停止 | `tui/src/chatwidget/slash_dispatch.rs:530` /ps、`:533` /stop；`core/src/session/handlers.rs:63` 清理 | 普通 TUI 可用；专门 app-server backgroundTerminals RPC 仍 Experimental（app-server-protocol/src/protocol/common.rs:723） | `unified_exec` manager + UI process list |
| C13 | 进程组/后代清理 | `utils/pty/src/pty.rs:65` interrupt group、`:74` kill、`:78` descendant 注释；`utils/pty/src/process_group.rs` | 平台实现；不能只 kill 父进程 | `codex-utils-pty` process_group/process 后端 |
| C14 | 输出限额与截断事实 | `core/src/tools/handlers/shell_spec.rs:220` original token count、`:224` truncated output；`core/src/context_manager/history.rs:372` payload 截断 | 常规；模型上下文、工具返回都有限额 | `utils/output-truncation`，保持截断标志 |
| C15 | 多文件 patch | `core/src/tools/spec_plan.rs:1255` 注册；`apply-patch/src/lib.rs:401` apply_hunks | 条件：模型目录声明 apply_patch_tool_type；不是单文件 edit | `apply-patch` parser + file update 实现 |
| C16 | patch 新增文件 | `apply-patch/src/parser.rs:67` AddFile；`apply-patch/src/lib.rs:508` 执行 | 常规 patch 能力 | 同 C15 |
| C17 | patch 删除文件 | `apply-patch/src/parser.rs:71` DeleteFile；`apply-patch/src/lib.rs:536` 执行 | 常规 patch 能力；必须沿 Trylo 权限流程 | 同 C15 |
| C18 | patch 移动/重命名文件 | `apply-patch/src/parser.rs:76` move_path；`apply-patch/src/lib.rs:619` 真实目的路径写入 | 常规 patch 能力；不能宣称多文件事务全有或全无 | 同 C15，保留部分失败 delta |
| C19 | patch 的部分成功/失败证据 | `apply-patch/src/lib.rs:247` AppliedPatchDelta；`:314` ApplyPatchFailure、`:333` into_parts | 常规；显式报告已发生变更 | 直接复用 patch result/delta 语义，转成 Trylo DTO |
| C20 | 每轮净 diff 追踪 | `core/src/turn_diff_tracker.rs:47`、`:49` TurnDiffTracker；消费 committed patch delta | 常规；不是仅最后一个 patch 文案 | diff tracker 算法，Trylo 自有轮次 ID |
| C21 | 用户 /diff（含未跟踪） | `tui/src/chatwidget/slash_dispatch.rs:444` get_git_diff→DiffResult；`tui/src/slash_command.rs:125` 用户说明 | 常规 Git 仓库；失败可见 | 旧 Trylo Git/UI 若已成熟优先；Codex workspace command runner 可参照 |
| C22 | 文件提及与模糊查找 | `tui/src/chatwidget/slash_dispatch.rs:470` @ 入口；`file-search/src/lib.rs:164` create_session、`:297` run | 常规；这是用户文件选择能力，不是内置 grep_content 模型工具 | `codex-file-search` 最适合直接隔离复用 |
| C23 | ignore-aware 搜索 | `file-search/src/lib.rs:111` ignore 范围、`:130` respect_gitignore 默认 true、`:211` worker | 常规；跨 root、增量查询可复用 | file-search walker/matcher/session |
| C24 | 模型本地读/grep/glob | `core/src/tools/spec_plan.rs:1032` 加 shell；`:1137` utility 注册不包含 read_file/grep/glob | Codex 主要通过完整 shell + rg 等实现，不能把仓库 crate 都计为模型工具 | 完整 shell 即可复用系统工具；Trylo 现有 read/search 保留 |
| C25 | 本地图片查看 | `core/src/tools/spec_plan.rs:1269` ViewImageHandler 注册；`handlers/view_image.rs` | Stable 默认 true；模型输入能力仍影响结果 | `utils/image` + view_image handler 的边界语义 |
| C26 | 图片输入参数/附件 | `utils/cli/src/shared_options.rs:13` image 参数；`tui/src/bottom_pane/chat_composer.rs:885` image paste 开关、`:1221` path 附件 | 常规；平台剪贴板/模型 image modality 有条件 | 图片准备/附件 DTO、Composer attachment state |
| C27 | 用户 Todo/Plan 工具 | `core/src/tools/spec_plan.rs:1142` update_plan_enabled → PlanHandler；`core/src/config/mod.rs:2665` resolver | 显式配置启用，默认 false；与 Plan mode 不是同一概念 | `handlers/plan` 状态与呈现；复用旧 Trylo todo |
| C28 | Plan 模式 | `tui/src/chatwidget/slash_dispatch.rs:318` apply_plan_slash_command；`core/src/thread_manager.rs:826` mode masks | 普通模式选择；旧 collaboration_modes flag 已 Removed true，不能说仍需实验开启 | collaboration-mode-templates + 模式合同 |
| C29 | 结构化向用户提问 | `core/src/tools/spec_plan.rs:1158` RequestUserInputHandler；`handlers/request_user_input` | 条件：experimental_request_user_input_enabled；默认只 Plan，DefaultModeRequestUserInput 为 UnderDevelopment false | 提问 DTO + TUI 选择表单；不把权限审批混进去 |
| C30 | 异步用户提问/消息 | `core/src/tools/spec_plan.rs:1167` request_user_input_async；`:1192` send_message_to_user_async | 条件：root agent + 模型 experimental_supported_tools；不能计为全部默认模型共有 | async notification/answer contract |
| C31 | AGENTS.md 分层指令 | `core/src/agents_md.rs:40` AGENTS.md、`:42` AGENTS.override.md、`:55` load、`:189` 父路径 discovery | 常规；含读取预算与项目根规则 | `agents_md` 的发现/优先级算法，转 Trylo context fragment |
| C32 | 指令上下文大小控制 | `core/src/agents_md.rs:154` remaining budget 截断；`core/src/context_manager/history.rs:327` TruncationPolicy | 常规；不会无限把外部资料注入模型 | 预算与截断叶子，可复用策略 |
| C33 | 会话保存与恢复 | `cli/src/main.rs:1472` Resume；`core/src/thread_manager.rs:1082` resume_from_rollout、`:1135` resume_with_history | 普通 CLI/TUI；picker、ID/name、--last/--all | 借鉴 rollout/thread-store；旧 Trylo持久化优先 |
| C34 | 会话 fork | `cli/src/main.rs:1561` Fork；`core/src/thread_manager.rs:1313` fork_thread、`:1347` fork_from_history | 常规；fork snapshot 明确，不等于覆盖旧会话 | `ForkSnapshot` 和父子 provenance 语义 |
| C35 | 持续上下文与 token usage | `core/src/context_manager/history.rs:439` estimate、`:624` update_token_info、`:677` total_usage | 常规；本地估算与服务端 token 区分 | history/token accounting 合同 |
| C36 | 手动压缩 | `tui/src/chatwidget/slash_dispatch.rs:270` compact→app_event；`core/src/session/handlers.rs:246` CompactTask | 常规 | compact 历史转换策略；不能复制整个 Session |
| C37 | 自动压缩并继续 | `core/src/session/turn.rs:180` pre_sampling compact；`core/src/compact.rs:120` inline auto compact | 常规；本地/remote 策略按 provider 能力选择 | 紧凑上下文转换与预算算法 |
| C38 | 会话回滚 | `app-server-protocol/src/protocol/common.rs:741` thread/rollback；`core/src/session/handlers.rs:254` drop turns | 常规 RPC；回滚历史与回退磁盘文件不能混为一谈 | rollback 合同、Trylo checkpoint 继续自有 |
| C39 | 会话列表/分页历史/归档 | `app-server-protocol/src/protocol/common.rs:577` archive、`:703` unarchive、`:751` list、`:842` turns/list、`:848` items/list；CLI cli/src/main.rs:1501/:1548 | 常规；持久化/索引服务支持 | thread-store/state 薄查询层 |
| C40 | 会话重命名/导出 | `tui/src/chatwidget/slash_dispatch.rs:305` rename、`:437` export；app-server-protocol/src/protocol/common.rs:611 name/set | 常规 | 旧 Trylo表层组件 / Codex transcript exporter |
| C41 | 背景消息队列 | `cli/src/main.rs:1514` Queue；app-server-protocol/src/protocol/common.rs:631–666 queue RPC | CLI 普通入口；细分 queue RPC 显式 Experimental | `ext/queue` + 唯一 writer 队列模型 |
| C42 | 子代理派发 | `core/src/tools/spec_plan.rs:1285` V1/V2 注册；`core/src/thread_manager.rs:1047` spawn_subagent | multi_agent Stable true；有最大深度/模型接线；不能只做串行 delegate | handlers/multi_agents + agent/control 合同 |
| C43 | 子代理输入/等待/恢复/关闭 | `core/src/tools/spec_plan.rs:670` V1 names；`:1344` V1 handler 分支 | 常规 V1，与父线程/状态生命周期相连 | V1 worker 会话生命周期，薄桥 |
| C44 | 子代理角色/模型配置 | `core/src/tools/spec_plan.rs:757` role description；`:1304` available_models、`:1306` agent_type | 模型/config 决定，V2 override 额外受设置控制 | `agent-roles` / agent/role 配置，不接管 Trylo 权限 |
| C45 | V2 团队消息/后续任务/中断/列表 | `core/src/tools/spec_plan.rs:1320` send_message、`:1324` followup、`:1337` interrupt、`:1341` list | multi_agent_v2 Stable 默认 false；V2配置/模型必须支持 | V2 handler + agent graph 服务，单独追平项 |
| C46 | MCP stdio 与 HTTP | `cli/src/mcp_cmd.rs:111` stdio/http shape；`:220` run；`core/src/tools/spec_plan.rs:159` append_mcp_tools | 常规配置能力；startup、transport、工具注册是真的接线 | `rmcp-client` / codex-mcp 的传输adapter，Trylo McpClientPort |
| C47 | MCP OAuth/凭据管理 | `cli/src/mcp_cmd.rs:71` login、`:72` logout；app-server/src/message_processor.rs:1632 oauth dispatch | 条件：HTTP server OAuth支持 | OAuth client/credential adapter；无需再造协议 |
| C48 | MCP resources/templates/read | `core/src/tools/spec_plan.rs:1128` 三资源 handler（有servers才注册）；core/src/tools/handlers/mcp_resource | 常规；与 tool/call 是不同能力 | resource handlers + rmcp transport |
| C49 | MCP tool 安全策略/暴露 | `core/src/tools/spec_plan.rs:197` exposure policy；`:210` server policy；`:245` deferred/code-mode | 模型 namespace/search 与配置决定；不能全量塞schema | codex-mcp tool policy/discovery，转换成 Trylo tool DTO |
| C50 | MCP 状态/刷新/elicitation | `tui/src/chatwidget/slash_dispatch.rs:542` /mcp；app-server/src/message_processor.rs:1635 reload、`:1638` status；core/src/session/handlers.rs:133 resolve_elicitation | 常规工具清单/刷新；部分新MCP协议 flags UnderDevelopment | rmcp client + 明确刷新和用户问题协议 |
| C51 | Skills 元信息加载/校验 | `skills/src/parser.rs:44` frontmatter parser；`app-server/src/message_processor.rs:1474` skills/list；`app-server/src/extensions.rs:123` install skills | 常规；真实 SKILL.md，不是只有用户传入一段prompt | `codex-skills` parser/loading/selection；最适合摘取 |
| C52 | Skills host/executor/orchestrator 来源 | `app-server/src/extensions.rs:117` provider chain、`:127` context预算；skills/src/loading.rs:111 precedence/IO contract | 条件：各来源 provider 和配置；不是全部用户都连接orchestrator | skills provider接口与渐进加载，而非只复制metadata |
| C53 | Skills search/依赖获取 | `features/src/lib.rs:1506` skill_search Stable true、`:1500` MCP dependency install true；app-server/src/extensions.rs:133 gate | 稳定但具体来源/安装需支持及授权 | `ext/skills` discovery、`core/src/mcp_skill_dependencies` |
| C54 | Plugins/marketplace 安装/移除 | `cli/src/main.rs:1278` plugin，`:1302` marketplace；app-server/src/message_processor.rs:1545 install；features/src/lib.rs:1362 plugins true | 常规；plugin bundle可以包含 skills/MCP，不是散装tool registry | `plugin` / `core-plugins` / utils/plugins 边界组件 |
| C55 | Apps/connector 工具 | `tui/src/chatwidget/slash_dispatch.rs:545` apps；core/src/tools/spec_plan.rs:159 apps_enabled；features/src/lib.rs:1284 apps true | 条件：连接的账户/服务；Codex backend相关能力不能靠本地代码凭空获得 | 通用 MCP bridge + Trylo账户适配 |
| C56 | 模型可搜索的延迟工具 | `core/src/tools/spec_plan.rs:629` supports_search_tool+namespace；`:245` deferred；`:373` search registration | tool_search旧flag已Removed；是否暴露由模型+provider capability决定 | `tools` discovery/tool_search schema，减少上下文 |
| C57 | 生命周期 Hooks | `features/src/lib.rs:1168` hooks Stable true；`core/src/thread_manager.rs:734` refresh_hook_runtimes；tui/src/chatwidget/slash_dispatch.rs:480 /hooks | 配置了 hooks 才执行；旧 plugin_hooks flag已Removed | `hooks` crate + hook runtime adapter |
| C58 | 缓存/实时网络搜索 | `core/src/tools/spec_plan.rs:613` cached/live/disabled hosted tool；`:1038` standalone gate；`core/src/config/mod.rs:3693` 默认Cached | 条件：provider web_search；默认缓存搜索，live需选择；standalone_web_search UnderDevelopment false（ResponsesLite 另分支） | hosted provider tool adapter 或 `ext/web-search`；没有通用离线搜索 |
| C59 | 生成图片 | `core/src/tools/spec_plan.rs:699` availability；`:714` free plan排除、`:719` provider capability、`:724` modality；app-server/src/extensions.rs:114 install | flag Stable true，但需账户、模型、backend/service；不能计所有provider默认可用 | `ext/image-generation` service adapter；Trylo接自己的provider |
| C60 | memory检索与上下文 | `ext/memories/src/extension.rs:48` memories+use_memories；`:138` dedicated_tools gate；app-server/src/extensions.rs:110 install | memories Stable 默认 false；是可选记忆能力，不能等同于Trylo完整学习闭环 | memory read/context叶子；不替代Learning Board |
| C61 | 持续 Goal/预算与生命周期 | `app-server/src/extensions.rs:85` install Goal；`:93` goals flag；`ext/goal/src/extension.rs:104` persistent state/review exclusion | goals Stable true；token_budget另外UnderDevelopment false；不是“completion即质量通过” | Goal state/accounting，映射Trylo自有任务预算 |
| C62 | 权限方案与用户审批 | `tui/src/chatwidget/slash_dispatch.rs:348` permission popup；`core/src/tools/orchestrator.rs:121` run→`:140` approval | 常规；PermissionProfile、审批策略、shell/patch都接同一执行链 | Trylo PermissionService保留，移植外围决策与UI |
| C63 | OS sandbox 真实执行 | `sandboxing/src/lib.rs:1` Linux、`:7` macOS、`:12` Windows；core/src/tools/orchestrator.rs:121 | 平台能力；是进程/filesystem/network隔离而非只匹配命令文本 | `sandboxing` + exec-server sidecar，窄端口 |
| C64 | Windows沙箱安装/就绪 | app-server-protocol/src/protocol/common.rs:1241 setupStart、`:1246` readiness；app-server/src/message_processor.rs:1674 dispatch | Windows；windows_sandbox_service新flag UnderDevelopment false，不等于所有Windows沙箱都实验 | `windows-sandbox-rs` / readiness/setup adapter |
| C65 | 审批缓存及沙箱拒绝后重试 | `core/src/tools/orchestrator.rs:4` 单一编排说明；`:174` requirement；`core/src/unified_exec/mod.rs:15` 生命周期 | 常规；拒绝、unknown outcome、重试必须遵循授权 | 工具编排合同，不能绕过Trylo PermissionService |
| C66 | 命令执行策略与规则 | `cli/src/main.rs:1791` execpolicy check；`core/src/exec_policy.rs`；`execpolicy/src/lib.rs` | 常规/内部check入口；前缀规则不等于完整sandbox | execpolicy leaf parser/evaluator + Trylo审批事实 |
| C67 | 自动审批复核（guardian） | `features/src/lib.rs:1548` guardian_approval Stable true；`core/src/tools/orchestrator.rs:185` GuardianReviewContext；`tui/src/chatwidget/slash_dispatch.rs:422` AutoReview | 条件：approval reviewer配置；默认reviewer为User（core/src/config/mod.rs:3682）；guardianv2另一flag开发关闭 | guardian adapter，不能将学习系统当授权者 |
| C68 | Provider自定义与本地模型 | `model-provider-info/src/lib.rs:570` builtins OpenAI/Bedrock/Ollama/LMStudio；`:609` merge configured | 常规配置；wire_api只有Responses（`:75`），明确拒绝chat（`:97`） | Responses adapter局部；国模Chat Completions优先旧Trylo |
| C69 | 认证/登录/退出 | `cli/src/main.rs:1588` login、`:1632` logout；`model-provider/src/auth.rs:211` scoped auth | 常规；API key/ChatGPT/device/Bedrock等各自路径 | login/secret storage外围；账户backend能力不假冒 |
| C70 | 模型目录/能力驱动工具 | `core/src/thread_manager.rs:815` models；core/src/tools/spec_plan.rs:1255/:629；tui/src/chatwidget/slash_dispatch.rs:310 model popup | 常规；reasoning/input/tools等按模型目录声明 | 模型capability DTO，避免所有模型暴露同一工具 |
| C71 | 响应重试/连接恢复 | `model-provider-info/src/lib.rs:30` idle timeout、`:35` retry cap；`core/src/client.rs:250` session HTTP fallback；`core/src/responses_retry.rs:44` retry handler | 常规；WebSocket按provider supports_websockets；不是全部provider同一传输 | `codex-api`/client transport局部或成熟provider SDK |
| C72 | headless exec | `cli/src/main.rs:1229` exec→`exec/src/lib.rs:259` run_main、`:820` run_exec_session | 普通命令；headless默认AskForApproval::Never（exec/src/lib.rs:568），不能等待交互审批 | CLI exec事件适配、终态/退出合同 |
| C73 | JSONL machine输出 | `exec/src/lib.rs:842` Json EventProcessor；exec/src/cli.rs --json | 常规；stdout逐条JSONL，human output另processor | `exec/event_processor_with_jsonl_output`映射Trylo Protocol |
| C74 | 结构化最终输出/最后消息文件 | `exec/src/lib.rs:900` output_schema；`:932` last_message/output_schema条件；`exec/src/cli.rs:69` --output-last-message | 常规flag；schema约束与生命周期终态不是质量checker | 复用非交互输出合同和文件writer |
| C75 | exec恢复/fork与review | `exec/src/cli.rs:150` subcommands；`cli/src/main.rs:1245` Review；`exec/src/cli.rs:274` ReviewArgs | 常规；review支持base/commit/uncommitted；不是只让模型“看看代码” | review prompts+target resolver，映射Trylo审查工具 |
| C76 | app-server RPC服务与SDK schema | cli/src/main.rs:1314` AppServer；`:1427` GenerateTs、`:1438` JSONSchema；app-server/src/message_processor.rs:1234/:1570` 真正分派 | CLI命令标Experimental；很多v2 RPC本身稳定并被TUI/exec消费 | app-server协议适配桥，不把RPC事件改成Trylo核心类型 |
| C77 | 命令/文件等外部客户端RPC | `app-server-protocol/src/protocol/common.rs:963` fs/readFile→998 watch；`:1322` command/exec/write/terminate/resize | 常规RPC；process/*是另组Experimental API | `exec-server`/file-system sidecar，UI/Agent共享执行端口 |
| C78 | remote app-server/exec-server | cli/src/main.rs:1449` remote-control、`:1831` ExecServer；core/src/tools/handlers/unified_exec/exec_command.rs:263` remote shell分支 | CLI入口标Experimental；跨OS使用执行端reported shell | 独立exec-server protocol；第二阶段再补远端 |
| C79 | worktree会话 | tui/src/chatwidget/slash_dispatch.rs:253` managed picker；features/src/lib.rs:1244` Worktrees Experimental | 默认false（该feature block）；单独实验追平项 | `worktree`与git-utils，不重造Git工作树 |
| C80 | Cloud任务和diff apply | `cli/src/main.rs:1674` Cloud、`:1801` Apply；subcommand枚举标Cloud Experimental | 条件：Codex Cloud服务/账号；apply是本地patch应用入口 | 通用远端任务provider adapter；不能本地复制云服务 |
| C81 | 多行、粘贴保护、历史与外部编辑器 | `tui/src/bottom_pane/chat_composer.rs:165` paste burst、`:1126` history metadata、`:1214` paste、`:678` editor key | 常规；真实Composer状态机，非普通readline prompt | 若保持TS终端复用旧Trylo；Codex TUI整体是Rust/ratatui |
| C82 | Composer运行中排队与草稿恢复 | tui/src/bottom_pane/chat_composer.rs:382` Queued result、`:459` action；tui/src/chatwidget/input_queue.rs` | 常规输入能力；队列提交与steer不混同 | queue/draft状态机合同、Trylo Repl唯一writer |
| C83 | 动态工具由客户端提供 | `core/src/tools/handlers/dynamic.rs:117` handler；`app-server/src/dynamic_tools.rs:18` boundary；`app-server-protocol/src/protocol/common.rs:1772` 动态tool调用通知 | app-server/client条件；不是全部CLI默认工具 | dynamic DTO/provider tool bridge |
| C84 | code-mode工具编排 | core/src/tools/spec_plan.rs:791` executors，`:893` wait；core/tools/code_mode` | code_mode UnderDevelopment false；code_mode_host Stable true仅宿主，不代表用户mode启用 | 专用code-mode sidecar/工具桥；不是正常底座第一批 |
| C85 | 实时语音 | `tui/src/chatwidget/slash_dispatch.rs:336` toggle；`app-server/src/request_processors/turn_processor.rs:277` real start；`app-server-protocol/src/protocol/common.rs:1046` experimental RPC | voice/model/backend/host能力有条件；旧realtime_conversation flag已Removed false，不能据此宣称功能没有接线 | `voice-host` / realtime provider adapter，条件能力单列 |
| C86 | 安装健康诊断/自动补全/升级 | `cli/src/main.rs:1644` completion、`:1652` update、`:1660` doctor | 普通CLI命令；具体升级方式按发行渠道 | doctor/completion/installer外围，复用旧Trylo渠道 |

## 对新 Trylo 当前缺口的直接复用优先顺序

1. **完整 shell、PTY、后台句柄与输出**：优先复用 `codex-utils-pty` 和 `shell-command` 叶子；以进程 sidecar 接 Trylo ProcessPort。shell 解释器使用现成系统 shell，别把任意管道/重定向重写成现有结构化 steps。可复用 Codex unified-exec 的接口语义与窗口限额；其 manager 直接依赖 Session/StepContext/审批/环境管理，不能摘一个文件即用。
2. **多文件 patch/rename/diff**：直接复用 `apply-patch/src/parser.rs`、更新文件匹配算法、AppliedPatchDelta，再接 Trylo自有写入权限和checkpoint。整个 `codex-apply-patch` 当前 Cargo.toml 依赖 `codex-exec-server`（`:23`），应把纯部分摘出或使用窄sidecar，避免引入完整Codex核心。line endings保留新flag仍开发关闭，不能直接保证所有Windows文本原样。
3. **文件提及/ignore-aware快速检索**：`codex-file-search` 是较窄候选，可直接构建为sidecar或摘 walker/matcher。它只有search结果和callback，不拥有Agent会话，适配成本低。模型读取/grep能力继续复用Trylo已有工具；完整shell会自然提供rg能力。
4. **MCP资源、OAuth、发现与refresh**：复用rmcp客户端及Codex窄传输/资源适配。保留TryloMcpClientPort和工具DTO；不要把McpBinding、插件catalog或Codex tool lifecycle塞进Loop。
5. **SKILL.md与Plugins**：frontmatter parser、skill metadata/selection较窄，直接摘取；加载器通过现有文件读端口接入。插件安装/marketplace采用现成bundle格式和外围manager，仍由Trylo权限服务控制安装。安装了plugin必须连到tool/skill消费，不能只保存manifest。
6. **review/JSONL/fork/steer/压缩**：先复用旧Trylo已有运行时、存储和UI；Codex提供目标解析、prompt、token截断、输入队列和fork snapshot的合同/算法。`thread_manager`、`context_manager`和`Session`是整套协议/状态的所有者，完整拷贝会产生第二个核心。
7. **图片、网络搜索、图像生成、语音**：本地图片处理可以直接复用；hosted search/生成/语音需要服务端能力。新Trylo应在ProviderPort里接其真实服务，不能因为Codex源代码存在就宣称已经有OpenAI账户服务。

## 必须说明的工程耦合

- 新Trylo主体为TypeScript，Codex主体为Rust。直接复用可以是叶子源码摘取、独立Rust二进制/sidecar、现成协议客户端、成熟第三方库或旧Trylo模块，不应默认理解为把整个Codex crate import进TS。
- core/session/thread_manager/unified_exec/tools/orchestrator 共享Codex配置、权限、canonical events、thread-store、模型目录、MCP和extension registry；这些是高耦合模块。成熟行为值得复用，但需要一个薄边界，不要双写会话、恢复、审批或学习状态。
- 本版本provider只支持Responses wire；不能替代旧Trylo的国模Chat Completions/Anthropic多provider底座。两者可同时通过Trylo ProviderPort提供。
- `undo`、`search_tool`、`js_repl`、旧 `tool_search` flags 等为Removed。历史文档或旧版本功能不能计作本地快照默认能力。RPC `thread/revert`的存在也不证明已具备通用磁盘undo；需审其覆盖范围后另立条目。
- memory flag默认关闭，memory read不等于Trylo学习闭环；Goal终态不等于质量验收。补齐基础Agent时不改动Learning Board/Permission Service权责。

## 本次证据边界

本清单覆盖86个生产能力/条件入口，适合形成施工清单；没有以README、crate名、测试名或flag本身推断默认端到端可用。部分细分能力的基线取生产路径与协议入口，后续验收仍需固定制品、真实provider、Windows终端、磁盘变化、进程终态和恢复事实。
