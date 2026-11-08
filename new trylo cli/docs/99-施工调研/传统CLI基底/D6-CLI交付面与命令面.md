# D6 传统 CLI 最小可发货集合（命令面 / TUI / 非交互 / 配置 / 登录 / MCP 管理）

> 范围：`open/01-agent-cli-runtimes/` 下 opencode、codex、goose、gemini-cli、cline、aider、mini-swe-agent 七仓的「交付面」层——用户能敲到什么。
> 本轮所有锚点已逐条抽查；与上一轮不符处在 §附 标「修正」。

## 0. 一页结论

1. **命令面高度收敛**。除 aider/mini 外都有同一副骨架：裸命令进 TUI、`run|exec` 做单发、`auth|login` 管凭据、`config`、`mcp`、`doctor`、`version`、`completion`。这是品类公约数，不是巧合。
2. **单发子命令名字分三派**：`run`（opencode / goose / cline）、`exec`（codex，别名 `e`）、位置参数 `$0 [query..]`（gemini-cli）。aider 与 mini-swe-agent 没有单发子命令，全靠 flag（`--message` / `-t`）。
3. **JSON 输出层是 P0 分水岭**。有：opencode `--format json`、codex `--json`、goose `--output-format text|json|stream-json`、gemini `-o text|json|stream-json`、cline `--json`。无：aider、mini（输出层搜索零命中）。
4. **事件形状已收敛成一条**：首行 init/run_start → 若干 message / tool_use / tool_result → 唯一终态 result（带 usage + finishReason）。三家独立实现同一个形状。
5. **stdin 管道是单发的第二入口**，五家一致（`-` 或直接管道），且 codex/gemini 都显式处理「prompt 与 stdin 同时存在」的冲突。
6. **退出码只有两家做成契约**：gemini `exitCodes.ts`（0/41/42/52/130）、codex `handle_exit_status`（Unix 信号 → `128+signal`）。其余散落 0/1/2。
7. **config 分层都是「打包默认 → 系统/托管 → 用户 → 项目 → 会话 flag」五段式**。codex 把它做成带 precedence 数值的枚举 `ConfigLayerSource`，是教科书形状。
8. **凭据存储差三档**：codex/goose 走系统 keyring（可退明文）；opencode/cline 明文 JSON；aider/mini 外包 `.env`。没有一家把 keyring 当硬依赖。
9. **MCP 管理命令只有三家做了完整 add/list/remove**（codex、gemini、opencode）。goose 用交互向导、cline 用 wizard + `config mcp` 兜底。aider/mini 零 MCP。
10. **Trylo 现状**：`src/cmd/trylo/main.ts` 只有 `run --scenario <name>`，手写 argv；src 全域 grep `commander|yargs|clap|argparse` 零命中；`package.json` 无任何运行时依赖；退出码已有雏形（用法错 `2`）。

## 1. 命令面全清单

### 1.1 opencode（`packages/opencode/src/index.ts:81-103 .command(...)`，`:80 .completion()`）
- **会话类**：`$0 [project]`（`cli/cmd/tui.ts:73`）、`run [message..]`（`run.ts:127`）、`session`（`session.ts:45` → `list:71` / `delete <id>:52`）、`attach`、`export` / `import`、`stats`。
- **配置类**：`providers`（`providers.ts:240` → `list:249` / `login:300` / `logout:492`）、`account`（`account.ts:178 login` / `:208 switch` / `:218 orgs`）、`models`、`agent`。
- **工具扩展类**：`mcp`（`mcp.ts:96`）、`plugin`、`acp`、`serve`、`web`、`github`、`pr`、`console`。
- **诊断类**：`debug`（`debug/index.ts:20` → `wait:42` / `info:50` / `paths:80` / `lsp` / `file`）、`upgrade`、`uninstall`、`db`、`generate`、`completion`。
- **run 关键 flag**：`--format default|json:174`、`--continue:147`、`--session:152`、`--fork:157`、`--share:161`、`--model:165`、`--agent:170`、`--file/-f:180`、`--attach:190`、`--dir:204`、`--port:208`、`--interactive:236`、`--auto:242`、`--yolo:247`、`--dangerously-skip-permissions:252`。

### 1.2 codex（`codex-rs/cli/src/main.rs:147 enum Subcommand`；顶层 `:140 interactive: TuiCli` = 裸命令进 TUI）
- **会话类**：`exec`（别名 `e`）、`review`、`resume`、`fork`、`queue`、`archive` / `unarchive`、`delete`、`agents`（浏览共享 app-server 上的会话）。
- **配置类**：`login`、`logout`、`features`（ inspect feature flags）、`plugin`。
- **工具扩展类**：`mcp`、`app-server`、`exec-server`、`remote-control`、`app`、`cloud`、`sandbox`、`apply`（别名 `a`，把 agent 产出的 diff `git apply` 到工作树）。
- **诊断类**：`doctor`、`debug`、`completion`（`:244 CompletionCommand`）、`update`、`migrate-rollouts`；隐藏内部件 `execpolicy` / `responses-api-proxy` / `stdio-to-uds`。

### 1.3 goose（`crates/goose-cli/src/cli.rs:70 #[command(name="goose", version)]`，`:803 enum Command`）
- **会话类**：无子命令 = 交互会话（文件末尾 telemetry 映射把 `None` 记为 `default_session`）、`run`（`:978`）、`session`（`:511 enum SessionCommand`）、`term`（终端集成会话，一会话一终端）。
- **配置类**：`configure`（向导）、`info --verbose --check`（`:808`）、`local-models`（`:1075`，HF 搜索/下载/列表）。
- **工具扩展类**：`mcp <server>`（`:821`，跑内置 MCP server）、`acp`（`:828`）、`serve`（`:853`，HTTP+WS ACP 端点）、`gateway`（`:1029`，Telegram 等外部平台）、`schedule`（`:1024`）、`recipe`（`:1001`）、`skills`（`:1008`）、`plugin`（`:1015`，从 git URL 装）、`roam`（`:845`，feature gate）。
- **诊断类**：`doctor`（`:821` 之后）、`validate-extensions`、`mcp-probe`、`review`（`:1095`，发现 `.agents/checks/*.md` 子审查者）、`update`（`:1039`）、`completion`（`:1087`）。
### 1.4 gemini-cli（`packages/cli/src/config/config.ts:282 .command('$0 [query..]')`）
- **会话类**：`$0 [query..]` 同时是交互与单发入口（`-p/--prompt:294` 强制非交互、`-i/--prompt-interactive:301` 强制交互）；`--resume:401`、`--continue`。
- **配置类**：无独立 `config` 子命令，改由 settings 文件 + flag：`--model:288`、`--approval-mode:340`（`default|auto_edit|yolo|plan`）、`--yolo:333`、`--include-directories`。
- **工具扩展类**：`mcp:275`、`extensions:276`、`skills:277`、`hooks:278`、`gemma:279`（`:16/:189` 引入）；`--extensions:387`、`--list-extensions:396`。
- **诊断类**：`--version:500`、`-o/--output-format:467`；hidden 回放钩子 `--fake-responses` / `--record-responses`。
- **其它 flag**：`--allowed-mcp-server-names:372`、`--raw-output` + `--accept-raw-output-risk`（后者专门用来压制安全警告）、`--screen-reader`。

### 1.5 cline（`apps/cli/src/main.ts`）
- **会话类**：裸命令 = TUI；`history`（`commands/history-command.ts`）。
- **配置类**：`auth:190`、`config:272`（`commands/config.ts:456 createConfigCommand`，含 `config mcp` 列表视图）。
- **工具扩展类**：`mcp:464`（TTY 走 `runMcpWizard`，非 TTY 打印 "requires a TTY. Use cline config mcp"）、`mcp install:476`、`mcp uninstall:510`、`plugin:285`、`skill:357`、`connect:379`、`hook:563`、`schedule:586`、`hub:600`、`kanban:673`、`install:291` / `uninstall:333`。
- **诊断类**：`doctor:536`（`commands/doctor.ts:824 createDoctorCommand` → `fix:845` / `log:860`）、`dashboard:611`、`update:650`、`version:664`。
- **根 flag**：`commands/program.ts:23 addRootOptions` 挂 `--json:27`；`:123` 对 program 本体调用；`:128 commanderToParsedArgs` 把 commander 解析结果翻译成内部 ParsedArgs。

### 1.6 aider（无子命令，纯 flag + slash）
`aider/args.py` 的 argparse group 就是它的命令面：`Main model:55`、`API Keys and settings:67`、`Model settings:113`、`Cache settings:231`、`Repomap settings:246`、`History Files:270`、`Output settings:303`、`Git settings:403`、`Fixing and committing:526`、`Analytics:567`、`Upgrading:597`、`Modes:637`、`Voice settings:700`、`Other settings:722`、`Deprecated model settings:865`。
**单发**：`--message` / `--message-file`（`main.py:1136`）。**completion**：`--shell-completions <shell>`（`args.py:855` → `main.py:506` 用 shtab 生成）。

### 1.7 mini-swe-agent（typer）
- `run/mini.py:54 @app.command(help=_HELP_TEXT)` 是唯一主命令，flag：`-m/--model`、`--model-class`、`--agent-class`、`--environment-class`、`-t/--task`、`-y/--yolo`、`-l/--cost-limit`、`-c/--config`（可重复，spec 列表）、`-o/--output`（trajectory）、`--exit-immediately`。
- 第二入口 `mini-extra`：`run/utilities/mini_extra.py:13 subcommands` 把 `config` / `inspect|i|inspector` / `swebench` / `swebench-single` / `programbench` 挂成子命令；`config` 自带 `setup:70` / `set:99` / `unset:114` / `edit:123`（`run/utilities/config.py`）。
- 值得抄的一点：`--*-class` 三兄弟把「换 agent / 换环境 / 换 model 实现」暴露成命令行，代价是无类型检查。

## 2. 非交互模式设计

### 2.1 单发参数
| 家 | 单发入口 | 事件流开关 | 终态产物开关 |
|---|---|---|---|
| opencode | `run [message..]` | `--format json`（raw JSON events） | — |
| codex | `exec [PROMPT]` | `--json`（alias `--experimental-json`，`global = true`） | `--output-last-message/-o FILE` |
| goose | `run` + `InputOptions` | `--output-format stream-json` | `--output-format json`（整包） |
| gemini | `$0 [query..]` / `-p` | `-o stream-json` | `-o json`（整包） |
| cline | 位置参数 + `run` | `--json`（根 flag） | 末行 `run_result` |
| aider | `--message` / `--message-file` | 无 | 无 |
| mini | `-t/--task` | 无 | `-o` trajectory |

**旁支**：goose `OutputOptions:297` 有 `-q/--quiet`（只打模型回复，压掉其它输出）——这是「脚本里 `$(goose run -q ...)`」的专用开关，别家没有；codex 用 `-o FILE` 达到同一目的但更干净（不混 stdout）。

### 2.2 事件形状符号
- **opencode**：`run.ts:697 async function loop(client, events)` → `:702 for await (const event of events.stream)`，events 来自 `:834 client.event.subscribe()`；渲染分支判 `:720 event.type === "message.part.updated"`。**订阅的是 server 事件总线，不是进程内回调**——所以 `--attach` 远端和进程内是同一条协议。
- **codex**：`exec/src/exec_events.rs:11 pub enum ThreadEvent`。专门给 `codex exec` 定义的稳定 JSONL 事件枚举，与 TUI 内部事件解耦（`Thread` 粒度命名，便于机器读）。
- **goose**：`session/mod.rs:162 enum StreamEvent` → `:2406 emit_stream_event(&StreamEvent)`；整包 JSON 是 `struct JsonOutput`（定义 `:139`，构造 + `to_string_pretty` 打印在 `:1802`，含 `messages` 与带 `status/cost_usd/input_tokens` 的 `metadata`）。
- **gemini**：`core/src/output/types.ts:30 enum JsonStreamEventType { INIT, MESSAGE, TOOL_USE, TOOL_RESULT, ERROR, RESULT }`，写行由 `core/src/output/stream-json-formatter.ts:18 class StreamJsonFormatter`，主循环在 `cli/src/nonInteractiveCli.ts`（`:119` 判 STREAM_JSON、`:254` 起多处 `streamFormatter.emitEvent({...})`）。**事件类型定义在 core，不在 cli**——TUI/单发/其他表面可共用。
- **cline**：`runtime/run-agent.ts:52 emitJsonLine("stdout", {type:"run_start", providerId, modelId, catalog, thinking, mode, sessionId})` 起手、`:366 {type:"run_result", finishReason, iterations, usage, aggregateUsage?, durationMs, text, model}` 收尾，中间由 `:216 subscribeToAgentEvents(sessionManager, onAgentEvent, …)` 桥接；另有 `run_abort_requested:73`、`team_restored:82` 等旁路事件。
- **公约数**：`init|run_start → message / tool_use / tool_result* → result|run_result`，终态事件必带 usage + finishReason/status。

### 2.3 退出码约定
| 家 | 符号 | 值 |
|---|---|---|
| gemini | `core/src/utils/exitCodes.ts:7 ExitCodes` | 0 SUCCESS / 41 FATAL_AUTHENTICATION_ERROR / 42 FATAL_INPUT_ERROR / 52 FATAL_CONFIG_ERROR / 130 FATAL_CANCELLATION_ERROR |
| codex | `cli/src/exit_status.rs:2`（unix）/ `:15`（windows） | 透传子进程 code；Unix 信号 → `128 + signal`；无 code 兜底 1 |
| cline | `runtime/run-agent.ts:145,259,418` vs `:380,406,423` | 只有 0 / 1 二值 |
| opencode | `index.ts` yargs `.fail(...)`（`:104`） | 用法错误抛给 yargs；其余异常非零 |
| goose | anyhow `Result` → `main.rs` | 出错即 1 |
| aider | 未集中定义 | — |
| **Trylo 现状** | `src/cmd/trylo/main.ts` | 0 成功 / 2 用法与未知 scenario |

**提炼**：0=成功；2=用法/输入错；130=SIGINT（128+2）；认证错与配置错必须与「任务本身失败」区分（gemini 的 41/52 就是为此）。

### 2.4 stdin 管道支持
| 家 | 探测符号 | 行为 |
|---|---|---|
| opencode | `run.ts:416 process.stdin.isTTY ? undefined : await Bun.stdin.text()` | 有管道则拼进 message |
| codex | `exec/src/lib.rs:2218 read_prompt_from_stdin(behavior)`；`:2283` 必需、`:2294` `OptionalAppend` | PROMPT 缺失或为 `-` 时读 stdin；两者都给则 stdin 作为 `<stdin>` 块追加 |
| goose | `cli.rs:214 InputOptions`，`--instructions` 帮助文本明写 "Use - for stdin." | 显式 `-` 走 stdin |
| gemini | `cli/src/gemini.tsx:587 stdinData = await readStdin()`（另 `:815`）；`:459` 若 `--prompt-interactive && !stdin.isTTY` 直接报错 | **互斥校验**，防止两个输入源打架 |
| cline | `main.ts:65 stdinHasPipedInput()`（`:1136` 注释说明它同时查 isTTY）；`:1138` 非 TTY + 有管道 + 非 `--interactive` → 非交互 | fstat + isTTY 双判 |
| aider / mini | 无 | — |

## 3. TUI 架构

- **opencode**：TUI 是**独立于 CLI 的表面**——`run` 与 `tui` 都通过 `OpencodeClient`（进程内 server，或 `--attach` 连远端）订阅 `client.event.subscribe()`（`run.ts:834`）。交互与非交互共用同一条事件协议，`--format json` 只是不渲染。默认命令在 `cli/cmd/tui.ts:73 command: "$0 [project]"`。
- **codex**：`tui/src/slash_command.rs:12 enum SlashCommand`——编译期枚举，TUI 与 exec 共享 core 但**事件类型分开**（exec 用 `ThreadEvent`）。诊断也走 TUI 表面（`doctor` 是 CLI 侧独立实现）。
- **goose**：`session/input.rs:228 fn handle_slash_command(&input) -> Option<InputResult>`（调用点 `:222`，先处理非 slash 输入 `:205`）。行编辑器是 `rustyline::Editor::<GooseCompleter, DefaultHistory>::with_config`（**`session/mod.rs:726`**）。有意思的一点：`commands/doctor.rs:6 handle_doctor` 只是 `build_session(...)` 然后 `session.interactive(Some("/doctor"))`——**goose 的 doctor 本身就是一个 slash 命令**，CLI 子命令只是它的转发壳。
- **gemini-cli**：slash 生态最开放。`packages/cli/src/services/` 下四个 loader 聚合：`BuiltinCommandLoader`、`FileCommandLoader`（用户自定义文件命令）、`McpPromptLoader`（把 MCP prompt 变成 slash）、`SkillCommandLoader`，统一注册进 `CommandService`，重名交给 `SlashCommandResolver` + `SlashCommandConflictHandler`。认证 UI 在 `ui/auth/AuthDialog.tsx`（同目录还有 `ApiAuthDialog` / `AuthInProgress` / `BannedAccountDialog` / `LoginRestartDialog`）。
- **cline**：`apps/cli/src/tui/index.tsx:1` 引入 `createCliRenderer`（`@opentui/core`）+ `createRoot`（`@opentui/react`），`:14` 建 renderer 且 `exitOnCtrlC: false`（自己接管 Ctrl+C），并 `installTuiStdioCapture()`——因为 `--json` 也往 stdout 写，TUI 不能污染它。slash 表在 `tui/commands/slash-command-registry.ts`。
- **aider**：不是 agent TUI 而是 prompt_toolkit REPL。`io.py:15` 引入 `Completer/Completion/ThreadedCompleter`，`:358` 建 `PromptSession`。slash 表由 `commands.py:276 def get_commands(self)` **反射 `cmd_*` 方法名**收集（`:279` 过滤 `attr.startswith("cmd_")`），`do_run:287` 再把 `-` 换成 `_` 动态派发。零注册成本，代价是无类型/无元数据。
- **mini-swe-agent**：无 TUI，rich `Console(highlight=False)` + 逐条确认（`-y` 跳过）。

**共识**：slash command 一律是「名字 → handler」表，且都支持从多个来源聚合；差别只在聚合是**编译期枚举**（codex）、**显式注册表**（cline / gemini）还是**方法名反射**（aider）。

## 4. config 分层与模型配置形状

### 4.1 文件位置 / 优先级 / 加载符号
| 家 | 根目录 | 主文件 | 分层与加载符号 |
|---|---|---|---|
| codex | `CODEX_HOME`（`utils/home-dir/src/lib.rs:14`，注释 `:6`，默认 `~/.codex`；设了必须存在且是目录） | `config.toml` + `auth.json` | `config/src/config_layer_source.rs:6 enum ConfigLayerSource` + `precedence()`：PackagedDefaults(-10) → Mdm(0) → System(10) → EnterpriseManaged(15) → User{profile}(20) → Project(`.codex`) → SessionFlags，另两种 LegacyManagedConfigToml |
| gemini | `~/.gemini` | `settings.json` | `cli/src/config/settings.ts:131 enum SettingScope`；`USER_SETTINGS_PATH:82 = Storage.getGlobalSettingsPath()`；system 路径可被 `GEMINI_CLI_SYSTEM_SETTINGS_PATH:107` 覆盖；`loadSettings:757`（`:877 load(USER_SETTINGS_PATH)`） |
| opencode | XDG（`packages/core/src/global.ts:13 const config = path.join(xdgConfig!, app)`，`:31 export const Path = paths`） | `opencode.json` / `opencode.jsonc` / `config.json` | `config/config.ts:141 const candidates`（`:144` 按序探测，`:147` 兜底第一个）决定同目录内文件优先级；`:43 mergeDeep`（数组走 `mergeConfigConcatArrays` **拼接而非覆盖**）；merge 调用点带 scope 标签：`:407/:413 "global"`、`:416 OPENCODE_CONFIG` flag、`:422/:488 "local"`、`:534` 托管目录 |
| goose | `~/.config/goose`（`config/base.rs:85` 注释） | `config.yaml`（`:34 CONFIG_YAML_NAME`，`:191 user_config_path`） | `:164 GOOSE_ADDITIONAL_CONFIG_FILES` 追加多文件；`:206-210` keyring 开关双来源（env + config）；`GOOSE_PROVIDER` / `GOOSE_MODEL` 直接是 config 里的键（`:578`） |
| cline | `~/.cline/data/settings` | `providers.json` + `cline_mcp_settings.json` | `commands/config.ts:456 createConfigCommand`；`tests/helpers/env.ts:57,63` 显示 provider 设置被刻意拆成独立文件 |
| aider | CWD → git root → home | `.aider.conf.yml` + `.env` | `main.py:464 conf_fname`、`:468` CWD、`:473-475` git root、`:476` homedir（**顺序即优先级**）；`load_dotenv_files:361`；另有 `check_config_files_for_yes:43` 专门拦截误写 `yes:` |
| mini | `MSWEA_GLOBAL_CONFIG_DIR` 或 `user_config_dir("mini-swe-agent")`（`__init__.py:26`），文件 `.env`（`:28 global_config_file`） | — | `run/utilities/config.py` 的 `setup/set/unset/edit` 是唯一写入口；`-c/--config` spec 在命令行叠加，最后 append `run` 覆盖块 |

### 4.2 provider / model 配置形状差异
- **codex**：一张 TOML 三个 map——`config_toml.rs:305 model_providers: HashMap<String, ModelProviderInfo>`、`:340 profiles: HashMap<String, ConfigProfile>`、`:277 mcp_servers: HashMap<String, McpServerConfig>`，加顶层 `:157 model: Option<String>` 与 `:161` provider 引用。内置 provider id 保留（`validate_model_providers:925` 拒绝占用内置名）。**profile =「一组 model 配置的命名快照」，七家独有。**
- **opencode**：**声明与凭据分离**——config 放 provider 声明，凭据在 `auth/index.ts:10 Global.Path.data/auth.json`；`providers.ts:259` 直接读同一个 auth.json 来 `list`。还支持「auth provider command」：`:330 auth: {command: string[]; env: string}` + `:340` 跑外部命令取 token（对接公司内部 SSO 的关键设计）。
- **gemini**：以 `AuthType` 为轴（§5），model 只是 flag，provider 由 auth 类型隐式决定。
- **goose**：**扁平 KV**——`GOOSE_PROVIDER` + `GOOSE_MODEL` 两个参数 + `<PROVIDER>_...` secret；没有 provider 对象数组，切换即改两个键。`config/migrations.rs:145,193` 专门处理这个扁平形状的历史迁移。
- **cline**：`mode` + `providerId` + `modelId` 三元组（直接看 `run_start` 事件字段就是这三元组），provider 配置落 `providers.json`。
- **aider / mini**：aider 用 `--model <provider/model>` 字符串 + API key 环境变量（`args.py:67` group）；mini 只有 `-m` 加 `--model-class`（类名注入）。

## 5. login 与凭据存储

| 家 | 命令 | OAuth 路径 | 落盘 | token 刷新 | 多账号 |
|---|---|---|---|---|---|
| codex | `login` / `logout` | ChatGPT 授权码 + API key 两选一 | `login/src/auth/storage.rs:39 AuthDotJson`（注释即写 "$CODEX_HOME/auth.json"），路径 `:155 codex_home.join("auth.json")`；`:185 try_read_auth_json`；或 keyring | `login/src/auth/manager.rs:383 create_default_auth_client(&refresh_token_endpoint(), ...)`；`refresh_token` 字段存取 `:1576/:1589` | profile + 多 auth 记录（`:75 has_auth_material` 用来判「有没有料」） |
| cline | `auth`（`main.ts:190`） | `loginAndSaveProviderOAuthCredentials`（`commands/auth.ts:7` 引入，`:272`、`:438` 两处调用） | `~/.cline/data/settings/providers.json`（**明文 JSON**，`tests/helpers/env.ts:63`） | 委托各 provider | 否（单活动 profile） |
| opencode | `providers login [url]:300` / `logout [provider]:492`；另有 `account` 组 | 浏览器 + 外部「auth provider command」（`providers.ts:330 auth:{command,env}` → `:340` 跑命令拿 token） | `auth/index.ts:10 Global.Path.data/auth.json`（明文）；MCP OAuth 单独 `mcp/auth.ts:37 mcp-auth.json` | 每次 login 覆盖；`:302` 注释解释 URL login 为何跳过 instance bootstrap（否则会用旧 token 加载远端 config 并崩） | **最完整**：`account.ts:178 login` / `:193 logout` / `:208 switch` / `:218 orgs`，`:121 switchEffect` |
| gemini | 无 CLI 子命令，TUI `ui/auth/AuthDialog.tsx` | `AuthType`（`core/src/core/contentGenerator.ts:63`）= `LOGIN_WITH_GOOGLE` / `USE_GEMINI` / `USE_VERTEX_AI` / `COMPUTE_ADC`；`cli/src/config/auth.ts:10-40 validateAuthMethod` 逐分支校验 env / `loadApiKey()` | ADC / OAuth 凭据文件 | `core/src/code_assist/oauth2.ts:499 client.getToken({code, codeVerifier, redirect_uri})` + `setCredentials`；`getOauthClient:431`；`clearCachedCredentialFile:744` | 否 |
| goose | `configure`（向导内嵌，无独立 login） | 无浏览器流 | **keyring 优先**，`GOOSE_DISABLE_KEYRING` 时退到 `~/.config/goose/secrets.yaml`（`config/base.rs:89-91`；`:206-210` 判开关，`:365 keyring_disabled_in_config` 让 config 里也能关） | 只存静态 key，无 refresh | 否（单 active provider） |
| aider | 无 | 无 | env + `.env`（`main.py:361`） | — | — |
| mini | `mini-extra config setup` | 无 | `global_config_dir/.env`（`__init__.py:28`） | — | — |

**分歧点**：只有 codex 与 goose 真把系统 keyring 当第一选择——`keyring-store/src/lib.rs:54 let entry = Entry::new(service, account)` + `get_password()`，并把 `keyring::Error::NoEntry` 归一化为 `Ok(None)`（`:59`，让「没存过」不是错误）；goose 的 keyring 还是 `#[cfg(feature = "system-keyring")]` 编译期开关。**没有一家把 keyring 当不可降级硬依赖**——这对首发交付是关键判断。

## 6. MCP 管理命令

| 家 | add | list | remove | 其它动词 | 写入落点 | stdio vs remote 参数差异 |
|---|---|---|---|---|---|---|
| codex | `codex mcp add <NAME> (--url <URL> \| -- <COMMAND>...)`（`cli/src/mcp_cmd.rs:66 enum McpSubcommand`） | `list`（自带 `--json`） | `remove` | `get`（也带 `--json`）、`login`、`logout`（MCP 侧 OAuth） | `config_toml.rs:277 mcp_servers`，经 `replace_mcp_servers(&servers)` 整体重写（`mcp_cmd.rs:481`、`:546`） | clap `ArgGroup("transport").args(["command","url"]).required(true).multiple(false)` **硬互斥**；stdio 侧 `AddMcpStdioArgs{ command: Vec<String>, env }`（`trailing_var_arg = true`），http 侧 `AddMcpStreamableHttpArgs`；`McpServerConfig`（`config/src/mcp_types.rs:197`）= `#[serde(flatten)] transport` + `auth` + `environment_id` + `enabled` + `required`（`required: true` 时 `codex exec` 会因该 server 初始化失败而报错） |
| gemini | `mcp add <name> <commandOrUrl> [args...]`（`commands/mcp/add.ts:141`） | `mcp list`（`list.ts:300`） | `mcp remove <name>`（`remove.ts:40`，带 `--scope:50`） | `enable` / `disable`（`enableDisable.ts`）；`commands/mcp.ts:16-30` 用 `defer()` 懒加载五个子命令 + `demandCommand(1)` | `--scope user\|project:160` 决定写用户 settings 还是项目 settings | 位置参数名就叫 `commandOrUrl`（描述 "Command (stdio) or URL (sse, http)"），再用 `--transport stdio\|sse\|http:167` 分流；`--env:174`、`--header:181`、`--timeout:189`、`--trust:193`、`--description:198`、`--include-tools:202` / `--exclude-tools:207` |
| opencode | `mcp add [name]`（`cli/cmd/mcp.ts:430`） | `mcp list`（`:110`、`:307`） | 无 `remove`，改配置文件 | `mcp auth [name]:171`（remote OAuth）、`mcp logout [name]:337` | `:497 resolveConfigPath(Global.Path.config, true)`（`--global`）与 `:510/:511` 项目 worktree + global 双候选；函数定义 `:394` | 非交互时硬校验：`if (!!args.url === !!command.length) throw "Provide either --url <url> or a command after --"`；`--env` 只允许 local、`--header:448` 只允许 remote（`throw "--header is only valid for remote MCP servers"`）；交互态用 `:548 "Run a local command"` / `:552 "Connect to a remote URL"` 选项对；`$497` 之后写回 jsonc |
| goose | 无 `mcp add`。`goose configure` 向导：`commands/configure.rs:145 handle_configure`，`:293` 调 `set_extension(ExtensionEntry{...})`（定义在 `crates/goose/src/config/extensions.rs`） | 向导内列表 | 向导内（`remove_extension` 同文件引入） | `mcp <server>` 是**运行内置 MCP server**，不是管理；`validate-extensions`、`mcp-probe`（`cli.rs:1417` 起，脚本化探针支持 `protocol_version` / `oauth` / `elicitation`） | `config.yaml` 的 `extensions` 段（`config/extensions.rs`） | goose 把 MCP 统一叫 **extension**；`--with-builtin 'developer,github'`（`Acp` / `Serve` 参数，`value_delimiter=','`）是另一条注入路径；`--no-profile:209` 可只挂命令行指定的 extension |
| cline | `cline mcp install <name> …`（`main.ts:464` + `:476`，`.alias("add")`；`commands/mcp.ts:42 buildMcpInstallDefaults` / `:64 installMcpServerDirect`） | `cline config mcp`（非 TTY 的官方兜底路径） | `mcp uninstall`（`main.ts:510`；`commands/mcp.ts:124 uninstallMcpServerDirect`） | 主路径是 `runMcpWizard`（`wizards/mcp/`），`install` 只是「预填字段后打开同一向导」（描述："Open the MCP add wizard with server fields prefilled"，`initialAction: "add"` `commands/mcp.ts:79`） | `cline_mcp_settings.json`（`wizards/mcp/settings.ts`） | 向导驱动，非交互参数面最薄；TTY 检测 `isFullTTY` 决定走向导还是提示 |
| aider | **无** | 无 | 无 | — | — | 证据：`grep -rni "mcp\|model context protocol" aider/*.py` **零命中**（本轮复核） |
| mini | **无** | 无 | 无 | — | — | 证据：仓内 `mcp` 关键词零命中 |

**公约数**：`add` 的入参永远是「name + (command | url)」互斥，stdio 额外 `--env`，remote 额外 `--header`。三家（codex / gemini / opencode）都在**非交互路径上做显式互斥校验**而不是靠 TUI 引导；且都写了 user/project 两级落点（codex 靠 CODEX_HOME + Project 层，gemini 靠 `--scope`，opencode 靠 `--global`）。
**各家特有**：`codex mcp list --json`（机器可读，唯一）；`gemini mcp enable/disable` + `--include-tools/--exclude-tools` + `--trust`；`opencode mcp auth`（把 MCP OAuth 做成一等动词）；`codex McpServerConfig.required`（失败即挂）。

## 7. doctor / 诊断 / 版本 / 迁移

- **codex（最完整的一次）**：`cli/src/doctor.rs` 头部注释即设计说明书——read-mostly：检查当前安装、配置、认证、终端、state 路径与**有界**可达性探测，不尝试修复、不启动长驻服务；每个检查返回 redacted 且可序列化的行，同一份数据同时支撑人类摘要与 `--json` 支持报告；PATH 条目属于不可信数据，可以检查但**不得执行它选中的程序**。迁移：`cli/src/migrate_rollouts.rs:338` 在 dry-run 且仍有可迁移项时打印 "Run `codex migrate-rollouts --apply` to migrate eligible sessions."，并显示 thread 磁盘占用 before → after——**默认 dry-run，显式 `--apply` 才写盘**。
- **cline**：`commands/doctor.ts:824 createDoctorCommand` → `doctor fix:845`（**唯一带修复动作的 doctor**）、`doctor log:860`；`:269` 注释提到清理 "stale sidecars that were launched from older checkouts"，说明它的 doctor 管到进程级残留。
- **goose**：`commands/doctor.rs:6 handle_doctor` 的实现是 `build_session(SessionBuilderConfig{no_session:true, interactive:true})` 后 `session.interactive(Some("/doctor"))`——**doctor 逻辑住在 slash 命令里，CLI 子命令只是转发壳**；另有 `info --check`（"Test provider connection and show status"）与 `validate-extensions`、`mcp-probe` 组成三层递进诊断。
- **opencode**：无 `doctor`，由 `debug` 家族承担（`cli/cmd/debug/index.ts:20 debug` → `info:50` / `paths:80` / `wait:42` / `lsp` / `file search|read|list`）。
- **gemini-cli**：无独立 doctor；诊断能力体现在 hidden 回放钩子 `--fake-responses` / `--record-responses`（`config.ts:473-491`）——**用可重放 fixture 代替现场诊断**，是唯一把「回归可复现」做进命令面的。
- **版本/升级**：`codex update`、`goose update`（`cli.rs:1039`，带 canary flag `:1043-1048`）、`cline update:650` + `version:664`、`opencode upgrade` / `index.ts` yargs `.version()`、`gemini --version:500`（读 package.json）、`aider`（`args.py:597` "Upgrading" group）。
- **aider / mini**：无 doctor。aider 只有启动期自检 `main.py:43 check_config_files_for_yes`（防止把交互回答 `yes` 写进配置文件）；mini 靠 `mini-extra config setup` 的首次检查。

## 8. 首次启动引导（无凭据时行为）

| 家 | 行为 | 证据符号 |
|---|---|---|
| gemini | 启动即校验 auth 方法；`USE_GEMINI` 无 key 时返回**带行动指令的**文案（"Update your environment and try again (no reload needed if using .env)!"），交互态弹 AuthDialog | `cli/src/config/auth.ts:21-30`；`ui/auth/AuthDialog.tsx` |
| codex | 无凭据 → `login` 走浏览器/设备码，成功后写 `auth.json` 或 keyring；`has_auth_material()` 用来识别「文件在但没料」的半损坏态 | `storage.rs:75`、`:155` |
| opencode | `providers login`（无 url 时先进方法选择）；URL login 特意跳过 instance bootstrap，以免用旧 token 加载远端 config 后崩 | `providers.ts:300`、`:302` 注释 |
| goose | 裸命令直接进 configure 式引导；provider 缺失时 `ConfigError::NotFound("GOOSE_PROVIDER")`——错误里带**键名** | `config/base.rs:1213` |
| cline | `cline auth`（TTY 向导）；非 TTY 下 `run-agent` 用 `run_start` 事件把 provider/model 回吐给调用方，失败即 `exitCode = 1` | `main.ts:190`；`run-agent.ts:52`、`:380` |
| aider | 无 key 不崩：按 `API Keys and settings`（`args.py:67`）逐个探测 env / `.env`（`main.py:361`），缺则退化为基础模型并 `tool_warning` | 同左 |
| mini | `configure_if_first_time()` 是主函数**第一行**；缺配置时提示 "You can edit it manually or use the `mini-extra config set` / `config edit` commands" | `run/mini.py:70`；`run/utilities/config.py:36` |

**提炼**：交付级做法是「**错误文案本身就是下一步命令**」——mini（`config.py:36`）、goose（`base.rs:1213` 带键名）、opencode（`mcp.ts:459-472` 每条互斥校验都是一句可执行的纠正说明）、gemini（auth 文案直说下一步）四家都做到了。

## 9. 横切矩阵：六家公约数 vs 各家特有

图例：`Y 符号` = 有；`~` = 变形具备；`N` = 无（附证据/搜索词）。

| 能力 | opencode | codex | goose | gemini | cline | aider | mini |
|---|---|---|---|---|---|---|---|
| 交互 TUI（裸命令） | Y `tui.ts:73 $0` | Y `main.rs:140 TuiCli` | Y 无子命令→`default_session` | Y `config.ts:282 $0` | Y `tui/index.tsx:14` | Y prompt_toolkit `io.py:358` | N 仅确认式循环 |
| 单发子命令 | Y `run.ts:127` | Y `exec`（别名 e） | Y `cli.rs:978 Run` | Y `-p:294` | Y `run` | N（`--message` flag） | N（`-t` flag） |
| JSON / stream-json 输出 | Y `--format:174` | Y `--json:60` | Y `--output-format:308` | Y `-o:467` | Y `--json`（`program.ts:27`） | N（搜 output-format / json 输出层 零命中） | N |
| stdin 管道 | Y `run.ts:416` | Y `lib.rs:2218` | Y `-`（`cli.rs:214`） | Y `gemini.tsx:587` | Y `main.ts:65` | N | N |
| resume / 会话续用 | Y `--continue:147`、`--session:152` | Y `Resume` / `Fork` | Y `cli.rs:368` + `SessionCommand:511` | Y `--resume:401` | Y `commands/history-command.ts` | ~ `History Files:270` | ~ `mini-extra inspect` |
| config 文件分层 | Y `config.ts:141/43` | Y `config_layer_source.rs:6` | Y `base.rs:85/164` | Y `settings.ts:131/757` | Y `config.ts:456` | ~ `main.py:464-476` 顺序即优先级 | ~ `.env`（`__init__.py:26`） |
| login 命令 | Y `providers.ts:300` | Y `Subcommand::Login` | ~ `configure`（`configure.rs:145`） | N 仅 TUI AuthDialog | Y `main.ts:190` | N | Y `config setup:70` |
| OAuth + token 刷新 | Y 外部 auth command `:330/:340` | Y `manager.rs:383` | N 仅静态 key | Y `oauth2.ts:499` | Y `auth.ts:272` | N | N |
| 凭据进 keyring | ~ 明文 `auth.json:10` | Y `keyring-store:54` | Y `base.rs:89-91`（可退明文） | ~ ADC 文件 | ~ 明文 `providers.json` | N | N |
| mcp add | Y `mcp.ts:430` | Y `mcp_cmd.rs:66` | N 走 configure 向导 `:293` | Y `mcp/add.ts:141` | ~ `mcp install:476`（别名 add，仍开向导） | N（搜 `mcp` / `model context protocol` 零命中） | N |
| doctor | ~ `debug/index.ts:20` | Y `doctor.rs:1` | Y `doctor.rs:6` | N（有 `--fake-responses`） | Y `doctor.ts:824` + `fix` | N | N |
| shell completion | Y `index.ts:80` | Y `main.rs:244` | Y `cli.rs:1087` | N（搜 completion 仅 TUI 内部补全） | N（搜 completion script 零命中） | Y `args.py:855` | ~ typer 默认注入，代码未显式声明 |
| slash 命令表 | Y TUI 侧（与 `--attach` 同协议） | Y `slash_command.rs:12` | Y `input.rs:228` | Y 四 loader + `CommandService` | Y `slash-command-registry.ts` | Y 反射 `cmd_*`（`commands.py:276`） | N |

**公约数行（≥5/7 具备）**：交互 TUI、单发、JSON 输出、stdin、config 分层、resume、mcp 增删、slash 表、版本/升级 —— 这九行就是 P0 的合法取材范围。
**各家特有（不能当必备，但值得知道）**：codex `profiles` 命名配置快照、`mcp list --json`、`mcp_server.required`；gemini 四来源 slash 聚合、回放 fixture flag；goose extension 术语、脚本化 `mcp-probe`、`-q/--quiet`；opencode `account switch/orgs` 多账号、`mcp auth` 一等动词、`debug` 家族；cline `doctor fix`、向导即命令、`@opentui` React 渲染器；aider argparse group 即命令面 + 方法名反射；mini `--*-class` 类名注入。

## 10. Trylo P0 命令面清单建议

只从 §9 的公约数行提炼，≤10 条，每条注明抄谁；不含实现设计。

1. **`trylo`（裸命令）= 交互 TUI；`trylo run [message..]` = 单发**，两个入口共用同一事件协议。抄 **opencode**（`tui.ts:73` + `run.ts:127`，二者都订阅 `client.event.subscribe()`）。
2. **`trylo run --format default|json`**，json 即「每行一个事件」。抄 **opencode**（`run.ts:174`），取值域扩到 `text|json|stream-json` 抄 **goose**（`cli.rs:308`）。
3. **事件序列固定**：`run_start → message / tool_use / tool_result* → run_result`，终态必带 `usage` + `finishReason`。抄 **cline**（`run-agent.ts:52` / `:366` 字段形状）+ **gemini**（`types.ts:30` 枚举命名，事件类型定义放在 core 而非 cli）。
4. **stdin 管道**：`trylo run -` 或直接管道；prompt 与 stdin 同时给时按 codex 语义追加为独立块，同时按 gemini 语义拒绝「交互 flag + 管道」组合。抄 **codex**（`lib.rs:2218` / `:2294`）+ **gemini**（`gemini.tsx:459`）。
5. **`trylo run --output-last-message <FILE>`**：终态文本单独落盘，不与 `--json` 抢 stdout。抄 **codex**（`exec/src/cli.rs:69`）。
6. **退出码固化** 0 / 2（用法）/ 41（认证）/ 52（配置）/ 130（取消）。抄 **gemini**（`exitCodes.ts:7`）；`128+signal` 的推导规则抄 **codex**（`exit_status.rs:2`）；保留 Trylo 现有的 `2`。
7. **config 分五段并暴露优先级**：打包默认 → 系统/托管 → 用户 → 项目 → 命令行 flag。抄 **codex**（`config_layer_source.rs:6` + `precedence()` 的 -10/0/10/15/20/25/30）；同目录多文件的探测顺序抄 **opencode**（`config.ts:141 candidates`）；数组字段**合并而非覆盖**抄 **opencode**（`mergeConfigConcatArrays`）。
8. **`trylo login` / `logout` / `status`**，凭据 keyring 优先、可用一个环境变量显式降级为明文文件；多账号 `trylo account switch`。命令形状抄 **codex**（`Subcommand::Login` + `keyring-store:54` + `storage.rs:155`），降级开关抄 **goose**（`GOOSE_DISABLE_KEYRING`，`base.rs:206-210`），多账号抄 **opencode**（`account.ts:208/:218`）。
9. **`trylo mcp add <name>`（`--url` 与 `-- <cmd>` 互斥）/ `list` / `remove` / `enable` / `disable`**：非交互路径必须显式校验 transport 互斥、`--env` 仅 stdio、`--header` 仅 remote；写入支持 user 与 project 两级。互斥建模抄 **codex**（`mcp_cmd.rs` ArgGroup required+multiple(false)），校验文案抄 **opencode**（`mcp.ts:459-472`），`--scope` 与 enable/disable 抄 **gemini**（`add.ts:160`、`enableDisable.ts`）。
10. **`trylo doctor`（只读，每项返回脱敏可序列化行，同时喂人类摘要与 `--json`）+ `trylo completion <shell>` + `trylo version`**。doctor 规格直接抄 **codex**（`doctor.rs:1-12` 注释），completion 参数化抄 **aider**（`--shell-completions bash`，`args.py:855`）。
11. **（加分，非必备）首次无凭据时每条错误文案必须给出下一步可执行命令**。抄 **mini**（`config.py:36`）+ **goose**（`base.rs:1213` 错误里带键名）。

**明确不抄的**：codex `profiles`（Trylo 无多模型集需求）、gemini `--fake-responses`（属测试基建）、goose `-q/--quiet`（与 `--output-last-message` 重复）、mini `--*-class`（无类型检查）、cline 向导即命令（TTY 依赖太重）。

## 附：证据符号索引（本轮抽查修正版）

### A. opencode（根 `open/01-agent-cli-runtimes/opencode/packages/`）
| 主题 | 锚点 | 状态 |
|---|---|---|
| 命令注册 | `opencode/src/index.ts:81-103 .command(...)`；`:80 .completion()` | 正确 |
| 单发 | `opencode/src/cli/cmd/run.ts:127 command:"run [message..]"` | 正确 |
| --format | `run.ts:174 .option("format", choices ["default","json"])`（176 是 choices 行） | **修正** 176→174 |
| stdin | `run.ts:416 process.stdin.isTTY ? undefined : await Bun.stdin.text()` | 正确 |
| 事件循环 | `run.ts:697 async function loop(client, events)` + `:702 for await ... of events.stream` + `:834 client.event.subscribe()` | 正确（补 702/834） |
| 事件类型 | `run.ts:720 "message.part.updated"` | 正确 |
| 合并 | `config/config.ts:43 return mergeDeep(target, source) as Info` | 正确 |
| 文件优先级 | `config.ts:141 const candidates = ["opencode.jsonc","opencode.json","config.json"]` | 正确 |
| 第二处 candidates | 原记 `:272` | **修正**：`candidates` 只在 141/144/147 |
| project 层 | 原记 `:532 project load` | **修正**：local 层 merge 在 `:422` 与 `:488`（scope 标签 `"local"`）；`:530-534` 是 `ConfigManaged.managedConfigDir()` 托管层 |
| XDG | `core/src/global.ts:3 import xdgConfig`、`:13 path.join(xdgConfig!, app)`、`:31 export const Path` | 正确 |
| auth | `opencode/src/auth/index.ts:10 Global.Path.data/auth.json`；`mcp/auth.ts:37 mcp-auth.json` | 正确 |
| mcp | `cli/cmd/mcp.ts:430 add`；`:497 resolveConfigPath(Global.Path.config,true)`（定义 `:394`）；`:569 command: command.split(" ")` | 正确 |
| providers | `cli/cmd/providers.ts:240 / :300 / :492` | 正确 |
| account | `cli/cmd/account.ts:178 login / :208 switch` | 正确 |

### B. codex（根 `open/01-agent-cli-runtimes/codex/codex-rs/`）
| 主题 | 锚点 | 状态 |
|---|---|---|
| 命令面 | `cli/src/main.rs:147 enum Subcommand`；`:244 CompletionCommand`；`:140 interactive: TuiCli` | 正确 |
| exec flag | `exec/src/cli.rs:60 --json`（alias `--experimental-json`）；`:69 --output-last-message/-o` | 正确 |
| 事件 | `exec/src/exec_events.rs:11 pub enum ThreadEvent` | 正确 |
| stdin | `exec/src/lib.rs:2218 read_prompt_from_stdin`，调用点 `:2283`（必需）/`:2294`（OptionalAppend） | 正确 |
| 退出码 | `cli/src/exit_status.rs:2`（unix 分支，`128+signal`）/ `:15`（windows 分支） | **修正** 7→2 |
| 分层 | `config/src/config_layer_source.rs:6 enum ConfigLayerSource`；`precedence()` = -10/0/10/15/20(21)/25/30/40/50 | 正确（补数值） |
| config 形状 | `config/src/config_toml.rs:305 model_providers` / `:340 profiles` / `:277 mcp_servers` / `:157 model` | 正确 |
| HOME | `utils/home-dir/src/lib.rs:14 std::env::var("CODEX_HOME")`（文档注释在 `:6`） | **微调** 代码行是 14 |
| auth | `login/src/auth/storage.rs:39 AuthDotJson 注释` / `:75 has_auth_material` / `:155 codex_home.join("auth.json")` | 正确 |
| 刷新 | `login/src/auth/manager.rs:383 create_default_auth_client(&refresh_token_endpoint(), ...)` | 正确 |
| keyring | `keyring-store/src/lib.rs:54 Entry::new(service, account)`；`:59 NoEntry → Ok(None)` | 正确 |
| mcp | `cli/src/mcp_cmd.rs:66 enum McpSubcommand { List, Get, Add, Remove, Login, Logout }`；`:481`、`:546 replace_mcp_servers` | 正确 |
| mcp 形状 | `config/src/mcp_types.rs:197 pub struct McpServerConfig`（flatten transport + auth + enabled + required） | 新增 |
| doctor | `cli/src/doctor.rs:1-12` 模块文档 | 正确 |
| 迁移 | `cli/src/migrate_rollouts.rs:338` dry-run 提示 | 正确 |
| slash | `tui/src/slash_command.rs:12 pub enum SlashCommand` | **修正** 15→12 |

### C. goose（根 `open/01-agent-cli-runtimes/goose/crates/`）
| 主题 | 锚点 | 状态 |
|---|---|---|
| 命令面 | `goose-cli/src/cli.rs:803 enum Command`；`:70 #[command(name = "goose", author, version, ...)]` | 正确 |
| 全量子命令 | `cli.rs` 末尾 telemetry 映射（`None => "default_session"`）：configure/doctor/info/mcp/acp/roam/serve/session/run/gateway/schedule/update/recipe/skills/plugin/term/local-models/completion/review/validate-extensions/mcp-probe | 新增（最可靠的清单来源） |
| 输入输出 | `cli.rs:297 pub struct OutputOptions`；`:308 long = "output-format"` 取值 text/json/stream-json；`:214 pub struct InputOptions` | 正确 |
| quiet | `cli.rs:298-305 -q/--quiet` | 新增 |
| 事件 | `goose-cli/src/session/mod.rs:162 enum StreamEvent`；`:2406 emit_stream_event` | 正确 |
| 整包 JSON | `session/mod.rs:139 struct JsonOutput`；构造 + `to_string_pretty` 在 `:1802` | **修正** 定义 139，原锚 1803 是构造点 |
| 配置 | `goose/src/config/base.rs:34 CONFIG_YAML_NAME` / `:85 ~/.config/goose/config.yaml` / `:91 secrets.yaml+keyring` / `:164 GOOSE_ADDITIONAL_CONFIG_FILES` / `:578 GOOSE_PROVIDER` | **全部正确** |
| keyring 降级 | `base.rs:206-210 GOOSE_DISABLE_KEYRING` / `:365 keyring_disabled_in_config`；`#[cfg(feature = "system-keyring")]` `:30/:130` | 新增 |
| provider 缺失 | `base.rs:1213 ConfigError::NotFound("GOOSE_PROVIDER")` | 新增 |
| configure | `goose-cli/src/commands/configure.rs:145 handle_configure`；`:293 set_extension(ExtensionEntry{...})` | 正确（`set_extension` 定义在 `goose/src/config/extensions.rs`，`:13` 引入） |
| doctor | `commands/doctor.rs:6 handle_doctor` → `session.interactive(Some("/doctor"))` | 正确（补：内部转发 slash） |
| completion | `cli.rs:1087 Completion { shell: CompletionShell }`；`:1349 enum CompletionShell`（Bash/Elvish/Fish/Powershell/Nu/Zsh） | **修正** 1085→1087 |
| slash | `session/input.rs:228 fn handle_slash_command`（调用点 `:222`） | 正确 |
| 行编辑 | `session/mod.rs:726 rustyline::Editor::<GooseCompleter, DefaultHistory>::with_config` | **修正**：原记 `session/builder.rs:222` 不成立（builder.rs 仅 `:15 use rustyline::EditMode`） |

### D. gemini-cli（根 `open/01-agent-cli-runtimes/gemini-cli/packages/`）
- `cli/src/config/config.ts:282 .command('$0 [query..]')`、`:275-279 mcp/extensions/skills/hooks/gemma` — **正确**。
- `--output-format`：实际 `:467 .option('output-format', alias 'o', choices text/json/stream-json)` — **修正 466→467**；`--version`：`:500 .version(await getVersion())` — **修正 498→500**。
- 非交互：`cli/src/nonInteractiveCli.ts:119` 判 `STREAM_JSON`、`:254` 起多处 `streamFormatter.emitEvent({...})` — 行号正确；但 **`StreamJsonFormatter` 类定义不在本文件**，在 `core/src/output/stream-json-formatter.ts:18` — **修正**。
- `core/src/output/types.ts:30 enum JsonStreamEventType { INIT, MESSAGE, TOOL_USE, TOOL_RESULT, ERROR, RESULT }` — **修正 28→30**。
- `core/src/utils/exitCodes.ts:7 ExitCodes`（0/41/42/52/130）— **正确**。
- `cli/src/gemini.tsx:587 stdinData = await readStdin()`（另一处 `:815`）、`:459` 与 `--prompt-interactive` 互斥报错 — **正确**（文件在 `packages/cli/src/`，非 `src/`）。
- `cli/src/config/settings.ts:82 USER_SETTINGS_PATH` / `:107 GEMINI_CLI_SYSTEM_SETTINGS_PATH` / `:131 enum SettingScope` / `:757 loadSettings` — **正确**。
- `cli/src/config/auth.ts:15-32 AuthType` — **修正**：`export enum AuthType` 在 `core/src/core/contentGenerator.ts:63`；auth.ts `:10-40` 是 `validateAuthMethod` 按 AuthType 分支校验 env。
- `core/src/code_assist/oauth2.ts:499 client.getToken({code, codeVerifier, redirect_uri})` + `setCredentials`；`:431 getOauthClient`；`:744 clearCachedCredentialFile` — **正确**。
- slash：`cli/src/services/` 下除 `BuiltinCommandLoader` / `CommandService` / `SlashCommandResolver` 外还有 `FileCommandLoader` / `McpPromptLoader` / `SkillCommandLoader` / `SlashCommandConflictHandler` — **补全为四 loader**。
- mcp：`cli/src/commands/mcp.ts:16-30` 用 `defer()` 挂 add/remove/list/enable/disable + `demandCommand(1)`；`mcp/add.ts:141`、`list.ts:300`、`remove.ts:40` — **正确**。

### E. cline（根 `open/01-agent-cli-runtimes/cline/apps/cli/src/`）
- `main.ts:190 auth / 272 config / 464 mcp / 536 doctor / 650 update / 664 version` — **正确**；另有 `285 plugin / 291 install / 333 uninstall / 357 skill / 379 connect / 563 hook / 586 schedule / 600 hub / 611 dashboard / 673 kanban` — **补全**。
- `commands/program.ts:23 addRootOptions`、`:27 --json`、`:128 commanderToParsedArgs` — **正确**。
- `runtime/run-agent.ts:52 emitJsonLine("stdout", {type:"run_start", providerId, modelId, catalog, thinking, mode, sessionId})`、`:366 {type:"run_result", finishReason, iterations, usage, aggregateUsage, durationMs, text, model}`、`:216 subscribeToAgentEvents`（来自 `./session-events`）— **正确**。
- `main.ts:65 stdinHasPipedInput()`（`:1136` 注释说明它同时查 isTTY）、`:1138` 非交互判定 — **正确**。
- `commands/config.ts:456 createConfigCommand` — **正确**。
- `commands/auth.ts:7 loginAndSaveProviderOAuthCredentials` — **修正**：`:7` 是 import，调用点在 `:272` 与 `:438`，实现体不在本文件。
- `tests/helpers/env.ts:63 providers.json` — **正确**（`:57` 注释给出完整路径 `~/.cline/data/settings/providers.json`）。
- `wizards/mcp/settings.ts` → `cline_mcp_settings.json` — **正确**（另见 `commands/mcp.test.ts:302`）；`commands/mcp.ts:42 buildMcpInstallDefaults` / `:64 installMcpServerDirect` / `:79 initialAction:"add"` / `:124 uninstallMcpServerDirect` — **补全**。
- `tui/index.tsx:1 createCliRenderer from "@opentui/core"` + `createRoot from "@opentui/react"`，`:14 await createCliRenderer({exitOnCtrlC:false, autoFocus:false, enableMouseMovement:true})` + `installTuiStdioCapture()` — **正确**；`tui/commands/slash-command-registry.ts` — **正确**。
- 退出码：`run-agent.ts` 只有 0（`:145/:259/:418`）与 1（`:380/:406/:423`），无集中定义 — **新增**。

### F. aider / mini-swe-agent / Trylo
- aider `args.py` 分组 `:55 Main model`、`:67 API Keys and settings`、`:597 Upgrading`、`:637 Modes` — **正确**（全 15 组见 §1.6）；`main.py:464-476` conf 优先级、`:361 load_dotenv_files`、`:1136 args.message_file`、`:506 args.shell_completions`（flag 定义在 `args.py:855`，实现在 `:509 shtab.complete`）— **全部正确**；`commands.py:276 get_commands`（`:279` 反射 `cmd_`、`do_run:287` 做 `-`→`_` 派发）、`io.py:15 prompt_toolkit Completer/ThreadedCompleter`（`:358 PromptSession`）— **正确**。
- aider 无 MCP：`grep -rni "mcp\|model context protocol" aider/*.py` → **0 命中**（本轮复核）；无 JSON 输出层：`--output-format` 与 json 输出相关搜索零命中。
- mini `run/mini.py:54 @app.command(help=_HELP_TEXT)`（`:50 app = typer.Typer(rich_markup_mode="rich")`）、`-m/-t/-y/-c/-o` — **正确**，注意 **`-c` 是 `--config`，`-l` 才是 `--cost-limit`**；`run/utilities/config.py:70 setup / :99 set / :114 unset / :123 edit` — **正确**；`run/utilities/mini_extra.py:13 subcommands` — **正确**；`__init__.py:26 global_config_dir`（`:28 global_config_file = .env`）— **正确**；无 MCP。
- Trylo：`src/cmd/trylo/main.ts` 仅 `run --scenario <name>`，手写 argv；`grep -rn "commander\|yargs\|clap\|argparse" src/` → **0 命中**；`package.json` 只有 `typescript` + `@types/node` 两个 devDeps、**无 dependencies**；退出码已有 0（成功）与 2（用法/未知 scenario）雏形。
